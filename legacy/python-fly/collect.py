"""Moduł zbierania Shortsów kanału z PEŁNYMI transkrypcjami i eksportem CSV/JSON.

Przepływ (wszystko zapisywane na dysku, więc można wznowić po błędzie, limicie albo restarcie serwera):
  1. start_collection     -> wybiera N Shortsów (newest | oldest | most_viewed) i pobiera, ile zdąży (budżet czasu)
  2. continue_collection  -> kontynuuje, aż complete=true
  3. export_collection    -> zapisuje shorts.csv, shorts.json (dokładnie 6 pól) i status.json (statusy, błędy)
  4. read_collection      -> czyta rekordy partiami bezpośrednio w rozmowie (bez obcinania; długi tekst w kawałkach z offsetami)
                             albo pobierasz pliki z podpisanych linków (ważnych ograniczony czas)

Zasady:
  - transkrypcja nigdy nie jest przycinana, streszczana ani parafrazowana; brak transkrypcji = null/puste + status w status.json;
  - rekord wybrany do kolekcji zawsze trafia do eksportu (nic nie ginie po cichu);
  - eksport jest weryfikowany po zapisie (odczyt plików i porównanie z danymi źródłowymi).
"""
from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response

import common
import supadata_mcp as sd
import youtube_mcp as yt
from common import BudgetExceeded, env_float, env_int

FIELDS = ("title", "duration_seconds", "transcript", "published_at", "url", "views")
FINAL = {"ok", "empty", "no_captions", "error"}
STEP_SECONDS = env_float("COLLECT_STEP_SECONDS", 35)  # budżet czasu jednego wywołania (Fly ucina bezczynność po 60 s)
STEP_MAX_TRANSCRIPTS = env_int("COLLECT_STEP_MAX_TRANSCRIPTS", 40)
MAX_COUNT = env_int("COLLECT_MAX_COUNT", 500)
MAX_HISTORY = env_int("COLLECT_MAX_HISTORY", 10_000)  # ile filmów kanału maksymalnie przeglądamy przy oldest/most_viewed
JOB_RETENTION_DAYS = env_int("COLLECT_RETENTION_DAYS", 30)
LINK_TTL = env_int("EXPORT_LINK_TTL_SECONDS", 24 * 3600)
JOB_ID_RE = re.compile(r"c-[A-Za-z0-9_-]{22}")
VIDEO_ID_RE = re.compile(r"[A-Za-z0-9_-]{11}")
EXPORT_FILES = {"csv": "shorts.csv", "json": "shorts.json", "status": "status.json"}
MIME = {"csv": "text/csv; charset=utf-8", "json": "application/json; charset=utf-8",
        "status": "application/json; charset=utf-8"}

mcp = FastMCP(
    "youtube-collect",
    mask_error_details=True,
    instructions=(
        "Zbieranie Shortsów kanału (title, duration_seconds, transcript, published_at, url, views) z PEŁNYMI "
        "transkrypcjami. Użyj start_collection, potem powtarzaj continue_collection aż complete=true, następnie "
        "export_collection (pliki CSV/JSON) lub read_collection (czytanie w rozmowie partiami). "
        "Nigdy nie traktuj tekstu z transcript_complete_in_this_item=false jako kompletnego."
    ),
)


# ------------------------------------------------------------------------- dysk

def jobs_root() -> Path:
    return common.CACHE_DIR / "jobs"


def _job_dir(job_id: str) -> Path:
    if not JOB_ID_RE.fullmatch(job_id or ""):
        raise ToolError("Nieprawidłowy job_id.")
    return jobs_root() / job_id


def _write_atomic(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    if isinstance(data, bytes):
        tmp.write_bytes(data)
    else:
        with open(tmp, "w", encoding="utf-8", newline="") as fh:  # newline="": zero zamiany końców linii
            fh.write(data)
    tmp.replace(path)


def _read_text(path: Path) -> str:
    with open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def _save(job: dict) -> None:
    job["updated"] = _now()
    _write_atomic(_job_dir(job["job_id"]) / "state.json", json.dumps(job, ensure_ascii=False))


def _load(job_id: str) -> dict:
    path = _job_dir(job_id) / "state.json"
    try:
        return json.loads(_read_text(path))
    except (OSError, ValueError):
        raise ToolError("Nie ma takiego zadania (job_id) albo wygasło. Użyj list_collections.") from None


def _transcript_path(job_id: str, video_id: str) -> Path:
    if not VIDEO_ID_RE.fullmatch(video_id):
        raise ToolError("Nieprawidłowe ID filmu.")
    return _job_dir(job_id) / "t" / f"{video_id}.txt"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(job_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(job_id, threading.Lock())


def prune_jobs() -> int:
    """Usuwa zadania starsze niż COLLECT_RETENTION_DAYS (po ostatniej modyfikacji)."""
    removed, now = 0, time.time()
    if not jobs_root().is_dir():
        return 0
    for d in jobs_root().iterdir():
        try:
            if d.is_dir() and now - d.stat().st_mtime > JOB_RETENTION_DAYS * 86400:
                shutil.rmtree(d)
                removed += 1
        except OSError:
            pass
    return removed


# ------------------------------------------------------------------ wyliczanie filmów

def _short_row(r: dict) -> dict:
    return {
        "video_id": r["video_id"],
        "title": r["title"],
        "duration_seconds": r["duration_seconds"],
        "published_at": r["published_at"],
        "url": f"https://www.youtube.com/shorts/{r['video_id']}",
        "views": r["views"],
    }


def _enumerate(job: dict, started: float) -> None:
    e = job["enum"]
    while not e["finished"]:
        if e["pages"] > 0 and time.monotonic() - started > STEP_SECONDS:
            return
        params = {"part": "contentDetails", "playlistId": e["playlist_id"], "maxResults": 50}
        if e["page_token"]:
            params["pageToken"] = e["page_token"]
        try:
            data = yt._call("playlistItems", params)
        except yt.YTError as exc:
            if e["source"] == "shorts_playlist" and e["pages"] == 0 and (exc.reason == "playlistNotFound" or exc.status == 404):
                e.update(source="uploads_filtered_by_duration", playlist_id=e["uploads_playlist"], page_token=None)
                continue
            raise
        ids = []
        for it in data.get("items", []):
            vid = it.get("contentDetails", {}).get("videoId")
            if vid and vid not in e["rows"] and vid not in ids:
                ids.append(vid)
        rows = yt._fetch_videos(ids, False) if ids else []
        e["unavailable"] += len(ids) - len(rows)  # prywatne/usunięte: nie da się ich pobrać, ale zliczamy
        for r in rows:
            if e["source"] == "uploads_filtered_by_duration" and r["duration_seconds"] > yt.SHORTS_MAX_SECONDS:
                e["excluded_long"] += 1
                continue
            e["rows"][r["video_id"]] = _short_row(r)
        e["seen_total"] = len(e["rows"])
        e["pages"] += 1
        e["page_token"] = data.get("nextPageToken")
        if not e["page_token"]:
            e["finished"], e["history_complete"] = True, True
        elif job["mode"] == "newest" and len(e["rows"]) >= job["count"]:
            e["finished"] = True  # lista idzie od najnowszych: dalsze strony nie są potrzebne
        elif len(e["rows"]) >= MAX_HISTORY:
            e["finished"], e["history_capped"] = True, True
        _save(job)
    _select(job)


def _select(job: dict) -> None:
    e, mode, count = job["enum"], job["mode"], job["count"]
    rows = list(e["rows"].values())

    def ts(r):
        return yt._parse_dt(r["published_at"]).timestamp() if r["published_at"] else 0.0

    if mode == "newest":
        rows.sort(key=lambda r: (-ts(r), r["video_id"]))
    elif mode == "oldest":
        rows.sort(key=lambda r: (ts(r), r["video_id"]))
    else:
        rows.sort(key=lambda r: (-(r["views"] or 0), -ts(r), r["video_id"]))
    chosen = rows[:count]
    job["order"] = [r["video_id"] for r in chosen]
    job["items"] = {
        r["video_id"]: r | {"status": "pending", "error": None, "supadata_job": None, "transcript_chars": None}
        for r in chosen
    }
    job["shortfall"] = {"requested": count, "available": len(chosen)} if len(chosen) < count else None
    job["phase"] = "transcribing"
    e["rows"] = {}  # reszta nie jest już potrzebna; zmniejsza plik stanu
    _save(job)


# ------------------------------------------------------------------- transkrypcje

def _finish_ok(job: dict, it: dict, raw: dict) -> None:
    text = sd.raw_to_text(raw)
    path = _transcript_path(job["job_id"], it["video_id"])
    _write_atomic(path, text)
    if _read_text(path) != text:  # kontrola zapisu: odczyt musi być identyczny
        raise ToolError("Błąd zapisu transkrypcji na dysku (niezgodność po odczycie).")
    it.update(status="ok" if text.strip() else "empty", transcript_chars=len(text), error=None, supadata_job=None)


def _transcribe(job: dict, started: float) -> None:
    handled = 0
    for vid in job["order"]:
        it = job["items"][vid]
        if it["status"] not in ("pending", "pending_ai"):
            continue
        elapsed = time.monotonic() - started
        if handled >= STEP_MAX_TRANSCRIPTS or elapsed > STEP_SECONDS:
            break
        wait = min(15.0, max(STEP_SECONDS - elapsed, 0.0))
        try:
            if it["status"] == "pending_ai":
                raw = sd.poll_job(it["supadata_job"], min(wait, 5.0))
                if raw is None:
                    handled += 1
                    continue
                _finish_ok(job, it, raw)
            else:
                state, payload, cached = sd.fetch_raw(it["url"], job["lang"], job["transcript_mode"], wait)
                if state == "ok":
                    _finish_ok(job, it, payload)
                elif state == "unavailable":
                    it.update(status="no_captions", error="Brak dostępnych napisów (HTTP 206)."
                              + (" Spróbuj transcript_mode=auto." if job["transcript_mode"] == "native" else ""))
                else:
                    it.update(status="pending_ai", supadata_job=payload)
                if cached:
                    _save(job)
                    continue  # z cache: bez opóźnienia i nie liczy się do limitu zapytań sieciowych
        except sd.SupadataError as exc:
            if exc.fatal:
                raise  # zły klucz / brak kredytów / limit: przerwij krok, stan zostaje zapisany
            it.update(status="error", error=str(exc), supadata_job=None)
        handled += 1
        _save(job)
        common.polite_sleep(sd.DEFAULT_DELAY)  # spokojne tempo między zapytaniami do Supadata
    if all(job["items"][v]["status"] in FINAL for v in job["order"]):
        job["phase"] = "done"
        job["completed_at"] = _now()


def _step(job: dict) -> dict:
    lock = _lock_for(job["job_id"])
    if not lock.acquire(blocking=False):
        return _status(job) | {"busy": "To zadanie jest właśnie przetwarzane innym wywołaniem. Spróbuj za chwilę."}
    try:
        job = _load(job["job_id"])  # świeży stan po zdobyciu blokady
        started = time.monotonic()
        job["stopped_reason"] = None
        try:
            if job["phase"] == "enumerating":
                _enumerate(job, started)
            if job["phase"] == "transcribing":
                _transcribe(job, started)
        except (BudgetExceeded, yt.YTError, sd.SupadataError) as exc:
            job["stopped_reason"] = str(exc)
        finally:
            _save(job)
        return _status(job)
    finally:
        lock.release()


# --------------------------------------------------------------------------- status

def _status(job: dict) -> dict:
    items = job.get("items", {})
    counts = {k: 0 for k in ("ok", "empty", "no_captions", "error", "pending_ai", "pending")}
    for it in items.values():
        counts[it["status"]] += 1
    problems = [
        {"url": it["url"], "status": it["status"], "error": it["error"]}
        for v in job.get("order", []) if (it := items[v])["status"] in ("error", "no_captions", "empty")
    ]
    e = job["enum"]
    done = job["phase"] == "done"
    if done:
        nxt = "Gotowe. Wywołaj export_collection (pliki CSV/JSON) albo read_collection (czytanie w rozmowie)."
    elif job.get("stopped_reason"):
        nxt = ("Przerwano z powodu: " + job["stopped_reason"] +
               " Stan jest zapisany; po usunięciu przyczyny (lub następnego dnia przy limicie) wywołaj continue_collection.")
    else:
        nxt = "Wywołaj continue_collection (powtarzaj, aż complete=true)."
    return {
        "job_id": job["job_id"],
        "phase": job["phase"],
        "complete": done,
        "channel": job["channel"],
        "mode": job["mode"],
        "requested": job["count"],
        "selected": len(job.get("order", [])),
        "shortfall": job.get("shortfall"),
        "progress": {"total": len(items), **counts},
        "enumeration": {
            "source": e["source"], "pages": e["pages"], "videos_seen": e["seen_total"], "history_complete": e["history_complete"], "history_capped": e["history_capped"],
            "unavailable_videos": e["unavailable"], "excluded_as_not_short": e["excluded_long"],
        },
        "stopped_reason": job.get("stopped_reason"),
        "problems_total": len(problems),
        "problems": problems[:50],
        "next_step": nxt,
    }


def _new_job(channel: dict, mode: str, count: int, transcript_mode: str, lang: str | None) -> dict:
    cid = channel["channel_id"]
    return {
        "job_id": "c-" + secrets.token_urlsafe(16),
        "created": _now(), "updated": _now(), "phase": "enumerating",
        "channel": {k: channel.get(k) for k in ("channel_id", "title", "handle", "video_count")},
        "mode": mode, "count": count, "transcript_mode": transcript_mode, "lang": lang,
        "enum": {"source": "shorts_playlist", "playlist_id": "UUSH" + cid[2:],
                 "uploads_playlist": channel.get("uploads_playlist") or "UU" + cid[2:],
                 "page_token": None, "pages": 0, "finished": False, "history_complete": False,
                 "history_capped": False, "unavailable": 0, "excluded_long": 0, "rows": {}, "seen_total": 0},
        "order": [], "items": {}, "shortfall": None, "stopped_reason": None,
    }


# ----------------------------------------------------------------------------- tools

@mcp.tool
def start_collection(
    channel: str,
    mode: Literal["newest", "oldest", "most_viewed"] = "newest",
    count: int = 20,
    transcript_mode: Literal["native", "auto"] = "native",
    lang: str | None = None,
) -> dict:
    """Wybiera N Shortsów kanału i zaczyna pobierać ich PEŁNE transkrypcje (bez obcinania).

    Po wywołaniu powtarzaj continue_collection, aż complete=true. Stan jest zapisywany na serwerze.

    Args:
        channel: link do kanału, @handle albo ID (UC...).
        mode: newest = N najnowszych; oldest = N najstarszych; most_viewed = N z największą liczbą wyświetleń
              w dostępnej historii kanału (przegląda całą listę Shortsów, co kosztuje ok. 1 jednostkę YouTube na 25 filmów).
        count: ile Shortsów (1-500, domyślnie 20).
        transcript_mode: native = tylko istniejące napisy (1 kredyt Supadata/film); auto = gdy napisów brak, generuje AI
              (droższe, wolniejsze).
        lang: opcjonalny kod języka transkrypcji, np. "pl".
    """
    count = int(count)
    if not 1 <= count <= MAX_COUNT:
        raise ToolError(f"count musi być w zakresie 1-{MAX_COUNT}.")
    job = _new_job(yt._resolve(channel), mode, count, transcript_mode, lang)
    _save(job)
    return _step(job)


@mcp.tool
def continue_collection(
    job_id: str,
    retry_failed: bool = False,
    transcript_mode: Literal["native", "auto"] | None = None,
) -> dict:
    """Kontynuuje pobieranie (po limicie czasu, błędzie, limicie API albo restarcie serwera). Powtarzaj aż complete=true.

    Args:
        job_id: identyfikator z start_collection.
        retry_failed: ponów filmy ze statusem error.
        transcript_mode: zmiana trybu; "auto" ponawia także filmy bez napisów (no_captions), generując je przez AI.
    """
    lock = _lock_for(job_id)
    if lock.locked():
        return _status(_load(job_id)) | {"busy": "To zadanie jest właśnie przetwarzane innym wywołaniem."}
    job = _load(job_id)
    changed = False
    with lock:  # zmiany ustawień pod blokadą, krok i tak sam bierze blokadę po zwolnieniu
        job = _load(job_id)
        if transcript_mode and transcript_mode != job["transcript_mode"]:
            job["transcript_mode"] = transcript_mode
        requeue = {"error"} if retry_failed else set()
        if transcript_mode == "auto":
            requeue |= {"no_captions"}
        for it in job["items"].values():
            if it["status"] in requeue:
                it.update(status="pending", error=None, supadata_job=None)
                changed = True
        if changed and job["phase"] == "done":
            job["phase"] = "transcribing"
        if changed or transcript_mode:
            _save(job)
    return _step(job)


@mcp.tool
def get_collection_status(job_id: str) -> dict:
    """Pokazuje stan zadania: postęp, statusy transkrypcji, błędy i brakujące transkrypcje."""
    return _status(_load(job_id))


@mcp.tool
def list_collections(limit: int = 10) -> dict:
    """Lista ostatnich zadań zbierania (najnowsze pierwsze)."""
    out = []
    if jobs_root().is_dir():
        dirs = sorted((d for d in jobs_root().iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime, reverse=True)
        for d in dirs[: max(1, min(int(limit), 50))]:
            try:
                st = _status(_load(d.name))
                out.append({k: st[k] for k in ("job_id", "complete", "channel", "mode", "requested", "selected", "progress")})
            except ToolError:
                pass
    return {"collections": out}


# ------------------------------------------------------------------------ eksport

def _export_dir(job_id: str) -> Path:
    return _job_dir(job_id) / "export"


def _records(job: dict) -> list[dict]:
    recs = []
    for vid in job["order"]:
        it = job["items"][vid]
        text = None
        if it["status"] in ("ok", "empty"):
            text = _read_text(_transcript_path(job["job_id"], vid))
            if len(text) != it["transcript_chars"]:
                raise ToolError(f"Niezgodność długości transkrypcji dla {it['url']} — przerwano, nie eksportuję uszkodzonych danych.")
        recs.append({"title": it["title"], "duration_seconds": it["duration_seconds"], "transcript": text,
                     "published_at": it["published_at"], "url": it["url"], "views": it["views"]})
    return recs


def _csv_text(recs: list[dict]) -> str:
    buf = io.StringIO(newline="")
    w = csv.writer(buf)
    w.writerow(FIELDS)
    for r in recs:
        w.writerow(["" if r[f] is None else r[f] for f in FIELDS])
    return buf.getvalue()


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _signing_key() -> bytes:
    secret = common.require_env("JWT_SIGNING_KEY")
    return hmac.new(secret.encode(), b"export-links-v1", hashlib.sha256).digest()


def _sign(job_id: str, fmt: str, exp: int) -> str:
    return hmac.new(_signing_key(), f"{job_id}|{fmt}|{exp}".encode(), hashlib.sha256).hexdigest()


def signed_url(job_id: str, fmt: str) -> str | None:
    base = (os.getenv("PUBLIC_BASE_URL") or "").rstrip("/")
    if not base:
        return None
    exp = int(time.time()) + LINK_TTL
    return f"{base}/exports/{job_id}/{fmt}?e={exp}&s={_sign(job_id, fmt, exp)}"


@mcp.tool
def export_collection(job_id: str) -> dict:
    """Zapisuje pliki shorts.csv i shorts.json (DOKŁADNIE 6 pól: title, duration_seconds, transcript, published_at, url, views,
    z pełnymi transkrypcjami) oraz status.json (statusy i błędy dla każdego filmu), weryfikuje je i zwraca podpisane linki.

    Eksport można wykonać w dowolnym momencie; gdy complete=false, plik zawiera film bez transkrypcji
    (transcript puste/null) i jest oznaczony jako częściowy. Brakujących danych nie wymyślamy.
    """
    with _lock_for(job_id):
        job = _load(job_id)
        if not job["order"]:
            raise ToolError("Zadanie nie wybrało jeszcze żadnych filmów — najpierw continue_collection.")
        recs = _records(job)
        d = _export_dir(job_id)
        csv_text = _csv_text(recs)
        json_text = json.dumps(recs, ensure_ascii=False, indent=1)
        _write_atomic(d / EXPORT_FILES["csv"], csv_text.encode("utf-8-sig"))  # BOM: Excel poprawnie czyta polskie znaki
        _write_atomic(d / EXPORT_FILES["json"], json_text.encode("utf-8"))

        # --- weryfikacja po zapisie: odczyt plików z dysku i porównanie z danymi źródłowymi
        back_csv = list(csv.reader(io.StringIO((d / EXPORT_FILES["csv"]).read_bytes().decode("utf-8-sig"), newline="")))
        back_json = json.loads((d / EXPORT_FILES["json"]).read_text(encoding="utf-8"))
        if back_csv[0] != list(FIELDS) or len(back_csv) - 1 != len(recs) or len(back_json) != len(recs):
            raise ToolError("Weryfikacja eksportu nie powiodła się (liczba rekordów lub nagłówki). Pliki nie są wiarygodne.")
        for i, r in enumerate(recs):
            row = back_csv[i + 1]
            if list(back_json[i].keys()) != list(FIELDS) or back_json[i] != r:
                raise ToolError("Weryfikacja eksportu nie powiodła się (JSON różni się od danych źródłowych).")
            if row[2] != (r["transcript"] or ""):
                raise ToolError("Weryfikacja eksportu nie powiodła się (CSV: transkrypcja różni się od źródła).")

        complete = job["phase"] == "done"
        status = {
            "job_id": job_id, "generated_at": _now(), "complete": complete,
            "channel": job["channel"], "mode": job["mode"], "requested": job["count"],
            "selected": len(recs), "shortfall": job["shortfall"],
            "enumeration": {k: job["enum"][k] for k in ("source", "pages", "history_complete", "history_capped",
                                                         "unavailable", "excluded_long")},
            "counts": _status(job)["progress"],
            "files": {k: {"records": len(recs), "bytes": (d / EXPORT_FILES[k]).stat().st_size,
                          "sha256": _sha(d / EXPORT_FILES[k])} for k in ("csv", "json")},
            "records": [{"url": job["items"][v]["url"], "video_id": v, "status": job["items"][v]["status"],
                         "error": job["items"][v]["error"], "transcript_chars": job["items"][v]["transcript_chars"]}
                        for v in job["order"]],
        }
        _write_atomic(d / EXPORT_FILES["status"], json.dumps(status, ensure_ascii=False, indent=1))
        links = {k: signed_url(job_id, k) for k in EXPORT_FILES}
    return {
        "job_id": job_id, "complete": complete, "verified": True,
        "records_in_each_file": len(recs), "records_with_transcript": sum(1 for r in recs if r["transcript"]),
        "records_without_transcript": sum(1 for r in recs if not r["transcript"]),
        "counts": status["counts"], "shortfall": job["shortfall"],
        "files": status["files"],
        "links": links if links["csv"] else None,
        "links_valid_seconds": LINK_TTL if links["csv"] else None,
        "note": ("CSV: UTF-8 z BOM, pola w cudzysłowach gdy trzeba; transcript pusty = brak (zobacz status.json). "
                 "Linki są podpisane i wygasają; nie udostępniaj ich innym." if links["csv"] else
                 "PUBLIC_BASE_URL nie jest ustawiony: linków nie wygenerowano, użyj read_collection."),
        **({} if complete else {"warning": "CZĘŚCIOWY eksport: zadanie nie jest zakończone (complete=false)."}),
    }


@mcp.tool
def read_collection(job_id: str, cursor: str | None = None, max_chars: int = 40000) -> dict:
    """Czyta rekordy zadania PARTIAMI, z pełnymi transkrypcjami. Powtarzaj z next_cursor, aż next_cursor=null.

    Każdy element ma 6 pól + transcript_status, transcript_offset, transcript_chars_total i
    transcript_complete_in_this_item. Gdy pojedyncza transkrypcja nie mieści się w partii, jest zwracana w kawałkach:
    kolejne kawałki mają rosnący transcript_offset; sklej je w kolejności. Tekst z transcript_complete_in_this_item=false
    NIE jest kompletny.

    Args:
        job_id: identyfikator zadania.
        cursor: next_cursor z poprzedniej partii (puste = od początku).
        max_chars: maksymalny rozmiar partii w znakach (5000-80000).
    """
    job = _load(job_id)
    order = job["order"]
    budget = max(5000, min(int(max_chars), 80000))
    i, off = 0, 0
    if cursor:
        m = re.fullmatch(r"(\d+):(\d+)", cursor)
        if not m:
            raise ToolError("Nieprawidłowy cursor.")
        i, off = int(m.group(1)), int(m.group(2))
    items, used, next_cursor = [], 0, None
    while i < len(order) and next_cursor is None:
        it = job["items"][order[i]]
        text = _read_text(_transcript_path(job_id, it["video_id"])) if it["status"] in ("ok", "empty") else None
        total = len(text) if text is not None else 0
        while True:
            entry = {"title": it["title"], "duration_seconds": it["duration_seconds"], "transcript": None,
                     "published_at": it["published_at"], "url": it["url"], "views": it["views"],
                     "transcript_status": it["status"], "transcript_offset": off,
                     "transcript_chars_total": total if text is not None else None,
                     "transcript_complete_in_this_item": True}
            room = budget - used - len(json.dumps(entry, ensure_ascii=False)) - 40
            if items and room < (300 if text is not None else 0):
                next_cursor = f"{i}:{off}"  # partia pełna: ten rekord (lub jego reszta) idzie do następnej
                break
            chunk = None
            if text is not None:
                allowed = max(room, 300)
                chunk = text[off: off + allowed]
                while len(json.dumps(chunk, ensure_ascii=False)) > allowed + 2 and len(chunk) > 300:
                    chunk = chunk[: max(300, int(len(chunk) * 0.9))]  # uwzględnia rozrost przy znakach ucieczki
                entry["transcript"] = chunk
                entry["transcript_complete_in_this_item"] = off + len(chunk) >= total
            items.append(entry)
            used += len(json.dumps(entry, ensure_ascii=False))
            if text is not None and off + len(chunk) < total:
                off += len(chunk)
                continue
            break
        if next_cursor is None:
            i, off = i + 1, 0
    return {"job_id": job_id, "complete": job["phase"] == "done", "total_records": len(order),
            "items": items, "next_cursor": next_cursor,
            "note": "Kolejne kawałki tej samej transkrypcji sklej wg transcript_offset. Brak transcript = brak danych (zobacz transcript_status)."}


# ------------------------------------------------------------------ pobieranie plików

def register_routes(server: FastMCP) -> None:
    @server.custom_route("/exports/{job_id}/{fmt}", methods=["GET"])
    async def download(request: Request) -> Response:
        job_id, fmt = request.path_params["job_id"], request.path_params["fmt"]
        q = request.query_params
        deny = PlainTextResponse("Brak dostępu.", status_code=403, headers={"Cache-Control": "no-store"})
        if fmt not in EXPORT_FILES or not JOB_ID_RE.fullmatch(job_id):
            return deny
        try:
            exp = int(q.get("e", "0"))
        except ValueError:
            return deny
        if exp < time.time() or not hmac.compare_digest(q.get("s", ""), _sign(job_id, fmt, exp)):
            return deny
        path = _export_dir(job_id) / EXPORT_FILES[fmt]
        if not path.is_file():
            return PlainTextResponse("Brak pliku (wykonaj export_collection).", status_code=404)
        name = f"shorts-{job_id}.{'csv' if fmt == 'csv' else 'json'}" if fmt != "status" else f"status-{job_id}.json"
        return Response(path.read_bytes(), media_type=MIME[fmt], headers={
            "Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"})
