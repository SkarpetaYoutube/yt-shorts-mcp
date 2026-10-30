"""Serwer MCP #2: transkrypcje filmów przez Supadata API.

Narzędzia:
  - get_transcript          -> transkrypcja jednego filmu (+ wycinek "hooka" z pierwszych sekund)
  - get_transcript_job      -> dokończenie transkrypcji generowanej przez AI, która nie zdążyła się skończyć
  - get_transcripts_batch   -> transkrypcje wielu filmów po kolei, z opóźnieniami, cache i budżetem czasu
  - get_usage               -> zużycie kredytów dziś

Koszty Supadata: transkrypcja istniejąca (native) = 1 kredyt, generowana przez AI = 2 kredyty / minutę.
Domyślnie używamy mode="native", żeby nie generować niespodziewanych kosztów.

Czas jednego wywołania narzędzia jest ograniczony (ok. 45 s), bo proxy hostingu zrywa połączenia bez danych
po ok. 60 s, a Claude.ai czeka najwyżej 300 s. Dłuższe zadania wracają jako "pending" i są dokańczane osobno.
"""
from __future__ import annotations

import re
import time
from typing import Literal

import httpx
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError

from common import (
    UNTRUSTED_NOTICE,
    BudgetExceeded,
    DailyBudget,
    Throttle,
    cache_get,
    cache_set,
    clip,
    env_float,
    env_int,
    polite_sleep,
    require_env,
)

BASE = "https://api.supadata.ai/v1"
TRANSCRIPT_TTL = 30 * 24 * 3600  # transkrypcje się nie zmieniają -> cache 30 dni
JOB_TTL = 3600  # wyniki zadań Supadata wygasają po godzinie
MAX_BATCH = 25  # limit filmów na jedno wywołanie
DEFAULT_DELAY = env_float("SUPADATA_DELAY_SECONDS", 0.8)
SINGLE_WAIT = env_float("SUPADATA_SINGLE_WAIT_SECONDS", 40)  # ile czekać na zadanie AI w jednym wywołaniu
BATCH_BUDGET = env_float("SUPADATA_BATCH_BUDGET_SECONDS", 40)  # budżet czasu jednej paczki
MAX_HOOK_CHARS = 800
MAX_TOTAL_TEXT = env_int("SUPADATA_MAX_TOTAL_TEXT_CHARS", 80_000)  # limit rozmiaru odpowiedzi paczki (Claude: ~150k znaków)

CREDITS = DailyBudget("supadata_credits", env_int("SUPADATA_DAILY_CREDIT_BUDGET", 300), "UTC",
                      "kredyty Supadata")

mcp = FastMCP(
    "supadata-transcripts",
    mask_error_details=True,  # nieprzewidziane wyjątki nie ujawniają szczegółów; komunikaty ToolError przechodzą
    instructions=(
        "Transkrypcje filmów YouTube (i TikTok/Instagram/X) przez Supadata. Dla wielu filmów "
        "używaj get_transcripts_batch w paczkach do 25 sztuk (gdy zwróci not_processed, wywołaj ponownie z tą listą). "
        "Domyślnie pobiera tylko istniejące napisy (mode=native); mode=auto generuje transkrypcję AI, gdy napisów brak "
        "(kosztuje więcej kredytów)."
    ),
)

_http = httpx.Client(timeout=120)
_throttle = Throttle(env_float("SUPADATA_MIN_INTERVAL_SECONDS", 0.3))  # zabezpieczenie przy równoległych wywołaniach


class SupadataError(ToolError):
    def __init__(self, message: str, status: int = 0, code: str = ""):
        super().__init__(message)
        self.status = status
        self.code = code

    @property
    def fatal(self) -> bool:
        """Błąd, po którym nie ma sensu kontynuować paczki (zły klucz, plan, limit)."""
        return self.status in (401, 402, 429)


# --------------------------------------------------------------------------- HTTP

def _error(resp: httpx.Response) -> SupadataError:
    code, message = "", ""
    try:
        body = resp.json()
        code, message = body.get("error", ""), body.get("message", "") or body.get("details", "")
    except ValueError:
        message = resp.text[:200]
    hints = {
        401: "Nieprawidłowy lub brakujący SUPADATA_API_KEY.",
        402: "Ta funkcja nie jest dostępna w Twoim planie Supadata lub skończyły się kredyty.",
        403: "Film jest niedostępny publicznie (wymaga logowania, prywatny, ograniczony wiekowo lub geoblokada).",
        404: "Film lub zadanie nie istnieje (zadania wygasają po godzinie) albo film jest prywatny.",
        429: "Przekroczony limit zapytań lub kredytów Supadata.",
    }
    text = hints.get(resp.status_code) or f"Błąd Supadata ({resp.status_code})"
    if message:
        text += f" [{code or resp.status_code}: {message}]"
    return SupadataError(text, resp.status_code, code)


def _send(path: str, params: dict | None = None, billable: bool = False) -> httpx.Response:
    """GET do Supadata z ponawianiem (429/5xx) i naliczaniem kredytów. Klucz tylko w nagłówku."""
    headers = {"x-api-key": require_env("SUPADATA_API_KEY")}
    last: httpx.Response | None = None
    for attempt in range(4):
        if billable:
            CREDITS.check(1)
        _throttle.wait()
        try:
            resp = _http.get(f"{BASE}{path}", params=params, headers=headers)
        except httpx.HTTPError as exc:
            if attempt == 3:
                raise SupadataError(f"Błąd połączenia z Supadata ({type(exc).__name__}).") from exc
            time.sleep(2 * (attempt + 1))
            continue
        if billable and resp.status_code < 400:
            try:
                CREDITS.add(float(resp.headers.get("x-billable-requests", 1)))
            except ValueError:
                CREDITS.add(1)
        if resp.status_code == 429 or resp.status_code >= 500:
            last = resp
            wait = resp.headers.get("retry-after", "")
            time.sleep(min(float(wait), 20) if wait.replace(".", "", 1).isdigit() else 2 * (attempt + 1))
            continue
        return resp
    assert last is not None
    raise _error(last)


def _poll(job_id: str, max_wait: float) -> dict | None:
    """Czeka na zadanie asynchroniczne. Zwraca wynik albo None, gdy nie skończyło się w max_wait sekund."""
    deadline = time.monotonic() + max_wait
    while True:
        resp = _send(f"/transcript/{job_id}")
        if resp.status_code != 200:
            raise _error(resp)
        body = resp.json()
        status = body.get("status")
        if status == "completed":
            return body.get("result", body)
        if status == "failed":
            raise SupadataError(f"Supadata nie zdołało wygenerować transkrypcji: {body.get('error')}")
        if time.monotonic() + 1 >= deadline:
            return None
        time.sleep(1)  # zalecany interwał z dokumentacji


# ------------------------------------------------------------------------ helpers

YT_ID_RE = re.compile(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([A-Za-z0-9_-]{11})")


def _normalize_url(ref: str) -> tuple[str, str | None]:
    """Zwraca (url do API, video_id lub None dla nie-YouTube)."""
    ref = ref.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", ref):
        return f"https://www.youtube.com/watch?v={ref}", ref
    if ref.startswith("http"):
        m = YT_ID_RE.search(ref)
        if m and ("youtube.com" in ref or "youtu.be" in ref):
            return f"https://www.youtube.com/watch?v={m.group(1)}", m.group(1)
        return ref, None
    raise ToolError(f"Nie rozpoznaję filmu: {ref!r} (podaj link lub 11-znakowe ID YouTube).")


def _key(url: str, lang: str | None, mode: str) -> dict:
    return {"url": url, "lang": lang, "mode": mode}


def _fetch(url: str, lang: str | None, mode: str, max_wait: float) -> dict:
    """Zwraca {"raw": ...} | {"job_id": ...} | {"unavailable": True}."""
    params = {"url": url, "text": "false", "mode": mode}
    if lang:
        params["lang"] = lang
    resp = _send("/transcript", params, billable=True)
    if resp.status_code == 200:
        return {"raw": resp.json()}
    if resp.status_code == 202:
        job_id = resp.json()["jobId"]
        cache_set("supadata_jobs", {"job": job_id}, _key(url, lang, mode))
        raw = _poll(job_id, max_wait) if max_wait > 0 else None
        return {"raw": raw} if raw is not None else {"job_id": job_id}
    if resp.status_code == 206:
        return {"unavailable": True}
    raise _error(resp)


def _shape(raw: dict, ref: str, video_id: str | None, hook_seconds: int,
           include_full_text: bool, include_segments: bool, max_text_chars: int) -> dict:
    content = raw.get("content")
    segments = content if isinstance(content, list) else None
    if segments is not None:
        text = " ".join(s.get("text", "").strip() for s in segments if s.get("text")).strip()
        hook = " ".join(
            s.get("text", "").strip() for s in segments if (s.get("offset") or 0) < hook_seconds * 1000
        ).strip()
        hook = clip(hook, MAX_HOOK_CHARS)[0]  # zabezpieczenie: jeden ogromny segment nie może rozdąć odpowiedzi
        end_ms = max(((s.get("offset") or 0) + (s.get("duration") or 0) for s in segments), default=0)
    else:
        text, hook, end_ms = (content or ""), None, 0
    out = {
        "ok": True,
        "video": video_id or ref,
        "lang": raw.get("lang"),
        "available_langs": raw.get("availableLangs"),
        "word_count": len(text.split()),
        "approx_duration_seconds": round(end_ms / 1000) if end_ms else None,
        "hook_seconds": hook_seconds,
        "hook_text": hook,
    }
    if not text:
        out["note"] = "Transkrypcja pusta (brak wykrytej mowy)."
    if include_full_text:
        out["text"], out["text_truncated"] = clip(text, max_text_chars)
    if include_segments and segments is not None:
        out["segments"] = segments[:400]
    return out


def _get(ref: str, lang: str | None, mode: str, hook_seconds: int, include_full_text: bool,
         include_segments: bool, max_text_chars: int, max_wait: float) -> tuple[dict, bool]:
    """Zwraca (wynik, czy_z_cache). Wynik może mieć ok=False z błędem lub pending=True z job_id."""
    url, vid = _normalize_url(ref)
    key = _key(url, lang, mode)
    raw = cache_get("supadata", key, TRANSCRIPT_TTL)
    cached = raw is not None
    if raw is None:
        got = _fetch(url, lang, mode, max_wait)
        if got.get("unavailable"):
            return {
                "ok": False,
                "video": vid or ref,
                "error": "Brak dostępnej transkrypcji (HTTP 206). Spróbuj mode=\"auto\", aby wygenerować ją przez AI "
                         "(2 kredyty za minutę filmu).",
            }, False
        if "job_id" in got:
            return {
                "ok": False,
                "pending": True,
                "video": vid or ref,
                "job_id": got["job_id"],
                "note": "Transkrypcja jest jeszcze generowana. Wywołaj get_transcript_job z tym job_id za chwilę "
                        "(wynik jest dostępny przez godzinę).",
            }, False
        raw = got["raw"]
        cache_set("supadata", key, raw)
    return _shape(raw, ref, vid, hook_seconds, include_full_text, include_segments, max_text_chars), cached


# --------------------------------------------------- niskopoziomowe (dla collect.py: pełny tekst)

def fetch_raw(ref: str, lang: str | None, mode: str, max_wait: float):
    """Zwraca ("ok", raw, z_cache) | ("unavailable", None, False) | ("pending", job_id, False). Bez przycinania."""
    url, _ = _normalize_url(ref)
    key = _key(url, lang, mode)
    raw = cache_get("supadata", key, TRANSCRIPT_TTL)
    if raw is not None:
        return "ok", raw, True
    got = _fetch(url, lang, mode, max_wait)
    if got.get("unavailable"):
        return "unavailable", None, False
    if "job_id" in got:
        return "pending", got["job_id"], False
    cache_set("supadata", key, got["raw"])
    return "ok", got["raw"], False


def poll_job(job_id: str, max_wait: float):
    """Zwraca raw albo None, gdy zadanie nadal trwa."""
    meta = cache_get("supadata_jobs", {"job": job_id}, JOB_TTL)
    raw = _poll(job_id, max_wait)
    if raw is not None and meta:
        cache_set("supadata", meta, raw)
    return raw


def raw_to_text(raw: dict) -> str:
    """Pełny tekst z segmentów, złączonych pojedynczą spacją. Niczego nie skraca ani nie zmienia w treści segmentów."""
    content = raw.get("content")
    if isinstance(content, list):
        return " ".join(s.get("text", "").strip() for s in content if s.get("text") and s.get("text").strip())
    return content or ""


# ------------------------------------------------------------------------- tools

@mcp.tool
def get_transcript(
    video: str,
    lang: str | None = None,
    mode: Literal["native", "auto", "generate"] = "native",
    hook_seconds: int = 30,
    include_segments: bool = False,
    max_text_chars: int = 12000,
) -> dict:
    """Pobiera transkrypcję jednego filmu (YouTube; działa też dla TikTok, Instagram, X).

    Args:
        video: link do filmu/shorta albo 11-znakowe ID.
        lang: preferowany język (ISO 639-1, np. "pl"). Domyślnie pierwszy dostępny.
        mode: "native" = tylko istniejące napisy (1 kredyt), "auto" = natywne, a gdy brak — AI
              (2 kredyty / min), "generate" = zawsze AI.
        hook_seconds: długość "hooka" (pierwsze N sekund) zwracanego osobno w polu hook_text.
        include_segments: dołącz segmenty z czasami (dużo tokenów).
        max_text_chars: przytnij pełny tekst do tylu znaków (ochrona przed zbyt dużą odpowiedzią).
    """
    result, _ = _get(video, lang, mode, max(hook_seconds, 0), True, include_segments, max_text_chars, SINGLE_WAIT)
    return result | {"notice": UNTRUSTED_NOTICE, "credits_used_today": CREDITS.used()}


@mcp.tool
def get_transcript_job(job_id: str, hook_seconds: int = 30, max_text_chars: int = 12000) -> dict:
    """Dokańcza transkrypcję, która wcześniej zwróciła pending=True (generowanie AI długiego filmu).

    Args:
        job_id: identyfikator zadania z odpowiedzi get_transcript/get_transcripts_batch.
        hook_seconds: długość hooka w sekundach.
        max_text_chars: przytnij pełny tekst do tylu znaków.
    """
    meta = cache_get("supadata_jobs", {"job": job_id}, JOB_TTL)
    raw = _poll(job_id, SINGLE_WAIT)
    if raw is None:
        return {"ok": False, "pending": True, "job_id": job_id, "note": "Nadal w trakcie. Spróbuj ponownie za chwilę."}
    ref = meta["url"] if meta else job_id
    if meta:
        cache_set("supadata", meta, raw)
    _, vid = _normalize_url(ref) if meta else (None, None)
    return _shape(raw, ref, vid, max(hook_seconds, 0), True, False, max_text_chars) | {"notice": UNTRUSTED_NOTICE}


@mcp.tool
def get_transcripts_batch(
    videos: list[str],
    lang: str | None = None,
    mode: Literal["native", "auto", "generate"] = "native",
    hook_seconds: int = 30,
    include_full_text: bool = True,
    max_text_chars: int = 6000,
    delay_seconds: float | None = None,
) -> dict:
    """Pobiera transkrypcje wielu filmów po kolei, z opóźnieniami między zapytaniami (żeby nie dostać blokady).

    Maksymalnie 25 filmów na wywołanie i ok. 40 s czasu. Jeśli czas lub rozmiar odpowiedzi się skończy,
    reszta wraca w polu `not_processed` — wywołaj narzędzie ponownie z tą listą (pobrane filmy są w cache,
    więc nic nie kosztują). Błąd jednego filmu nie przerywa paczki.

    Args:
        videos: lista linków lub ID filmów.
        lang: preferowany język (ISO 639-1).
        mode: "native" / "auto" / "generate" (patrz get_transcript).
        hook_seconds: długość hooka w sekundach (pole hook_text).
        include_full_text: False = tylko hooki i statystyki (mało tokenów).
        max_text_chars: przytnij tekst każdego filmu do tylu znaków.
        delay_seconds: przerwa między zapytaniami do API (domyślnie ok. 0,8 s).
    """
    refs = list(dict.fromkeys(v.strip() for v in videos if v and v.strip()))
    if not refs:
        raise ToolError("Podaj co najmniej jeden film.")
    if len(refs) > MAX_BATCH:
        raise ToolError(f"Maksymalnie {MAX_BATCH} filmów na wywołanie — podziel listę na paczki.")
    delay = DEFAULT_DELAY if delay_seconds is None else max(delay_seconds, 0)
    hook_seconds = max(hook_seconds, 0)

    started = time.monotonic()
    results: list[dict] = []
    not_processed: list[str] = []
    stop_reason: str | None = None
    network_calls = 0
    text_chars = 0

    for idx, ref in enumerate(refs):
        if stop_reason:
            not_processed.append(ref)
            continue
        try:
            url, _ = _normalize_url(ref)
        except ToolError as exc:
            results.append({"ok": False, "video": ref, "error": str(exc)})
            continue
        is_cached = cache_get("supadata", _key(url, lang, mode), TRANSCRIPT_TTL) is not None
        if not is_cached:
            if time.monotonic() - started > BATCH_BUDGET:
                stop_reason = "Budżet czasu jednego wywołania wyczerpany."
                not_processed.append(ref)
                continue
            if network_calls:
                polite_sleep(delay)
        want_text = include_full_text and text_chars < MAX_TOTAL_TEXT
        remaining_wait = max(min(BATCH_BUDGET - (time.monotonic() - started), 15), 0)
        try:
            res, cached = _get(ref, lang, mode, hook_seconds, want_text, False, max_text_chars, remaining_wait)
        except BudgetExceeded as exc:
            stop_reason = str(exc)
            not_processed.append(ref)
            continue
        except SupadataError as exc:
            network_calls += 1
            results.append({"ok": False, "video": ref, "error": str(exc)})
            if exc.fatal:
                stop_reason = f"Przerwano paczkę: {exc}"
            continue
        except ToolError as exc:
            results.append({"ok": False, "video": ref, "error": str(exc)})
            continue
        if not cached:
            network_calls += 1
        if include_full_text and not want_text:
            res["text_omitted"] = "Pominięto pełny tekst (limit rozmiaru odpowiedzi); hook jest dostępny."
        text_chars += len(res.get("text", ""))
        results.append(res)

    done = sum(1 for r in results if r.get("ok"))
    out = {
        "requested": len(refs),
        "succeeded": done,
        "failed": sum(1 for r in results if not r.get("ok") and not r.get("pending")),
        "pending": sum(1 for r in results if r.get("pending")),
        "results": results,
        "credits_used_today": CREDITS.used(),
        "notice": UNTRUSTED_NOTICE,
    }
    if stop_reason or not_processed:
        out["stopped"] = stop_reason
        out["not_processed"] = not_processed
        out["hint"] = "Wywołaj get_transcripts_batch ponownie z listą not_processed (gotowe filmy są w cache)."
    return out


@mcp.tool
def get_usage() -> dict:
    """Pokazuje kredyty Supadata zużyte dziś przez ten serwer (liczone z nagłówków odpowiedzi; cache nie liczy się)."""
    return {"credits_used_today": CREDITS.used(), "daily_safety_limit": CREDITS.limit}


if __name__ == "__main__":
    mcp.run()
