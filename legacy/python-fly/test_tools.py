"""Testy funkcjonalne narzędzi YouTube i Supadata na atrapach API, które odtwarzają prawdziwe ograniczenia
(np. videos.list odrzuca maxResults razem z id; search.list kosztuje 100 jednostek wspólnej puli (tryb ostrożny); Supadata zwraca 206/202/429).

Uruchom:  python test_tools.py
Atrapy NIE zastępują prawdziwych usług — patrz AUDYT.md, sekcja "czego nie da się sprawdzić".
"""
import asyncio
import json
import logging
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

YT_KEY = "YTKEY-MARKER-123"
SD_KEY = "SDKEY-MARKER-456"
os.environ.update({
    "MCP_CACHE_DIR": tempfile.mkdtemp(), "YOUTUBE_API_KEY": YT_KEY, "SUPADATA_API_KEY": SD_KEY,
    "YT_REQUEST_DELAY_SECONDS": "0", "SUPADATA_DELAY_SECONDS": "0", "SUPADATA_MIN_INTERVAL_SECONDS": "0",
    "SUPADATA_SINGLE_WAIT_SECONDS": "1.5", "SUPADATA_BATCH_BUDGET_SECONDS": "30",
})

import httpx
from fastmcp import Client
from fastmcp.exceptions import ToolError

import common
import server as srv
import supadata_mcp
import youtube_mcp

_real_sleep = time.sleep
time.sleep = lambda s: _real_sleep(min(s, 0.01))  # testy nie czekają na opóźnienia i ponowienia

CH_A = "UC" + "a" * 22  # kanał z playlistą shortsów
CH_B = "UC" + "b" * 22  # kanał bez playlisty UUSH (zapasowa ścieżka)
NOW = datetime.now(timezone.utc)


def fresh_cache():
    d = Path(tempfile.mkdtemp())
    common.CACHE_DIR = d
    return d


def call(server, name, **args):
    async def go():
        async with Client(server) as c:
            return (await c.call_tool(name, args)).data
    return asyncio.run(go())


def raises_tool_error(server, name, **args) -> str:
    try:
        call(server, name, **args)
    except ToolError as exc:
        return str(exc)
    raise AssertionError("oczekiwano ToolError")


# ------------------------------------------------------------------ atrapa YouTube API

class YT:
    log: list = []
    violations: list = []
    quota_exceeded = False


def _pub(n):
    return (NOW - timedelta(days=n, hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _page(items, params):
    start = {"p2": 50, "p3": 100}.get(params.get("pageToken"), 0)
    chunk = items[start:start + 50]
    body = {"items": chunk}
    if start + 50 < len(items):
        body["nextPageToken"] = {50: "p2", 100: "p3"}[start + 50]
    return body


def yt_handler(request: httpx.Request) -> httpx.Response:
    p = dict(request.url.params)
    endpoint = request.url.path.rsplit("/", 1)[-1]
    YT.log.append((endpoint, p))
    if "key" in p:
        YT.violations.append("klucz API w adresie URL")
    if request.headers.get("x-goog-api-key") != YT_KEY:
        return httpx.Response(400, json={"error": {"message": "API key not valid.", "errors": [{"reason": "badRequest"}]}})
    if YT.quota_exceeded:
        return httpx.Response(403, json={"error": {"message": "quota", "errors": [{"reason": "quotaExceeded"}]}})
    if endpoint == "channels":
        reg = {"@testchan": CH_A, CH_A: CH_A, "@noshorts": CH_B, CH_B: CH_B}
        cid = reg.get(p.get("forHandle") or p.get("id"))
        if not cid:
            return httpx.Response(200, json={"items": []})
        return httpx.Response(200, json={"items": [{
            "id": cid, "snippet": {"title": "Test", "customUrl": "@testchan"},
            "statistics": {"subscriberCount": "1200", "viewCount": "9", "videoCount": "150"},
            "contentDetails": {"relatedPlaylists": {"uploads": "UU" + cid[2:]}}}]})
    if endpoint == "playlistItems":
        pid = p["playlistId"]
        if pid == "UUSH" + CH_A[2:]:
            items = [{"contentDetails": {"videoId": f"vid{n:08d}", "videoPublishedAt": _pub(n)}} for n in range(120)]
        elif pid == "UU" + CH_B[2:]:
            items = [{"contentDetails": {"videoId": f"upl{n:08d}", "videoPublishedAt": _pub(n)}} for n in range(60)]
        else:
            return httpx.Response(404, json={"error": {"message": "nf", "errors": [{"reason": "playlistNotFound"}]}})
        return httpx.Response(200, json=_page(items, p))
    if endpoint == "videos":
        if "maxResults" in p or "pageToken" in p:  # tak odpowiada prawdziwe API przy filtrze id
            YT.violations.append("videos.list z maxResults/pageToken i id")
            return httpx.Response(400, json={"error": {"message": "incompatible parameters", "errors": [{"reason": "incompatibleParameters"}]}})
        out = []
        for vid in p["id"].split(","):
            if vid.startswith("gone"):
                continue
            n = int(vid[3:])
            dur = "PT10M" if (vid.startswith("upl") and n % 5 == 4) else "PT42S"
            out.append({"id": vid, "snippet": {"title": f"Film {vid}", "channelId": CH_A, "channelTitle": "Test", "publishedAt": _pub(n),
                                                "thumbnails": {"high": {"url": "http://t/x.jpg"}}},
                        "contentDetails": {"duration": dur},
                        "statistics": {"viewCount": str(1000 * (n + 1)), "likeCount": "50", "commentCount": "5"}})
        return httpx.Response(200, json={"items": out})
    if endpoint == "search":
        if p.get("type") == "channel":
            return httpx.Response(200, json={"items": [{"snippet": {"channelId": CH_A}}]})
        items = [{"id": {"videoId": f"sea{n:08d}"}} for n in range(100)]
        body = _page(items, {"pageToken": {"s2": "p2"}.get(p.get("pageToken"))})
        if "nextPageToken" in body:
            body["nextPageToken"] = "s2"
        return httpx.Response(200, json=body)
    return httpx.Response(500)


def reset_yt(quota_exceeded=False):
    fresh_cache()
    YT.log.clear()
    YT.violations.clear()
    YT.quota_exceeded = quota_exceeded
    youtube_mcp._http = httpx.Client(transport=httpx.MockTransport(yt_handler))
    youtube_mcp.UNIT_BUDGET.limit = 9000
    youtube_mcp.SEARCH_BUDGET.limit = 100
    youtube_mcp.SEARCH_QUOTA_MODEL = "shared"


def calls(endpoint):
    return [p for e, p in YT.log if e == endpoint]


# -------------------------------------------------------------------- testy YouTube

def test_yt_pagination_cost_and_request_shape():
    reset_yt()
    r = call(youtube_mcp.mcp, "list_channel_videos", channel="@testchan", limit=120)
    assert r["method"] == "shorts_playlist" and r["count"] == 120, r["count"]
    assert len(calls("playlistItems")) == 3 and len(calls("videos")) == 3
    assert not YT.violations, YT.violations  # klucz tylko w nagłówku; videos.list bez maxResults
    assert youtube_mcp.UNIT_BUDGET.used() == 7, youtube_mcp.UNIT_BUDGET.used()  # 1 (kanał) + 3 + 3
    first = r["videos"][0]
    assert first["url"].startswith("https://www.youtube.com/shorts/") and first["views"] == 1000
    assert first["duration_seconds"] == 42 and first["likes"] == 50 and first["engagement_pct"] == 5.5
    before = len(YT.log)
    r2 = call(youtube_mcp.mcp, "list_channel_videos", channel="@testchan", limit=120)
    assert len(YT.log) == before and r2["count"] == 120, "powtórzenie musi iść z cache"
    assert youtube_mcp.UNIT_BUDGET.used() == 7
    r3 = call(youtube_mcp.mcp, "list_channel_videos", channel="@testchan", limit=20, sort_by="views")
    assert r3["videos"][0]["views"] >= r3["videos"][-1]["views"]
    print("OK  YT: paginacja 3 stron, 7 jednostek, klucz tylko w nagłówku, brak maxResults przy id, cache, sortowanie")


def test_yt_days_filter_and_fallback():
    reset_yt()
    r = call(youtube_mcp.mcp, "list_channel_videos", channel="@testchan", limit=100, days=10)
    assert r["count"] == 10, r["count"]
    reset_yt()
    r = call(youtube_mcp.mcp, "list_channel_videos", channel="@noshorts", limit=20)
    assert r["method"] == "uploads_filtered_by_duration", r["method"]
    assert r["count"] == 20 and all(v["duration_seconds"] <= 180 for v in r["videos"])
    r = call(youtube_mcp.mcp, "list_channel_videos", channel="@noshorts", limit=10, shorts_only=False)
    assert r["method"] == "uploads" and any(v["duration_seconds"] == 600 for v in r["videos"])
    print("OK  YT: filtr dni, zapasowa ścieżka gdy brak playlisty shortsów (filtr po długości), tryb wszystkich filmów")


def test_yt_resolve_variants_and_get_videos():
    reset_yt()
    for ref in ("@testchan", "https://www.youtube.com/@testchan/shorts", f"https://www.youtube.com/channel/{CH_A}", CH_A,
                "testchan", "https://youtube.com/shorts/vid00000007"):
        assert call(youtube_mcp.mcp, "resolve_channel", channel=ref)["channel_id"] == CH_A, ref
    r = call(youtube_mcp.mcp, "get_videos", videos=["https://youtu.be/vid00000001", "vid00000001", "gone0000001", "vid00000002"])
    assert r["count"] == 2 and r["not_found_or_private"] == ["gone0000001"], r
    msg = raises_tool_error(youtube_mcp.mcp, "get_videos", videos=["to-nie-jest-film"])
    assert "Nie rozpoznaję" in msg
    assert "Nie znaleziono" in raises_tool_error(youtube_mcp.mcp, "resolve_channel", channel="@nieistnieje")
    print("OK  YT: rozpoznawanie kanału (handle, linki, ID, link do shorta), get_videos z duplikatami i usuniętymi")


def test_yt_search_budget_pagination_and_cache():
    # tryb domyślny "shared": 1 wywołanie search = 100 jednostek ze wspólnej puli
    reset_yt()
    assert youtube_mcp.SEARCH_QUOTA_MODEL == "shared"
    r = call(youtube_mcp.mcp, "search_videos", query="porady", max_results=100)
    assert r["count"] == 100 and len(calls("search")) == 2
    assert youtube_mcp.UNIT_BUDGET.used() == 202 and youtube_mcp.SEARCH_BUDGET.used() == 2  # 2x100 search + 2x1 videos.list
    call(youtube_mcp.mcp, "search_videos", query="porady", max_results=100)
    assert len(calls("search")) == 2, "identyczne wyszukiwanie w tej samej dobie ma iść z cache (zaokrąglony publishedAfter)"
    assert youtube_mcp.UNIT_BUDGET.used() == 202
    assert not YT.violations
    print("OK  YT: search = 100 jednostek wspólnej puli za wywołanie (2 strony = 200 + 2 videos.list), paginacja, cache dobowy")


def test_yt_search_requires_100_free_units_before_call():
    reset_yt()
    youtube_mcp.UNIT_BUDGET.limit = 9000
    youtube_mcp.UNIT_BUDGET.add(8900)  # zostaje dokładnie 100 wolnych
    msg = raises_tool_error(youtube_mcp.mcp, "search_videos", query="a", max_results=10)
    assert not calls("search"), "100 wolnych nie wystarcza na search + pobranie statystyk (101): nie wolno zaczynać"
    youtube_mcp.UNIT_BUDGET.refund(1)  # teraz 101 wolnych
    call(youtube_mcp.mcp, "search_videos", query="a", max_results=10)
    assert len(calls("search")) == 1 and youtube_mcp.UNIT_BUDGET.used() == 9000
    n = len(YT.log)
    msg = raises_tool_error(youtube_mcp.mcp, "search_videos", query="b", max_results=10)
    assert "Dzienny limit bezpieczeństwa" in msg, msg
    assert len(YT.log) == n, "bez 100 wolnych jednostek zapytanie nie może wyjść do Google"
    # 99 wolnych jednostek nie wystarcza na search, ale wystarcza na zwykłe zapytanie (1 jednostka)
    reset_yt()
    youtube_mcp.UNIT_BUDGET.add(8901)
    assert "Dzienny limit" in raises_tool_error(youtube_mcp.mcp, "search_videos", query="c", max_results=10)
    assert call(youtube_mcp.mcp, "get_videos", videos=["vid00000001"])["count"] == 1
    # limit wywołań search działa niezależnie i zwraca jednostki, gdy odmawia
    reset_yt()
    youtube_mcp.SEARCH_BUDGET.limit = 1
    call(youtube_mcp.mcp, "search_videos", query="d", max_results=10)
    before = youtube_mcp.UNIT_BUDGET.used()
    raises_tool_error(youtube_mcp.mcp, "search_videos", query="e", max_results=10)
    assert youtube_mcp.UNIT_BUDGET.used() == before, "odmowa nie może pobrać jednostek"
    print("OK  YT: search wymaga 100 wolnych jednostek PRZED wywołaniem (99 = odmowa, bez ruchu do Google), zwrot rezerwacji")


def test_yt_search_separate_mode():
    reset_yt()
    youtube_mcp.SEARCH_QUOTA_MODEL = "separate"
    try:
        call(youtube_mcp.mcp, "search_videos", query="x", max_results=10)
        assert youtube_mcp.UNIT_BUDGET.used() == 1 and youtube_mcp.SEARCH_BUDGET.used() == 1  # 1 = videos.list; search poza pulą
        youtube_mcp.SEARCH_BUDGET.limit = 1
        assert "Dzienny limit bezpieczeństwa" in raises_tool_error(youtube_mcp.mcp, "search_videos", query="y", max_results=10)
        q = call(youtube_mcp.mcp, "get_quota_usage")["quota"]
        assert q["search_quota_model"] == "separate"
    finally:
        youtube_mcp.SEARCH_QUOTA_MODEL = "shared"
    q = call(youtube_mcp.mcp, "get_quota_usage")["quota"]
    assert q["search_quota_model"] == "shared" and q["search_unit_cost"] == 100
    print("OK  YT: tryb 'separate' (osobna pula wg dokumentacji Google) i raport get_quota_usage")


def test_budget_atomic_under_concurrency():
    from concurrent.futures import ThreadPoolExecutor
    d = fresh_cache()
    b = common.DailyBudget("conc", 100, "UTC", "test")
    ok = fail = 0

    def go(_):
        try:
            b.reserve(10)
            return True
        except common.BudgetExceeded:
            return False

    with ThreadPoolExecutor(32) as ex:
        res = list(ex.map(go, range(60)))
    assert sum(res) == 10 and b.used() == 100, (sum(res), b.used())
    # przez prawdziwe narzędzia: 40 równoległych wyszukiwań przy 5 wolnych "setkach"
    reset_yt()
    youtube_mcp.UNIT_BUDGET.limit = 500
    youtube_mcp._throttle.min_interval = 0

    def search(i):
        try:
            youtube_mcp._call("search", {"q": f"fraza{i}", "part": "id", "type": "video"})
            return True
        except Exception:
            return False

    with ThreadPoolExecutor(16) as ex:
        res = list(ex.map(search, range(40)))
    assert sum(res) == 5 and len(calls("search")) == 5 and youtube_mcp.UNIT_BUDGET.used() == 500
    print("OK  limit dzienny atomowy: 32 wątki, 60 rezerwacji = dokładnie 10 przyjętych; 40 równoległych search przy limicie 500 = 5 wywołań do Google")


def test_yt_quota_errors_and_invalid_requests_counted():
    reset_yt(quota_exceeded=True)
    msg = raises_tool_error(youtube_mcp.mcp, "list_channel_videos", channel="@testchan")
    assert "Wyczerpany dzienny limit" in msg and YT_KEY not in msg, msg
    assert youtube_mcp.UNIT_BUDGET.used() == 1, "nieudane zapytanie też kosztuje min. 1 jednostkę"
    reset_yt()
    youtube_mcp.UNIT_BUDGET.limit = 2
    msg = raises_tool_error(youtube_mcp.mcp, "list_channel_videos", channel="@testchan", limit=120)
    assert "Dzienny limit bezpieczeństwa" in msg, msg
    os.environ["YOUTUBE_API_KEY"] = "zly"
    try:
        reset_yt()
        assert "nieprawidłowy" in raises_tool_error(youtube_mcp.mcp, "get_videos", videos=["vid00000001"])
    finally:
        os.environ["YOUTUBE_API_KEY"] = YT_KEY
    print("OK  YT: błąd limitu Google, limit własny, zły klucz, nieudane zapytania liczone jako koszt")


# ------------------------------------------------------------------ atrapa Supadata

class SD:
    log: list = []
    slow_job_done = False
    ok_job_polls = 0
    violations: list = []


def _segs(extra=""):
    return [{"text": "Cześć, to jest hook.", "offset": 0, "duration": 3000, "lang": "pl"},
            {"text": "A to już po hooku." + extra, "offset": 45000, "duration": 4000, "lang": "pl"}]


def sd_handler(request: httpx.Request) -> httpx.Response:
    path, q = request.url.path, dict(request.url.params)
    SD.log.append((path, q))
    if "api-key" in json.dumps(q).lower() or SD_KEY in str(request.url):
        SD.violations.append("klucz w adresie URL")
    if request.headers.get("x-api-key") != SD_KEY:
        return httpx.Response(401, json={"error": "unauthorized", "message": "bad key"})
    if path.endswith("/transcript/job-ok"):
        SD.ok_job_polls += 1
        if SD.ok_job_polls < 2:
            return httpx.Response(200, json={"status": "active"})
        return httpx.Response(200, json={"status": "completed", "content": _segs(" async"), "lang": "pl"})
    if path.endswith("/transcript/job-slow"):
        if SD.slow_job_done:
            return httpx.Response(200, json={"status": "completed", "content": _segs(" slow"), "lang": "pl"})
        return httpx.Response(200, json={"status": "queued"})
    url = q["url"]
    assert q["text"] == "false"
    hdr = {"x-billable-requests": "1"}
    if "AAAAAAAAAAA" in url:
        return httpx.Response(200, headers=hdr, json={"lang": "pl", "availableLangs": ["pl", "en"], "content": _segs()})
    if "BBBBBBBBBBB" in url:
        return httpx.Response(206, headers=hdr, json={"error": "transcript-unavailable", "message": "none"})
    if "CCCCCCCCCCC" in url:
        return httpx.Response(202, json={"jobId": "job-ok"})
    if "EEEEEEEEEEE" in url:
        return httpx.Response(202, json={"jobId": "job-slow"})
    if "FFFFFFFFFFF" in url:
        return httpx.Response(429, headers={"retry-after": "0"}, json={"error": "limit-exceeded", "message": "slow down"})
    if "HHHHHHHHHHH" in url:
        return httpx.Response(403, json={"error": "forbidden", "message": "private"})
    if "/watch?v=G" in url:
        return httpx.Response(200, headers=hdr, json={"lang": "pl", "content": [
            {"text": "słowo " * 3000, "offset": 0, "duration": 5000, "lang": "pl"}]})
    return httpx.Response(404, json={"error": "not-found", "message": "nope"})


def reset_sd():
    fresh_cache()
    SD.log.clear()
    SD.violations.clear()
    SD.slow_job_done = False
    SD.ok_job_polls = 0
    supadata_mcp._http = httpx.Client(transport=httpx.MockTransport(sd_handler))
    supadata_mcp.CREDITS.limit = 300
    supadata_mcp.BATCH_BUDGET = 30
    supadata_mcp.MAX_TOTAL_TEXT = 80_000


def sd_calls():
    return [p for p, _ in SD.log if p.endswith("/transcript")]


# ------------------------------------------------------------------ testy Supadata

def test_sd_hook_cache_and_no_captions():
    reset_sd()
    r = call(supadata_mcp.mcp, "get_transcript", video="https://www.youtube.com/shorts/AAAAAAAAAAA")
    assert r["ok"] and r["hook_text"] == "Cześć, to jest hook." and "po hooku" in r["text"] and r["lang"] == "pl"
    assert r["approx_duration_seconds"] == 49 and r["available_langs"] == ["pl", "en"]
    r = call(supadata_mcp.mcp, "get_transcript", video="AAAAAAAAAAA", hook_seconds=60)
    assert "po hooku" in r["hook_text"] and len(sd_calls()) == 1, "drugie wywołanie z cache, hook liczony lokalnie"
    assert not SD.violations and supadata_mcp.CREDITS.used() == 1
    r = call(supadata_mcp.mcp, "get_transcript", video="BBBBBBBBBBB")
    assert r["ok"] is False and "mode" in r["error"], r
    print("OK  SD: hook z pierwszych sekund, cache (hook liczony lokalnie), brak napisów (206) bez wyjątku, klucz tylko w nagłówku")


def test_sd_async_job_pending_and_resume():
    reset_sd()
    r = call(supadata_mcp.mcp, "get_transcript", video="CCCCCCCCCCC", mode="auto")
    assert r["ok"] and r["hook_text"] == "Cześć, to jest hook." and "async" in r["text"], r
    r = call(supadata_mcp.mcp, "get_transcript", video="EEEEEEEEEEE", mode="auto")
    assert r["ok"] is False and r["pending"] and r["job_id"] == "job-slow", r
    r = call(supadata_mcp.mcp, "get_transcript_job", job_id="job-slow")
    assert r["pending"] is True
    SD.slow_job_done = True
    r = call(supadata_mcp.mcp, "get_transcript_job", job_id="job-slow")
    assert r["ok"] and "slow" in r["text"], r
    n = len(sd_calls())
    r = call(supadata_mcp.mcp, "get_transcript", video="EEEEEEEEEEE", mode="auto")
    assert r["ok"] and len(sd_calls()) == n, "wynik dokończonego zadania ma być w cache"
    print("OK  SD: zadanie asynchroniczne (202), 'pending' zamiast zawieszenia, dokończenie przez get_transcript_job, cache")


def test_sd_batch_errors_fatal_and_budgets():
    reset_sd()
    r = call(supadata_mcp.mcp, "get_transcripts_batch",
             videos=["AAAAAAAAAAA", "BBBBBBBBBBB", "DDDDDDDDDDD", "HHHHHHHHHHH", "zły", "AAAAAAAAAAA"])
    by = {x["video"]: x for x in r["results"]}
    assert r["requested"] == 5 and r["succeeded"] == 1 and r["failed"] == 4, r  # duplikat usunięty
    assert "prywatny" in by["DDDDDDDDDDD"]["error"] or "nie istnieje" in by["DDDDDDDDDDD"]["error"]
    assert "niedostępny publicznie" in by["HHHHHHHHHHH"]["error"]
    # trwały błąd 429 przerywa paczkę zamiast męczyć API pozostałymi filmami
    reset_sd()
    r = call(supadata_mcp.mcp, "get_transcripts_batch", videos=["FFFFFFFFFFF", "AAAAAAAAAAA", "BBBBBBBBBBB"])
    assert r["not_processed"] == ["AAAAAAAAAAA", "BBBBBBBBBBB"] and "limit" in r["stopped"].lower(), r
    assert len([1 for p, q in SD.log if "FFFFFFFFFFF" in q.get("url", "")]) == 4, "max 4 próby"
    # budżet czasu: gotowe (z cache) filmy przechodzą, reszta wraca w not_processed
    reset_sd()
    call(supadata_mcp.mcp, "get_transcript", video="AAAAAAAAAAA")
    supadata_mcp.BATCH_BUDGET = 0
    r = call(supadata_mcp.mcp, "get_transcripts_batch", videos=["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC"])
    assert r["succeeded"] == 1 and r["not_processed"] == ["BBBBBBBBBBB", "CCCCCCCCCCC"] and "hint" in r, r
    # limit kredytów własny
    reset_sd()
    supadata_mcp.CREDITS.limit = 1
    call(supadata_mcp.mcp, "get_transcript", video="AAAAAAAAAAA")
    assert "Dzienny limit bezpieczeństwa" in raises_tool_error(supadata_mcp.mcp, "get_transcript", video="GGGGGGGGGGG")
    r = call(supadata_mcp.mcp, "get_transcripts_batch", videos=["GGGGGGGGGGG", "BBBBBBBBBBB"])
    assert r["not_processed"] == ["GGGGGGGGGGG", "BBBBBBBBBBB"], r
    # zły klucz API -> czytelny błąd i przerwanie
    reset_sd()
    os.environ["SUPADATA_API_KEY"] = "zly"
    try:
        r = call(supadata_mcp.mcp, "get_transcripts_batch", videos=["AAAAAAAAAAA", "BBBBBBBBBBB"])
        assert "SUPADATA_API_KEY" in r["stopped"] and len(r["not_processed"]) == 1, r
    finally:
        os.environ["SUPADATA_API_KEY"] = SD_KEY
    print("OK  SD: błędy per film, przerwanie paczki przy 429/zły klucz (4 próby), budżet czasu, limit kredytów własny")


def test_sd_output_size_limits():
    reset_sd()
    r = call(supadata_mcp.mcp, "get_transcript", video="GGGGGGGGGGG", max_text_chars=500)
    assert r["text_truncated"] is True and len(r["text"]) <= 510
    reset_sd()
    ids = [f"G{n:010d}" for n in range(25)]
    r = call(supadata_mcp.mcp, "get_transcripts_batch", videos=ids, max_text_chars=6000)
    size = len(json.dumps(r, ensure_ascii=False))
    assert size < 120_000, size  # limit Claude.ai: ok. 150 000 znaków
    assert any("text_omitted" in x for x in r["results"]) and all(x["hook_text"] is not None for x in r["results"])
    print(f"OK  SD: przycinanie tekstu i limit rozmiaru odpowiedzi paczki (25 długich filmów = {size} znaków < 150 000)")


# ----------------------------------------------------- sekrety, logi i maskowanie błędów

class Capture(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.records = []

    def emit(self, record):
        self.records.append(record.getMessage() + " " + (self.format(record) if record.exc_info else ""))


def test_no_secrets_in_logs_results_or_errors():
    reset_yt()
    reset_sd()
    cap = Capture()
    root = logging.getLogger()
    root.addHandler(cap)
    old_level = root.level
    root.setLevel(logging.DEBUG)
    # najgorszy przypadek: logowanie żądań httpx włączone na INFO (w produkcji i tak jest WARNING)
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.INFO if name == "httpx" else logging.DEBUG)
    outputs = []
    try:
        outputs.append(call(youtube_mcp.mcp, "list_channel_videos", channel="@testchan", limit=60))
        outputs.append(call(youtube_mcp.mcp, "search_videos", query="x", max_results=10))
        outputs.append(call(supadata_mcp.mcp, "get_transcripts_batch", videos=["AAAAAAAAAAA", "BBBBBBBBBBB", "DDDDDDDDDDD"]))
        outputs.append(raises_tool_error(youtube_mcp.mcp, "get_videos", videos=["xx"]))
        os.environ["YOUTUBE_API_KEY"] = "zly"
        reset_yt()
        outputs.append(raises_tool_error(youtube_mcp.mcp, "get_videos", videos=["vid00000001"]))
        os.environ["YOUTUBE_API_KEY"] = YT_KEY
        reset_yt(quota_exceeded=True)
        outputs.append(raises_tool_error(youtube_mcp.mcp, "get_videos", videos=["vid00000001"]))
    finally:
        os.environ["YOUTUBE_API_KEY"] = YT_KEY
        root.removeHandler(cap)
        root.setLevel(old_level)
        srv.configure_logging()
    blob = json.dumps(outputs, ensure_ascii=False, default=str) + "\n".join(cap.records)
    for marker in (YT_KEY, SD_KEY):
        assert marker not in blob, f"sekret {marker} wyciekł do logów/odpowiedzi"
    # żadnych plików cache z kluczem
    cache_blob = "".join(p.read_text(errors="ignore") for p in common.CACHE_DIR.rglob("*") if p.is_file())
    assert YT_KEY not in cache_blob and SD_KEY not in cache_blob
    print(f"OK  sekrety: brak kluczy w {len(cap.records)} zapisach logów (także httpx na INFO), odpowiedziach, błędach i cache")


def test_unexpected_exceptions_are_masked():
    reset_yt()
    original = youtube_mcp._resolve

    def boom(ref):
        raise RuntimeError("tajny-szczegol-XYZ /home/app/sciezka")

    youtube_mcp._resolve = boom
    try:
        msg = raises_tool_error(srv.build_server(secure=False), "list_channel_videos", channel="@testchan")
    finally:
        youtube_mcp._resolve = original
    assert "tajny-szczegol" not in msg and "/home/app" not in msg, msg
    print("OK  nieprzewidziane wyjątki są maskowane (bez szczegółów i ścieżek), komunikaty ToolError przechodzą")


def test_cache_prune_and_corrupt_cache():
    d = fresh_cache()
    for sub in ("yt", "supadata"):
        (d / sub).mkdir()
    old = d / "yt" / "old.json"
    old.write_text("{}")
    os.utime(old, (time.time() - 40 * 86400,) * 2)
    fresh = d / "supadata" / "new.json"
    fresh.write_text("{}")
    assert common.prune_cache() == 1 and not old.exists() and fresh.exists()
    common.cache_set("yt", {"a": 1}, {"x": 1})
    path = next((d / "yt").glob("*.json"))
    path.write_text("{uszkodzony")
    assert common.cache_get("yt", {"a": 1}, 3600) is None  # uszkodzony plik = brak trafienia, bez wyjątku
    print("OK  cache: czyszczenie starych plików, odporność na uszkodzony plik")


def test_throttle_spacing_under_concurrency():
    from concurrent.futures import ThreadPoolExecutor
    t = common.Throttle(0.05)
    stamps = []
    real = time.sleep
    time.sleep = _real_sleep
    try:
        def hit(_):
            t.wait()
            stamps.append(time.monotonic())
        with ThreadPoolExecutor(8) as ex:
            list(ex.map(hit, range(8)))
    finally:
        time.sleep = real
    gaps = [b - a for a, b in zip(sorted(stamps), sorted(stamps)[1:])]
    assert min(gaps) >= 0.04, gaps
    print("OK  rate limiting: równoległe wywołania zachowują minimalny odstęp między zapytaniami")


if __name__ == "__main__":
    for t in (test_yt_pagination_cost_and_request_shape, test_yt_days_filter_and_fallback,
              test_yt_resolve_variants_and_get_videos, test_yt_search_budget_pagination_and_cache,
              test_yt_search_requires_100_free_units_before_call, test_yt_search_separate_mode,
              test_budget_atomic_under_concurrency,
              test_yt_quota_errors_and_invalid_requests_counted, test_sd_hook_cache_and_no_captions,
              test_sd_async_job_pending_and_resume, test_sd_batch_errors_fatal_and_budgets,
              test_sd_output_size_limits, test_no_secrets_in_logs_results_or_errors,
              test_unexpected_exceptions_are_masked, test_cache_prune_and_corrupt_cache,
              test_throttle_spacing_under_concurrency):
        t()
    print("Wszystkie testy narzędzi przeszły.")
