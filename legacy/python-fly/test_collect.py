"""Testy modułu collect.py: zbieranie N Shortsów z PEŁNYMI transkrypcjami, tryby newest/oldest/most_viewed,
wznawianie, eksport CSV/JSON (6 pól), czytanie partiami i podpisane linki.

Atrapy YouTube i Supadata odtwarzają zasady prawdziwych API (paginacja, prywatne filmy, 206/202/403/429),
ale NIE zastępują prawdziwych usług. Uruchom:  python test_collect.py
"""
import asyncio
import csv
import hashlib
import io
import json
import logging
import os
import threading
import time

import httpx

import test_tools as tt  # ustawia zmienne środowiskowe, podmienia sleep i daje pomocnicze funkcje

os.environ.update({"PUBLIC_BASE_URL": "https://test.example.fly.dev", "JWT_SIGNING_KEY": "k" * 48})

import collect
import common
import server as srv
import supadata_mcp
import youtube_mcp

collect.STEP_SECONDS = 1.0  # krótkie okno oczekiwania na zadania AI w testach

CH_C = "UC" + "c" * 22   # kanał z playlistą shortsów (230 filmów)
CH_D = "UC" + "d" * 22   # kanał bez playlisty UUSH (zapasowa ścieżka)
N_C = 230
UNAVAIL = {5, 77, 150}   # są na playliście, ale videos.list ich nie zwraca (prywatne/usunięte)
NOW = tt.NOW


def vid(prefix, n):
    return f"{prefix}{n:08d}"


def pub(n):
    return (NOW - tt.timedelta(days=n, hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")


def views_c(n):
    return ((n * 97) % 230 + 1) * 100  # unikalne, niepowiązane z datą


def url_of(video_id):
    return f"https://www.youtube.com/shorts/{video_id}"


# ------------------------------------------------------------------------- atrapa YouTube

class YT:
    log: list = []


def seg_texts(n):
    k, per = 8 + n % 7, 150 + (n * 37) % 200
    if n % 10 == 0:
        per = 1100            # ok. 9 000 znaków (> 6000 = stary limit)
    if n == 50:
        k, per = 40, 1100     # ok. 44 000 znaków
    segs = []
    for j in range(k):
        t = f"Film {n} część {j}: „zażółć gęślą jaźń”, \"cytat\", przecinek; średnik… "
        segs.append((t * (per // len(t) + 1))[:per].strip())
    if n % 3 == 0:
        segs[1] = "linia pierwsza\nlinia druga\tz tabulatorem"
    if n % 5 == 0:
        segs.insert(2, "   ")  # pusty segment
    return segs


def expected_text(n):
    return " ".join(s.strip() for s in seg_texts(n) if s.strip())


def yt_handler(request: httpx.Request) -> httpx.Response:
    p = dict(request.url.params)
    ep = request.url.path.rsplit("/", 1)[-1]
    YT.log.append((ep, p))
    if request.headers.get("x-goog-api-key") != tt.YT_KEY or "key" in p:
        return httpx.Response(400, json={"error": {"message": "bad key", "errors": [{"reason": "badRequest"}]}})
    if ep == "channels":
        reg = {"@bigchan": CH_C, CH_C: CH_C, "@nouush": CH_D, CH_D: CH_D}
        cid = reg.get(p.get("forHandle") or p.get("id"))
        if not cid:
            return httpx.Response(200, json={"items": []})
        return httpx.Response(200, json={"items": [{
            "id": cid, "snippet": {"title": "Kanał", "customUrl": p.get("forHandle", "@x")},
            "statistics": {"subscriberCount": "10", "viewCount": "9", "videoCount": "999"},
            "contentDetails": {"relatedPlaylists": {"uploads": "UU" + cid[2:]}}}]})
    if ep == "playlistItems":
        pid = p["playlistId"]
        if pid == "UUSH" + CH_C[2:]:
            ids = [(vid("sho", n), n) for n in range(N_C)]
        elif pid == "UU" + CH_D[2:]:
            ids = [(vid("upl", n), n) for n in range(100)]
        else:
            return httpx.Response(404, json={"error": {"message": "nf", "errors": [{"reason": "playlistNotFound"}]}})
        start = int(p.get("pageToken", "t0")[1:])
        chunk = ids[start:start + 50]
        body = {"items": [{"contentDetails": {"videoId": v, "videoPublishedAt": pub(n)}} for v, n in chunk]}
        if start + 50 < len(ids):
            body["nextPageToken"] = f"t{start + 50}"
        return httpx.Response(200, json=body)
    if ep == "videos":
        if "maxResults" in p or "pageToken" in p:
            return httpx.Response(400, json={"error": {"message": "incompat", "errors": [{"reason": "incompatibleParameters"}]}})
        out = []
        for v in p["id"].split(","):
            n = int(v[3:])
            if v.startswith("sho"):
                if n in UNAVAIL:
                    continue
                dur, views = 20 + n % 40, views_c(n)
            else:
                dur, views = (400 if n % 4 == 3 else 45), 1000 + n
            out.append({"id": v, "snippet": {"title": f"Tytuł {v}, „cudzysłów” \"x\"", "publishedAt": pub(n), "channelTitle": "K",
                                             "thumbnails": {}},
                        "contentDetails": {"duration": f"PT{dur // 60}M{dur % 60}S" if dur >= 60 else f"PT{dur}S"},
                        "statistics": {"viewCount": str(views), "likeCount": "1", "commentCount": "1"}})
        return httpx.Response(200, json={"items": out})
    return httpx.Response(500)


# ---------------------------------------------------------------------- atrapa Supadata

class SD:
    req: dict = {}
    lock_after: int | None = None   # po tylu żądaniach /transcript wszystko zwraca 429
    total = 0
    job_ready = False
    log: list = []


def sd_handler(request: httpx.Request) -> httpx.Response:
    path, q = request.url.path, dict(request.url.params)
    SD.log.append((path, q, str(request.url)))
    if request.headers.get("x-api-key") != tt.SD_KEY:
        return httpx.Response(401, json={"error": "unauthorized", "message": "bad key"})
    if path.endswith("/transcript/jb58"):
        if SD.job_ready:
            return httpx.Response(200, json={"status": "completed", "content": [{"text": s} for s in seg_texts(58)], "lang": "pl"})
        return httpx.Response(200, json={"status": "queued"})
    video = q["url"].split("v=")[1]
    n = int(video[3:])
    SD.total += 1
    SD.req[video] = SD.req.get(video, 0) + 1
    if SD.lock_after is not None and SD.total > SD.lock_after:
        return httpx.Response(429, headers={"retry-after": "0"}, json={"error": "limit-exceeded", "message": "slow"})
    hdr = {"x-billable-requests": "1"}
    if n == 41:
        return httpx.Response(403, json={"error": "forbidden", "message": "private"})
    if n == 58:
        return httpx.Response(202, json={"jobId": "jb58"})
    if n % 13 == 4 and q["mode"] != "auto":
        return httpx.Response(206, headers=hdr, json={"error": "transcript-unavailable", "message": "none"})
    content = [{"text": s, "offset": i * 2000, "duration": 1500, "lang": "pl"} for i, s in enumerate(seg_texts(n))]
    return httpx.Response(200, headers=hdr, json={"lang": "pl", "availableLangs": ["pl"], "content": content})


def reset(credit_limit=100000):
    tt.fresh_cache()
    YT.log.clear()
    SD.req.clear()
    SD.log.clear()
    SD.total, SD.lock_after, SD.job_ready = 0, None, True
    youtube_mcp._http = httpx.Client(transport=httpx.MockTransport(yt_handler))
    supadata_mcp._http = httpx.Client(transport=httpx.MockTransport(sd_handler))
    youtube_mcp.UNIT_BUDGET.limit = 9000
    supadata_mcp.CREDITS.limit = credit_limit
    collect.STEP_MAX_TRANSCRIPTS = 7   # wymusza wiele kroków (testuje wznawianie)
    collect.STEP_SECONDS = 1.0


def run_job(max_calls=400, **args):
    st = tt.call(collect.mcp, "start_collection", **args)
    calls = 1
    while not st["complete"]:
        assert not st.get("stopped_reason"), st
        st = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"])
        calls += 1
        assert calls < max_calls, "pętla continue_collection nie kończy się"
    return st, calls


def valid_c():
    return [n for n in range(N_C) if n not in UNAVAIL]


def expected_order(mode, count):
    v = valid_c()
    if mode == "newest":
        return v[:count]
    if mode == "oldest":
        return sorted(v, reverse=True)[:count]
    return sorted(v, key=lambda n: -views_c(n))[:count]


def exported(job_id):
    d = collect._export_dir(job_id)
    js = json.loads((d / "shorts.json").read_text(encoding="utf-8"))
    cv = list(csv.DictReader(io.StringIO((d / "shorts.csv").read_bytes().decode("utf-8-sig"), newline="")))
    st = json.loads((d / "status.json").read_text(encoding="utf-8"))
    return js, cv, st, d


def expect_status(n):
    if n == 41:
        return "error"
    if n % 13 == 4:
        return "no_captions"
    return "ok"


# ------------------------------------------------------------------------------- testy

def test_modes_and_order():
    for mode in ("newest", "oldest", "most_viewed"):
        reset()
        st, calls = run_job(channel="@bigchan", mode=mode, count=20)
        exp = [vid("sho", n) for n in expected_order(mode, 20)]
        assert [collect._load(st["job_id"])["order"][i] for i in range(20)] == exp, mode
        assert st["selected"] == 20 and st["shortfall"] is None and calls >= 3
        out = tt.call(collect.mcp, "export_collection", job_id=st["job_id"])
        js, cv, status, _ = exported(st["job_id"])
        assert [r["url"] for r in js] == [url_of(v) for v in exp] == [r["url"] for r in cv], mode
        if mode == "most_viewed":
            assert [r["views"] for r in js] == sorted((r["views"] for r in js), reverse=True)
            assert st["enumeration"]["history_complete"] and st["enumeration"]["unavailable_videos"] == 3
        if mode == "oldest":
            assert [r["published_at"] for r in js] == sorted(r["published_at"] for r in js)
        if mode == "newest":
            assert st["enumeration"]["pages"] == 1 and not st["enumeration"]["history_complete"]  # stop po 1 stronie
    print("OK  tryby newest/oldest/most_viewed zwracają dokładnie oczekiwane filmy we właściwej kolejności "
          "(prywatne pominięte, liczone), wiele kroków wznawianych")


def test_100_shorts_complete_no_loss_no_truncation():
    reset()
    st, calls = run_job(channel="@bigchan", mode="newest", count=100)
    out = tt.call(collect.mcp, "export_collection", job_id=st["job_id"])
    js, cv, status, d = exported(st["job_id"])
    exp = expected_order("newest", 100)
    assert len(js) == len(cv) == 100 == out["records_in_each_file"] == status["selected"]
    assert out["verified"] and out["complete"] and status["complete"]
    assert [r["url"] for r in js] == [url_of(vid("sho", n)) for n in exp], "kolejność/utrata rekordów"
    longest = 0
    for rec, row, n in zip(js, cv, exp):
        assert list(rec.keys()) == list(collect.FIELDS) and list(row.keys()) == list(collect.FIELDS)
        assert rec["title"] == f"Tytuł {vid('sho', n)}, „cudzysłów” \"x\""
        assert rec["published_at"] == pub(n) and rec["views"] == views_c(n) and rec["duration_seconds"] == 20 + n % 40
        assert str(rec["views"]) == row["views"] and str(rec["duration_seconds"]) == row["duration_seconds"]
        assert row["title"] == rec["title"] and row["published_at"] == rec["published_at"] and row["url"] == rec["url"]
        s = expect_status(n) if n != 58 else "ok"
        if s == "ok":
            assert rec["transcript"] == expected_text(n), f"transkrypcja n={n} różni się od źródła"
            assert row["transcript"] == expected_text(n), f"CSV: transkrypcja n={n} różni się od źródła"
            longest = max(longest, len(rec["transcript"]))
        else:
            assert rec["transcript"] is None and row["transcript"] == "", n
    assert longest > 40000, "najdłuższa transkrypcja (n=50) musi być zachowana w całości"
    assert any(len(r["transcript"] or "") > 6000 for r in js)
    # status.json: zgodny ze stanem, bez luk
    by_url = {r["url"]: r for r in status["records"]}
    assert len(by_url) == 100
    for rec, n in zip(js, exp):
        sr = by_url[rec["url"]]
        assert sr["status"] == (expect_status(n) if n != 58 else "ok"), (n, sr)
        assert sr["transcript_chars"] == (len(rec["transcript"]) if rec["transcript"] is not None else None)
    c = status["counts"]
    assert c["total"] == 100 and c["ok"] + c["no_captions"] + c["error"] + c["empty"] == 100 and c["pending"] == 0
    assert c["error"] == 1 and c["no_captions"] == sum(1 for n in exp if n % 13 == 4)
    for k in ("csv", "json"):
        assert status["files"][k]["sha256"] == hashlib.sha256((d / f"shorts.{k}").read_bytes()).hexdigest()
        assert status["files"][k]["records"] == 100
    # nikt nie pobierał dwa razy tego samego (brak podwójnego rozliczania kredytów)
    assert all(v == 1 for k, v in SD.req.items() if k != vid("sho", 41)), SD.req
    print(f"OK  100 Shortsów: kompletny plik (CSV i JSON po 100 rekordów, 6 pól), każda transkrypcja identyczna ze źródłem "
          f"(najdłuższa {longest} znaków), {c['no_captions']} bez napisów + 1 błąd oznaczone w status.json, "
          f"{calls} wywołań kroków")


def test_read_collection_pages_reassemble():
    reset()
    st, _ = run_job(channel="@bigchan", mode="newest", count=60)
    exp = expected_order("newest", 60)
    for max_chars in (5000, 12000, 40000):
        cursor, got, pages, oversized = None, {}, 0, 0
        while True:
            page = tt.call(collect.mcp, "read_collection", job_id=st["job_id"], cursor=cursor, max_chars=max_chars)
            pages += 1
            size = len(json.dumps(page["items"], ensure_ascii=False))
            assert size <= max(max_chars, 5000) + 400, (size, max_chars)  # + margines na jeden element z min. kawałkiem
            for it in page["items"]:
                g = got.setdefault(it["url"], {"parts": [], "meta": it})
                if it["transcript"] is not None:
                    assert it["transcript_offset"] == sum(len(x) for x in g["parts"]), "kawałki muszą iść po kolei"
                    g["parts"].append(it["transcript"])
                    assert it["transcript_complete_in_this_item"] == (
                        it["transcript_offset"] + len(it["transcript"]) >= it["transcript_chars_total"])
            cursor = page["next_cursor"]
            if not cursor:
                break
        assert len(got) == 60 == page["total_records"]
        for n in exp:
            g = got[url_of(vid("sho", n))]
            if expect_status(n) == "ok":
                text = "".join(g["parts"])
                assert text == expected_text(n) and len(text) == g["meta"]["transcript_chars_total"], n
            else:
                assert not g["parts"] and g["meta"]["transcript_status"] in ("error", "no_captions", "ok")
        if max_chars == 5000:
            assert pages > 20  # 44 000 znaków musi się rozbić na wiele partii
    print("OK  read_collection: partie ≤ limitu, kawałki z offsetami sklejają się w identyczną transkrypcję "
          "(także 44 000 znaków przy partii 5 000), flagi kompletności poprawne")


def test_resume_after_rate_limit_and_restart():
    reset()
    SD.lock_after = 10
    st = tt.call(collect.mcp, "start_collection", channel="@bigchan", mode="newest", count=30)
    guard = 0
    while not st["stopped_reason"]:
        st = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"])
        guard += 1
        assert guard < 50
    assert "limit" in st["stopped_reason"].lower() and not st["complete"], st
    done_before = {k for k, v in collect._load(st["job_id"])["items"].items() if v["status"] != "pending"}
    assert 0 < len(done_before) <= 10
    # "restart": czyścimy pamięć procesu, stan jest tylko na dysku
    collect._locks.clear()
    SD.lock_after = None
    st = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"])
    guard = 0
    while not st["complete"]:
        st = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"])
        guard += 1
        assert guard < 50, st
    assert st["progress"]["pending"] == 0 and st["progress"]["total"] == 30
    for v in done_before:
        assert SD.req[v] == 1, "film pobrany przed przerwą nie może być pobierany ponownie"
    tt.call(collect.mcp, "export_collection", job_id=st["job_id"])
    js, cv, status, _ = exported(st["job_id"])
    assert len(js) == len(cv) == 30
    print("OK  wznawianie: 429 przerywa krok bez utraty stanu, po restarcie dokończone, pobrane wcześniej filmy nie są pobierane ponownie")


def test_credit_budget_stops_and_resumes():
    reset(credit_limit=5)
    st = tt.call(collect.mcp, "start_collection", channel="@bigchan", mode="newest", count=12)
    st = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"])
    assert "Dzienny limit bezpieczeństwa" in (st["stopped_reason"] or ""), st
    assert st["progress"]["ok"] + st["progress"]["no_captions"] <= 5 and st["selected"] == 12
    out = tt.call(collect.mcp, "export_collection", job_id=st["job_id"])   # eksport częściowy
    assert out["complete"] is False and "CZĘŚCIOWY" in out["warning"] and out["records_in_each_file"] == 12
    assert out["records_without_transcript"] >= 7
    supadata_mcp.CREDITS.limit = 100000
    guard = 0
    while not st["complete"]:
        st = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"])
        guard += 1
        assert guard < 30
    out = tt.call(collect.mcp, "export_collection", job_id=st["job_id"])
    assert out["complete"] and out["records_in_each_file"] == 12
    print("OK  limit kredytów: przerwanie bez utraty, eksport częściowy oznaczony (12 rekordów, braki jako puste), po podniesieniu limitu komplet")


def test_pending_ai_job_and_retry_modes():
    reset()
    SD.job_ready = False
    st = tt.call(collect.mcp, "start_collection", channel="@bigchan", mode="newest", count=70)
    guard = 0
    while st["progress"]["pending"] > 0 and guard < 40:
        st = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"])
        guard += 1
    assert st["progress"]["pending_ai"] == 1 and not st["complete"], st["progress"]   # n=58 czeka na AI
    SD.job_ready = True
    st = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"])
    assert st["complete"] and st["progress"]["pending_ai"] == 0, st
    exp = expected_order("newest", 70)
    job = collect._load(st["job_id"])
    assert job["items"][vid("sho", 58)]["status"] == "ok"
    # ponowienie: error nadal błąd (403), no_captions -> auto generuje transkrypcję
    n_nc = st["progress"]["no_captions"]
    assert n_nc > 0
    st = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"], retry_failed=True)
    assert st["progress"]["error"] == 1 and st["progress"]["no_captions"] == n_nc
    st = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"], transcript_mode="auto")
    guard = 0
    while not st["complete"]:
        st = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"])
        guard += 1
        assert guard < 40
    assert st["progress"]["no_captions"] == 0 and st["progress"]["error"] == 1
    tt.call(collect.mcp, "export_collection", job_id=st["job_id"])
    js, cv, status, _ = exported(st["job_id"])
    byurl = {r["url"]: r for r in js}
    for n in exp:
        rec = byurl[url_of(vid("sho", n))]
        if n == 41:
            assert rec["transcript"] is None
        else:
            assert rec["transcript"] == expected_text(n), n
    print("OK  zadanie AI (202): status pending_ai, dokończone po gotowości; retry_failed i transcript_mode=auto "
          "ponawiają tylko wskazane filmy; 403 pozostaje błędem (bez zmyślania)")


def test_shortfall_fallback_and_validation():
    reset()
    st, _ = run_job(channel="@nouush", mode="most_viewed", count=100)
    assert st["enumeration"]["source"] == "uploads_filtered_by_duration"
    assert st["selected"] == 75 and st["shortfall"] == {"requested": 100, "available": 75}, st
    assert st["enumeration"]["excluded_as_not_short"] == 25 and st["enumeration"]["history_complete"]
    out = tt.call(collect.mcp, "export_collection", job_id=st["job_id"])
    assert out["records_in_each_file"] == 75 and out["shortfall"]["available"] == 75
    js, _, _, _ = exported(st["job_id"])
    assert all(r["duration_seconds"] <= 180 for r in js)
    assert "count" in tt.raises_tool_error(collect.mcp, "start_collection", channel="@bigchan", count=0)
    assert "count" in tt.raises_tool_error(collect.mcp, "start_collection", channel="@bigchan", count=100000)
    for bad in ("../x", "c-short", "c-" + "!" * 22):
        assert "job_id" in tt.raises_tool_error(collect.mcp, "get_collection_status", job_id=bad)
    assert "Nie ma takiego zadania" in tt.raises_tool_error(collect.mcp, "get_collection_status", job_id="c-" + "A" * 22)
    print("OK  mniej Shortsów niż prosisz: jawny shortfall (75 z 100), zapasowa ścieżka bez UUSH odfiltrowuje filmy >3 min, "
          "walidacja count i job_id")


def test_concurrent_continue_no_double_fetch():
    reset()
    st = tt.call(collect.mcp, "start_collection", channel="@bigchan", mode="newest", count=40)
    results = []

    def go():
        results.append(tt.call(collect.mcp, "continue_collection", job_id=st["job_id"]))

    threads = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    guard = 0
    cur = results[-1]
    while not cur["complete"]:
        cur = tt.call(collect.mcp, "continue_collection", job_id=st["job_id"])
        guard += 1
        assert guard < 30
    assert all(v == 1 for k, v in SD.req.items() if k != vid("sho", 41)), "równoległe wywołania pobrały film dwa razy"
    print("OK  6 równoległych continue_collection tego samego zadania: żaden film nie został pobrany dwa razy")


def test_signed_download_links():
    reset()
    st, _ = run_job(channel="@bigchan", mode="oldest", count=15)
    out = tt.call(collect.mcp, "export_collection", job_id=st["job_id"])
    assert all(out["links"][k].startswith("https://test.example.fly.dev/exports/") for k in ("csv", "json", "status"))
    app = srv.build_app(secure=False)

    async def fetch(url):
        path = url.replace("https://test.example.fly.dev", "")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test.example.fly.dev") as c:
            return await c.get(path)

    def get(url):
        return asyncio.run(fetch(url))

    d = collect._export_dir(st["job_id"])
    r = get(out["links"]["csv"])
    assert r.status_code == 200 and r.content == (d / "shorts.csv").read_bytes() and "attachment" in r.headers["content-disposition"]
    assert r.headers["cache-control"] == "no-store"
    assert get(out["links"]["json"]).content == (d / "shorts.json").read_bytes()
    assert get(out["links"]["status"]).status_code == 200
    base = out["links"]["csv"]
    assert get(base[:-3] + "000").status_code == 403, "zmieniony podpis"
    assert get(base.replace("/csv?", "/json?")).status_code == 403, "podpis dla innego formatu"
    jid = st["job_id"]
    other = "c-" + "B" * 22
    assert get(base.replace(jid, other)).status_code == 403, "podpis dla innego zadania"
    past = int(time.time()) - 5
    expired = f"https://test.example.fly.dev/exports/{jid}/csv?e={past}&s={collect._sign(jid, 'csv', past)}"
    assert get(expired).status_code == 403, "wygasły link"
    assert get(f"https://test.example.fly.dev/exports/{jid}/csv").status_code == 403, "brak podpisu"
    assert get(f"https://test.example.fly.dev/exports/..%2f..%2fetc/csv?e=1&s=x").status_code in (403, 404)
    assert get(f"https://test.example.fly.dev/exports/{jid}/state.json?e=9999999999&s=x").status_code == 403
    fut = int(time.time()) + 600
    st2 = tt.call(collect.mcp, "start_collection", channel="@bigchan", mode="newest", count=3)
    nofile = f"https://test.example.fly.dev/exports/{st2['job_id']}/csv?e={fut}&s={collect._sign(st2['job_id'], 'csv', fut)}"
    assert get(nofile).status_code == 404
    print("OK  podpisane linki: poprawny plik identyczny z dyskiem; zły podpis/format/zadanie, wygasły, brak podpisu, "
          "ścieżka spoza listy -> 403; brak eksportu -> 404")


def test_no_secrets_anywhere():
    reset()

    class Cap(logging.Handler):
        def __init__(self):
            super().__init__(logging.DEBUG)
            self.msgs = []

        def emit(self, record):
            self.msgs.append(record.getMessage())

    cap = Cap()
    root = logging.getLogger()
    root.addHandler(cap)
    old = root.level
    root.setLevel(logging.DEBUG)
    logging.getLogger("httpx").setLevel(logging.INFO)
    try:
        st, _ = run_job(channel="@bigchan", mode="most_viewed", count=25)
        out = tt.call(collect.mcp, "export_collection", job_id=st["job_id"])
        page = tt.call(collect.mcp, "read_collection", job_id=st["job_id"])
    finally:
        root.removeHandler(cap)
        root.setLevel(old)
        srv.configure_logging()
    blob = json.dumps([st, out, page], ensure_ascii=False) + "\n".join(cap.msgs)
    files = "".join(p.read_bytes().decode("utf-8", "ignore") for p in collect._job_dir(st["job_id"]).rglob("*") if p.is_file())
    for marker in (tt.YT_KEY, tt.SD_KEY, "k" * 48):
        assert marker not in blob and marker not in files, f"sekret {marker[:6]}… wyciekł"
    assert not any(tt.SD_KEY in u for _, _, u in SD.log), "klucz Supadata w adresie URL"
    print("OK  sekrety: brak kluczy w odpowiedziach narzędzi, logach, plikach zadania i eksporcie")


def test_prune_jobs():
    reset()
    st, _ = run_job(channel="@bigchan", mode="newest", count=3)
    d = collect._job_dir(st["job_id"])
    old = time.time() - 40 * 86400
    for p in [d, *d.rglob("*")]:
        os.utime(p, (old, old))
    assert collect.prune_jobs() == 1 and not d.exists()
    print("OK  stare zadania (>30 dni) są sprzątane, świeże zostają")


if __name__ == "__main__":
    for t in (test_modes_and_order, test_100_shorts_complete_no_loss_no_truncation, test_read_collection_pages_reassemble,
              test_resume_after_rate_limit_and_restart, test_credit_budget_stops_and_resumes,
              test_pending_ai_job_and_retry_modes, test_shortfall_fallback_and_validation,
              test_concurrent_continue_no_double_fetch, test_signed_download_links, test_no_secrets_anywhere,
              test_prune_jobs):
        t()
    print("Wszystkie testy zbierania przeszły.")
