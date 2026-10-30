"""Serwer MCP #1: statystyki YouTube przez oficjalne YouTube Data API v3.

Narzędzia:
  - list_channel_videos  -> N ostatnich shortsów (lub filmów) kanału + statystyki
  - search_videos        -> wyszukiwanie po frazie (drogie: 100 jednostek/wywołanie)
  - get_videos           -> statystyki dla podanych filmów (ID lub linki)
  - resolve_channel      -> dane kanału (ID, subskrypcje, liczba filmów)
  - get_quota_usage      -> zużycie limitów dziennych

Rozliczanie limitów (YT_SEARCH_QUOTA_MODEL):
  - channels/playlistItems/videos.list = 1 jednostka z puli 10 000 dziennie; nieprawidłowe zapytania też min. 1;
  - search.list, tryb "shared" (DOMYŚLNY, ostrożny): 100 jednostek z TEJ SAMEJ puli, wymagane wolne 100 przed wywołaniem
    (tak liczono historycznie; zawyża zużycie, nigdy nie zaniża);
  - tryb "separate": wg dokumentacji Google z 2026-10-08 search.list ma osobną pulę 100 wywołań dziennie (1 jednostka/wywołanie).
  W obu trybach liczymy też wywołania search (limit 100/dobę). Rezerwacja jest atomowa i następuje przed zapytaniem.
  Reset o północy czasu pacyficznego.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
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
    env_float,
    env_int,
    require_env,
)

API = "https://www.googleapis.com/youtube/v3"
SHORTS_MAX_SECONDS = 180  # od 2024 shorty mogą mieć do 3 minut

STATS_TTL = env_int("YT_STATS_CACHE_SECONDS", 3600)  # statystyki: 1 h
CHANNEL_TTL = 24 * 3600  # dane kanału: 24 h
REQUEST_DELAY = env_float("YT_REQUEST_DELAY_SECONDS", 0.25)

# Własne limity bezpieczeństwa (poniżej limitów Google), zapisywane na dysku i zerowane o północy czasu pacyficznego.
UNIT_BUDGET = DailyBudget("yt_units", env_int("YT_DAILY_UNIT_BUDGET", 9000), "America/Los_Angeles",
                          "jednostki YouTube API")
SEARCH_BUDGET = DailyBudget("yt_search_calls", env_int("YT_DAILY_SEARCH_CALLS", 100), "America/Los_Angeles",
                            "wywołania search.list")
SEARCH_UNIT_COST = 100  # historyczny, oficjalny koszt search.list we wspólnej puli
SEARCH_QUOTA_MODEL = (os.getenv("YT_SEARCH_QUOTA_MODEL") or "shared").strip().lower()
if SEARCH_QUOTA_MODEL not in ("shared", "separate"):
    raise RuntimeError("YT_SEARCH_QUOTA_MODEL musi mieć wartość 'shared' albo 'separate'.")

mcp = FastMCP(
    "youtube-stats",
    mask_error_details=True,  # nieprzewidziane wyjątki nie ujawniają szczegółów; komunikaty ToolError przechodzą
    instructions=(
        "Statystyki YouTube z oficjalnego API. Do pobrania shortsów kanału użyj "
        "list_channel_videos (tanie). search_videos ma małą dzienną pulę wywołań — używaj tylko, "
        "gdy trzeba szukać po temacie, a nie po kanale."
    ),
)

_http = httpx.Client(timeout=30)
_throttle = Throttle(REQUEST_DELAY)  # wspólny odstęp między zapytaniami, także przy równoległych wywołaniach


class YTError(ToolError):
    def __init__(self, message: str, status: int = 0, reason: str = ""):
        super().__init__(message)
        self.status = status
        self.reason = reason


# --------------------------------------------------------------------------- HTTP

def _explain(resp: httpx.Response) -> YTError:
    reason, message = "", ""
    try:
        err = resp.json().get("error", {})
        message = err.get("message", "")
        errors = err.get("errors") or []
        if errors:
            reason = errors[0].get("reason", "")
    except ValueError:
        message = resp.text[:200]

    if reason in ("quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"):
        text = (
            "Wyczerpany dzienny limit YouTube Data API (dotyczy puli głównej albo search.list). "
            "Limit resetuje się o północy czasu pacyficznego (ok. 9:00 rano w Polsce). "
            "Wyniki już pobrane są w cache i nadal działają."
        )
    elif "API key not valid" in message or reason == "keyInvalid":
        text = "Klucz YOUTUBE_API_KEY jest nieprawidłowy. Sprawdź go w Google Cloud Console."
    elif reason in ("accessNotConfigured", "serviceDisabled"):
        text = "W projekcie Google Cloud nie jest włączone YouTube Data API v3. Włącz je w bibliotece API."
    elif reason == "playlistNotFound":
        text = "Nie znaleziono playlisty."
    else:
        text = f"Błąd YouTube API ({resp.status_code}): {message or reason or 'nieznany'}"
    return YTError(text, resp.status_code, reason)


def _call(endpoint: str, params: dict, ttl: int = STATS_TTL) -> dict:
    """Jedno wywołanie API z cache, limitami własnymi i naliczaniem kosztu.

    Klucz API idzie w nagłówku (nie w adresie URL), więc nie trafia do logów, wyjątków ani cache.
    """
    cache_key = {"e": endpoint, "p": params}
    hit = cache_get("yt", cache_key, ttl)
    if hit is not None:
        return hit

    is_search = endpoint == "search"
    # Atomowa rezerwacja PRZED wysłaniem zapytania (równoległe wywołania nie przekroczą limitu).
    if not is_search:
        UNIT_BUDGET.reserve(1)
    else:
        shared = SEARCH_QUOTA_MODEL == "shared"
        if shared:
            UNIT_BUDGET.reserve(SEARCH_UNIT_COST)  # wymaga 100 wolnych jednostek
        try:
            SEARCH_BUDGET.reserve(1)
        except BudgetExceeded:
            if shared:
                UNIT_BUDGET.refund(SEARCH_UNIT_COST)
            raise
    headers = {"x-goog-api-key": require_env("YOUTUBE_API_KEY")}
    _throttle.wait()
    try:
        resp = _http.get(f"{API}/{endpoint}", params=params, headers=headers)
    except httpx.HTTPError as exc:
        raise YTError(f"Błąd połączenia z YouTube API ({type(exc).__name__}).") from exc
    # Koszt został już zarezerwowany; zapytania błędne też kosztują po stronie Google, więc nie zwracamy go.
    if resp.status_code != 200:
        raise _explain(resp)
    data = resp.json()
    cache_set("yt", cache_key, data)
    return data


# ------------------------------------------------------------------------ helpers

def _parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _seconds(iso_duration: str) -> int:
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso_duration or "")
    if not m:
        return 0
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def _int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


VIDEO_ID_RE = re.compile(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([A-Za-z0-9_-]{11})")


def _video_id(ref: str) -> str:
    ref = ref.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", ref):
        return ref
    m = VIDEO_ID_RE.search(ref)
    if not m:
        raise ToolError(f"Nie rozpoznaję ID filmu w: {ref!r}")
    return m.group(1)


def _row(item: dict, details: bool) -> dict:
    sn = item.get("snippet", {})
    st = item.get("statistics", {})
    dur = _seconds(item.get("contentDetails", {}).get("duration", ""))
    views, likes, comments = (_int(st.get(k)) for k in ("viewCount", "likeCount", "commentCount"))
    published = sn.get("publishedAt")
    days_old = None
    if published:
        days_old = max((datetime.now(timezone.utc) - _parse_dt(published)).total_seconds() / 86400, 0)
    thumbs = sn.get("thumbnails", {})
    thumb = (thumbs.get("maxres") or thumbs.get("high") or thumbs.get("default") or {}).get("url")
    row = {
        "video_id": item["id"],
        "url": f"https://www.youtube.com/shorts/{item['id']}" if dur <= SHORTS_MAX_SECONDS
        else f"https://www.youtube.com/watch?v={item['id']}",
        "title": sn.get("title"),
        "channel": sn.get("channelTitle"),
        "published_at": published,
        "duration_seconds": dur,
        "views": views,
        "likes": likes,  # None = ukryte przez autora
        "comments": comments,  # None = wyłączone/ukryte
        "engagement_pct": round((likes + (comments or 0)) / views * 100, 2)
        if views and likes is not None else None,
        "views_per_day": round(views / max(days_old, 1), 1) if views is not None and days_old is not None else None,
        "thumbnail": thumb,
    }
    if details:
        row["description"] = (sn.get("description") or "")[:500]
        row["tags"] = (sn.get("tags") or [])[:15]
        row["category_id"] = sn.get("categoryId")
        row["default_language"] = sn.get("defaultAudioLanguage") or sn.get("defaultLanguage")
    return row


def _fetch_videos(ids: list[str], details: bool) -> list[dict]:
    # videos.list z filtrem `id` NIE przyjmuje maxResults ani pageToken (dokumentacja Google) — max 50 ID na wywołanie.
    rows: dict[str, dict] = {}
    for i in range(0, len(ids), 50):
        chunk = ids[i : i + 50]
        data = _call("videos", {"part": "snippet,contentDetails,statistics", "id": ",".join(chunk)})
        for item in data.get("items", []):
            rows[item["id"]] = _row(item, details)
    return [rows[v] for v in ids if v in rows]  # zachowaj kolejność; pomiń usunięte/prywatne


def _channel_info(item: dict) -> dict:
    sn, st = item.get("snippet", {}), item.get("statistics", {})
    return {
        "channel_id": item["id"],
        "title": sn.get("title"),
        "handle": sn.get("customUrl"),
        "country": sn.get("country"),
        "subscribers": None if st.get("hiddenSubscriberCount") else _int(st.get("subscriberCount")),
        "total_views": _int(st.get("viewCount")),
        "video_count": _int(st.get("videoCount")),
        "uploads_playlist": item.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads"),
        "url": f"https://www.youtube.com/channel/{item['id']}",
    }


CHANNEL_PARTS = "snippet,statistics,contentDetails"


def _channel_by(**filt) -> dict | None:
    data = _call("channels", {"part": CHANNEL_PARTS, **filt}, CHANNEL_TTL)
    items = data.get("items") or []
    return _channel_info(items[0]) if items else None


def _resolve(ref: str) -> dict:
    ref = (ref or "").strip()
    if not ref:
        raise ToolError("Podaj kanał: link, @handle lub ID (UC...).")

    m = re.search(r"youtube\.com/channel/(UC[\w-]{22})", ref)
    if m or re.fullmatch(r"UC[\w-]{22}", ref):
        found = _channel_by(id=m.group(1) if m else ref)
    elif (h := re.search(r"youtube\.com/(@[^/?#\s]+)", ref)) or ref.startswith("@"):
        found = _channel_by(forHandle=h.group(1) if h else ref)
    elif u := re.search(r"youtube\.com/user/([^/?#\s]+)", ref):
        found = _channel_by(forUsername=u.group(1))
    elif "youtube.com/" in ref or "youtu.be/" in ref:
        # link do filmu/shorta zamiast kanału -> znajdź kanał tego filmu (1 jednostka)
        vm = VIDEO_ID_RE.search(ref)
        if vm:
            data = _call("videos", {"part": "snippet", "id": vm.group(1)})
            items = data.get("items") or []
            found = _channel_by(id=items[0]["snippet"]["channelId"]) if items else None
        else:
            found = None
            custom = re.search(r"youtube\.com/(?:c/)?([^/?#@\s]+)/?$", ref)
            if custom:
                found = _search_channel(custom.group(1))
    else:
        found = _channel_by(forHandle="@" + ref.lstrip("@"))
        if not found:
            found = _search_channel(ref)  # ostatnia deska ratunku (zużywa wywołanie search.list)

    if not found:
        raise ToolError(f"Nie znaleziono kanału: {ref!r}")
    return found


def _search_channel(name: str) -> dict | None:
    hits = _call("search", {"part": "snippet", "type": "channel", "q": name, "maxResults": 1}, CHANNEL_TTL)
    items = hits.get("items") or []
    return _channel_by(id=items[0]["snippet"]["channelId"]) if items else None


def _playlist_ids(playlist_id: str, want: int, cutoff: datetime | None) -> list[str]:
    out: list[str] = []
    token = None
    while len(out) < want:
        params = {"part": "contentDetails", "playlistId": playlist_id, "maxResults": 50}
        if token:
            params["pageToken"] = token
        data = _call("playlistItems", params)
        for it in data.get("items", []):
            cd = it.get("contentDetails", {})
            pub = cd.get("videoPublishedAt")
            if cutoff and pub and _parse_dt(pub) < cutoff:
                return out  # playlista idzie od najnowszych, dalej będą tylko starsze
            out.append(cd["videoId"])
            if len(out) >= want:
                break
        token = data.get("nextPageToken")
        if not token:
            break
    return out


def _usage() -> dict:
    return {
        "quota": {
            "units_used_today": UNIT_BUDGET.used(),
            "units_safety_limit": UNIT_BUDGET.limit,
            "search_calls_used_today": SEARCH_BUDGET.used(),
            "search_calls_safety_limit": SEARCH_BUDGET.limit,
            "search_quota_model": SEARCH_QUOTA_MODEL,
            "search_unit_cost": SEARCH_UNIT_COST if SEARCH_QUOTA_MODEL == "shared" else 0,
        }
    }


# ------------------------------------------------------------------------- tools

@mcp.tool
def resolve_channel(channel: str) -> dict:
    """Pobiera dane kanału YouTube (ID, nazwa, subskrypcje, liczba filmów).

    Args:
        channel: link do kanału, @handle albo ID kanału (UC...). Link do filmu też zadziała (znajdzie jego kanał).
    """
    return _resolve(channel) | _usage()


@mcp.tool
def list_channel_videos(
    channel: str,
    limit: int = 20,
    shorts_only: bool = True,
    days: int | None = None,
    sort_by: Literal["date", "views"] = "date",
    include_details: bool = False,
) -> dict:
    """Pobiera N ostatnich shortsów (lub wszystkich filmów) kanału ze statystykami.

    Tanie w limicie API: ok. 8 jednostek na 200 filmów (nie używa search.list).

    Args:
        channel: link do kanału, @handle albo ID kanału (UC...).
        limit: ile filmów pobrać (1-200).
        shorts_only: True = tylko shorty, False = wszystkie filmy kanału.
        days: opcjonalnie tylko filmy z ostatnich N dni.
        sort_by: "date" (najnowsze pierwsze) albo "views" (najpopularniejsze pierwsze, wśród pobranych).
        include_details: dołącz opis i tagi (więcej tokenów).
    """
    limit = max(1, min(int(limit), 200))
    ch = _resolve(channel)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days) if days else None
    uploads = ch["uploads_playlist"] or "UU" + ch["channel_id"][2:]

    rows: list[dict] | None = None
    method = "uploads"
    if shorts_only:
        try:
            # playlista UUSH... zawiera tylko shorty (nieoficjalny, ale znany sposób)
            ids = _playlist_ids("UUSH" + ch["channel_id"][2:], limit, cutoff)
            rows = _fetch_videos(ids, include_details)
            method = "shorts_playlist"
        except YTError as exc:
            if exc.reason != "playlistNotFound" and exc.status != 404:
                raise
        if rows is None:  # zapasowo: filtr po długości (<= 3 min)
            ids = _playlist_ids(uploads, min(limit * 4, 200), cutoff)
            rows = [r for r in _fetch_videos(ids, include_details) if r["duration_seconds"] <= SHORTS_MAX_SECONDS]
            rows = rows[:limit]
            method = "uploads_filtered_by_duration"
    else:
        rows = _fetch_videos(_playlist_ids(uploads, limit, cutoff), include_details)

    if sort_by == "views":
        rows.sort(key=lambda r: r["views"] or 0, reverse=True)

    return {
        "channel": {k: ch[k] for k in ("channel_id", "title", "handle", "subscribers", "video_count")},
        "method": method,
        "count": len(rows),
        "videos": rows,
        "notice": UNTRUSTED_NOTICE,
    } | _usage()


def _first_search_params(query, order, published_after, shorts_only, region, language) -> dict:
    params = {"part": "snippet", "type": "video", "q": query, "order": order,
              "publishedAfter": published_after, "maxResults": 50}
    if shorts_only:
        params["videoDuration"] = "short"
    if region:
        params["regionCode"] = region
    if language:
        params["relevanceLanguage"] = language
    return params


@mcp.tool
def search_videos(
    query: str,
    days: int = 90,
    max_results: int = 30,
    order: Literal["viewCount", "date", "relevance", "rating"] = "viewCount",
    shorts_only: bool = False,
    region: str | None = None,
    language: str | None = None,
    include_details: bool = False,
) -> dict:
    """Szuka filmów po frazie. UWAGA: każde wywołanie search.list (50 wyników) kosztuje 100 jednostek ze wspólnej puli (tryb domyślny), więc używaj oszczędnie.

    Args:
        query: fraza do wyszukania.
        days: tylko filmy z ostatnich N dni.
        max_results: ile wyników (1-100).
        order: sortowanie wyników.
        shorts_only: True = tylko filmy do 3 minut.
        region: opcjonalny kod kraju, np. "PL".
        language: opcjonalny kod języka, np. "pl".
        include_details: dołącz opis i tagi.
    """
    max_results = max(1, min(int(max_results), 100))
    # Zaokrąglenie do początku dnia (UTC): identyczne zapytanie w ciągu doby trafia w cache zamiast zużywać pulę.
    start = (datetime.now(timezone.utc) - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)
    published_after = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    if SEARCH_QUOTA_MODEL == "shared" and cache_get("yt", {"e": "search", "p": _first_search_params(
            query, order, published_after, shorts_only, region, language)}, STATS_TTL) is None:
        # Nie zaczynaj, jeśli po wyszukiwaniu zabrakłoby jednostki na pobranie statystyk (zmarnowane 100 jednostek).
        UNIT_BUDGET.check(SEARCH_UNIT_COST + 1)
    ids: list[str] = []
    token = None
    while len(ids) < max_results:
        params = _first_search_params(query, order, published_after, shorts_only, region, language)
        if token:
            params["pageToken"] = token
        data = _call("search", params)
        ids += [it["id"]["videoId"] for it in data.get("items", []) if it.get("id", {}).get("videoId")]
        ids = list(dict.fromkeys(ids))
        token = data.get("nextPageToken")
        if not token:
            break
    rows = _fetch_videos(ids[: max_results * 2 if shorts_only else max_results], include_details)
    if shorts_only:
        rows = [r for r in rows if r["duration_seconds"] <= SHORTS_MAX_SECONDS]
    rows = rows[:max_results]
    return {"query": query, "count": len(rows), "videos": rows, "notice": UNTRUSTED_NOTICE} | _usage()


@mcp.tool
def get_videos(videos: list[str], include_details: bool = False) -> dict:
    """Pobiera statystyki podanych filmów (linki lub ID). Koszt: 1 jednostka na 50 filmów.

    Args:
        videos: lista linków (watch, shorts, youtu.be) lub 11-znakowych ID (max 200).
        include_details: dołącz opis i tagi.
    """
    if len(videos) > 200:
        raise ToolError("Maksymalnie 200 filmów na wywołanie.")
    ids = list(dict.fromkeys(_video_id(v) for v in videos))
    rows = _fetch_videos(ids, include_details)
    found = {r["video_id"] for r in rows}
    return {
        "count": len(rows),
        "videos": rows,
        "not_found_or_private": [v for v in ids if v not in found],
        "notice": UNTRUSTED_NOTICE,
    } | _usage()


@mcp.tool
def get_quota_usage() -> dict:
    """Pokazuje dzienne zużycie limitów YouTube API (liczone przez ten serwer; cache nie liczy się)."""
    return _usage() | {
        "note": "Pula: 10 000 jednostek dziennie; search.list liczony ostrożnie jako 100 jednostek z tej samej puli (YT_SEARCH_QUOTA_MODEL). "
        "Reset o północy czasu pacyficznego. Dokładne wartości sprawdź w Google Cloud Console → Quotas."
    }


if __name__ == "__main__":
    mcp.run()
