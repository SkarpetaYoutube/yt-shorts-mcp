import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { buildWorld, installFetch, stub, drive, runExport, resetStore, chunkSegments, expectedText, mockComments, rej, type World } from "./helpers";
import { COLUMNS, clock, parseCsv } from "../src/csv";

let w: World;
const start = (count: number, mode: any = "newest", extra: Record<string, unknown> = {}) =>
  stub().startJob({ channel: "@przyklad", mode, count, transcriptMode: "native", lang: null, ...extra });
const files = async (job: string) => ({
  csv: (await stub().exportChunks(job, "csv")).join("") as string,
  json: (await stub().exportChunks(job, "json")).join("") as string,
  status: JSON.parse((await stub().exportChunks(job, "status")).join("")),
});
const byUrl = (rows: any[], id: string) => rows.find((r: any) => r.url.endsWith(id));
const sql = async (q: string, ...args: unknown[]) =>
  (runInDurableObject as any)(stub(), (inst: any) => inst.ctx.storage.sql.exec(q, ...args).toArray());

beforeEach(async () => { await resetStore(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("transkrypcja ze znacznikami czasu", () => {
  beforeEach(() => { w = buildWorld(60, { none: [2] }); installFetch(w); });
  it("segmenty składają się dokładnie w transcript, czasy w sekundach z offset/duration Supadata", async () => {
    const { job_id } = await start(8);
    expect((await drive(job_id)).complete).toBe(true);
    await runExport(job_id);
    const f = await files(job_id);
    const rows = JSON.parse(f.json);
    for (const v of w.videos.slice(0, 8)) {
      const r = byUrl(rows, v.id);
      if (v.tr === "none") { expect(r.transcript_timed).toBeNull(); continue; }
      const segs = chunkSegments(v.text);
      expect(r.transcript_timed.map((x: any) => x.text).join(" ")).toBe(r.transcript);
      expect(r.transcript).toBe(expectedText(v.text));
      expect(r.transcript_timed[1].start_s).toBe(segs[1].offset / 1000);
      expect(r.transcript_timed[1].end_s).toBe((segs[1].offset + segs[1].duration) / 1000);
    }
    // CSV: kolumna transcript_timed ma linie "[m:ss.s] tekst"
    const grid = parseCsv(f.csv.replace(/^﻿/, ""));
    const ti = COLUMNS.indexOf("transcript_timed");
    const line0 = grid[1][ti].split("\n")[0];
    expect(line0).toMatch(/^\[0:00\.0\] /);
    expect(f.status.records.filter((r: any) => r.transcript_timed).length).toBe(7);
  });
  it("format czasu", () => {
    expect(clock(0)).toBe("0:00.0");
    expect(clock(59.96)).toBe("1:00.0");
    expect(clock(65.34)).toBe("1:05.3");
    expect(clock(null)).toBe("?");
  });
});

describe("polubienia i komentarze", () => {
  beforeEach(() => { w = buildWorld(60); installFetch(w); });
  it("likes/comments_count z YouTube; komentarze w kolejności trafności (nie wg polubień); wyłączone = null", async () => {
    const { job_id } = await start(20);
    const st = await drive(job_id);
    expect(st.complete).toBe(true);
    expect(st.comments.fetched + st.comments.disabled).toBe(20);
    expect(st.comments.disabled).toBe(2); // indeksy 0 i 17
    expect(w.calls.comments).toBe(20); // 1 zapytanie (1 jednostka) na film
    await runExport(job_id);
    const f = await files(job_id);
    const rows = JSON.parse(f.json);
    const v1 = w.videos[1];
    const r1 = byUrl(rows, v1.id);
    expect(r1.likes).toBe(v1.likes);
    expect(r1.comments_count).toBe(v1.comments);
    expect(r1.top_comments_relevance).toEqual(mockComments(v1));
    expect(r1.top_comments_relevance.map((c: any) => c.likes)).toEqual([3, 50, 7, 1, 20]); // kolejność YouTube zachowana
    const r0 = byUrl(rows, w.videos[0].id);
    expect(r0.likes).toBeNull(); // ukryte polubienia: null, nie 0
    expect(r0.top_comments_relevance).toBeNull();
    expect(f.status.records.find((r: any) => r.video_id === w.videos[0].id).comments_status).toBe("disabled");
    expect(f.status.definitions.top_comments_relevance).toMatch(/nie posortowane wg polubień/);
    const grid = parseCsv(f.csv.replace(/^﻿/, ""));
    const ci = COLUMNS.indexOf("top_comments_relevance");
    const cell = grid.slice(1).find((row) => row[4].endsWith(v1.id))![ci];
    expect(cell.startsWith("1. (3 polubień) Komentarz 1")).toBe(true);
  });
  it("comments=false: zero zapytań o komentarze, pola puste", async () => {
    const { job_id } = await start(5, "newest", { comments: false });
    await drive(job_id);
    expect(w.calls.comments).toBe(0);
    await runExport(job_id);
    const rows = JSON.parse((await files(job_id)).json);
    expect(rows.every((r: any) => r.top_comments_relevance === null)).toBe(true);
  });
  it("limit YouTube w trakcie komentarzy: transkrypcje zostają, wznowienie dociąga komentarze", async () => {
    let block = true;
    w.ytFail = (u) => (block && u.pathname.endsWith("/commentThreads") ? new Response(JSON.stringify({ error: { message: "q", errors: [{ reason: "quotaExceeded" }] } }), { status: 403 }) : null);
    const { job_id } = await start(6);
    const st = await drive(job_id);
    expect(st.running).toBe(false);
    expect(st.complete).toBe(false);
    expect(st.stopped_reason).toMatch(/limit YouTube/);
    const sdBefore = w.calls.sd;
    block = false;
    await stub().resume(job_id, {});
    const st2 = await drive(job_id);
    expect(st2.complete).toBe(true);
    expect(st2.comments.not_fetched).toBe(0);
    expect(w.calls.sd).toBe(sdBefore); // transkrypcji nie pobierano drugi raz
  });
});

describe("norma kanału, ranking, sortowanie", () => {
  beforeEach(() => { w = buildWorld(120, { unavailable: [5] }); installFetch(w); });
  it("newest + channel_stats: cała historia, mediana/p95/pozycja zgodne z danymi", async () => {
    const { job_id } = await start(10);
    const st = await drive(job_id);
    expect(st.enumeration.history_complete).toBe(true);
    const views = w.videos.filter((v) => !v.unavailable && v.views != null).map((v) => v.views!).sort((a, b) => a - b);
    const n = views.length;
    const median = n % 2 ? views[(n - 1) / 2] : (views[n / 2 - 1] + views[n / 2]) / 2;
    const p95 = views[Math.ceil(0.95 * n) - 1];
    expect(st.channel_baseline.shorts_with_views).toBe(n);
    expect(st.channel_baseline.median_views).toBe(median);
    expect(st.channel_baseline.p95_views).toBe(p95);
    await runExport(job_id);
    const rows = JSON.parse((await files(job_id)).json);
    for (const r of rows) {
      if (r.views == null) { expect(r.channel_views_rank).toBeNull(); expect(r.top_5_percent_channel).toBeNull(); continue; }
      expect(r.channel_views_rank).toBe(views.filter((x) => x > r.views).length + 1);
      expect(r.channel_shorts_ranked).toBe(n);
      expect(r.top_5_percent_channel).toBe(views.filter((x) => x > r.views).length + 1 <= Math.max(1, Math.floor(0.05 * n)));
      void p95;
      expect(r.above_channel_norm).toBe(r.views >= 2 * median);
      expect(r.views_vs_channel_median).toBe(Math.round((r.views / median) * 100) / 100);
    }
  });
  it("channel_stats=false przy newest: krótkie wyliczenie, flagi kanału null", async () => {
    const { job_id } = await start(10, "newest", { channel_stats: false, channelStats: false });
    const st = await drive(job_id);
    expect(st.enumeration.pages).toBe(1);
    expect(st.channel_baseline).toBeNull();
    await runExport(job_id);
    const rows = JSON.parse((await files(job_id)).json);
    expect(rows.every((r: any) => r.top_5_percent_channel === null && r.channel_views_rank === null)).toBe(true);
  });
  it("sortowanie eksportu po views (malejąco/rosnąco, brak danych na końcu) i powrót do kolejności wyboru", async () => {
    const exportWith = async (job: string, sort: string) => {
      await stub().startExport(job, false, sort);
      for (let i = 0; i < 100; i++) {
        const info = await stub().exportInfo(job);
        if (!["selecting", "ordering", "building"].includes(info.phase)) return info;
        await runDurableObjectAlarm(stub());
      }
      throw new Error("eksport nie skończył się");
    };
    const { job_id } = await start(30);
    await drive(job_id);
    await exportWith(job_id, "selection");
    const sel = JSON.parse((await files(job_id)).json).map((r: any) => r.url);
    await exportWith(job_id, "views_desc");
    const f = await files(job_id);
    const dv = JSON.parse(f.json).map((r: any) => r.views);
    const nn = dv.filter((x: any) => x != null);
    expect(nn.length).toBeGreaterThan(20);
    expect(nn).toEqual([...nn].sort((a: number, b: number) => b - a));
    expect(dv.slice(nn.length).every((x: any) => x == null)).toBe(true);
    expect(f.status.sort).toBe("views_desc");
    await exportWith(job_id, "views_asc");
    const asc = JSON.parse((await files(job_id)).json).map((r: any) => r.views).filter((x: any) => x != null);
    expect(asc).toEqual([...asc].sort((a: number, b: number) => a - b));
    await exportWith(job_id, "selection");
    expect(JSON.parse((await files(job_id)).json).map((r: any) => r.url)).toEqual(sel);
    await expect(rej(stub().startExport(job_id, false, "zle"))).rejects.toThrow(/sort/);
  });
});

describe("historia pomiarów i przyrost", () => {
  beforeEach(() => { w = buildWorld(40); installFetch(w); });
  it("pierwszy pomiar: brak przyrostu; drugi (po > 1 h): przyrost i tempo na dobę", async () => {
    const a = await start(5);
    await drive(a.job_id);
    await runExport(a.job_id);
    const first = JSON.parse((await files(a.job_id)).json);
    expect(first.every((r: any) => r.views_prev === null && r.views_gain === null)).toBe(true);
    // cofnij pierwszy pomiar o 2 dni i zmień wyświetlenia w „świecie”
    await sql("UPDATE snaps SET at = at - ?", 2 * 86400_000);
    const v = w.videos[1];
    const before = v.views!;
    v.views = before + 1000;
    const b = await start(5);
    await drive(b.job_id);
    await runExport(b.job_id);
    const r = byUrl(JSON.parse((await files(b.job_id)).json), v.id);
    expect(r.views).toBe(before + 1000);
    expect(r.views_prev).toBe(before);
    expect(r.views_gain).toBe(1000);
    expect(r.views_gain_per_day).toBeGreaterThan(450);
    expect(r.views_gain_per_day).toBeLessThan(550);
    expect(Date.parse(r.views_prev_at)).toBeLessThan(Date.now() - 86400_000);
  });
  it("powtórka w ciągu godziny nie tworzy nowego pomiaru i nie pokazuje fałszywego przyrostu", async () => {
    const a = await start(5);
    await drive(a.job_id);
    const n1 = (await sql("SELECT COUNT(*) AS n FROM snaps"))[0].n;
    const b = await start(5);
    await drive(b.job_id);
    expect((await sql("SELECT COUNT(*) AS n FROM snaps"))[0].n).toBe(n1);
    await runExport(b.job_id);
    expect(JSON.parse((await files(b.job_id)).json).every((r: any) => r.views_gain === null)).toBe(true);
  });
});

describe("zgodność wstecz", () => {
  beforeEach(() => { w = buildWorld(30); installFetch(w); });
  it("zadanie sprzed rozbudowy (bez opts): eksport działa, nowe pola puste, bez komentarzy", async () => {
    const { job_id } = await start(4);
    await drive(job_id);
    await (runInDurableObject as any)(stub(), (inst: any) => {
      const s = inst.ctx.storage.sql;
      const job = JSON.parse(String(s.exec("SELECT state FROM jobs WHERE id=?", job_id).one().state));
      delete job.opts; delete job.baseline;
      s.exec("UPDATE jobs SET state=? WHERE id=?", JSON.stringify(job), job_id);
      s.exec("UPDATE items SET likes=NULL, ccount=NULL, mat=NULL, crank=NULL, segs=NULL, cmts=NULL, cstat=NULL WHERE job=?", job_id);
    });
    const info = await runExport(job_id);
    expect(info.phase).toBe("ready");
    const rows = JSON.parse((await files(job_id)).json);
    expect(rows).toHaveLength(4);
    expect(rows.every((r: any) => r.transcript && r.transcript_timed === null && r.likes === null)).toBe(true);
    const st = await stub().status(job_id);
    expect(st.comments).toBeNull();
  });
  it("uszkodzone segmenty czasowe są wykrywane", async () => {
    const { job_id } = await start(3);
    await drive(job_id);
    await sql("UPDATE items SET segs = '[[0,1,\"inny tekst\"]]' WHERE job=? AND ord=1", job_id);
    const info = await runExport(job_id);
    expect(info.phase).toBe("failed");
    expect(info.error).toMatch(/segmentów czasowych/);
  });
});

describe("trwałość danych: migracja schematu i restart", () => {
  beforeEach(() => { w = buildWorld(30); installFetch(w); });
  it("baza z wersji 1: migracja dodaje kolumny bez utraty danych, jest idempotentna, wydłuża cache transkrypcji raz", async () => {
    const { migrate } = await import("../src/store");
    const now = Date.now();
    const res = await (runInDurableObject as any)(stub(), (inst: any) => {
      const s = inst.ctx.storage.sql;
      // odtworzenie schematu i danych z wersji 1
      for (const t of ["items", "cands", "snaps", "meta"]) s.exec(`DROP TABLE IF EXISTS ${t}`);
      s.exec(`CREATE TABLE cands (job TEXT NOT NULL, vid TEXT NOT NULL, title TEXT NOT NULL, dur INTEGER NOT NULL, pub TEXT NOT NULL, ts INTEGER NOT NULL, views INTEGER, PRIMARY KEY(job, vid))`);
      s.exec(`CREATE TABLE items (job TEXT NOT NULL, vid TEXT NOT NULL, ord INTEGER NOT NULL, title TEXT NOT NULL, dur INTEGER NOT NULL, pub TEXT NOT NULL, views INTEGER, url TEXT NOT NULL, status TEXT NOT NULL, err TEXT, sjob TEXT, transcript TEXT, chars INTEGER, hash TEXT, PRIMARY KEY(job, vid))`);
      const job = { id: "c-aaaaaaaaaaaaaaaaaaaaaaaa", created: now, updated: now, phase: "done", running: false, channel: { channel_id: "UCx", title: "Stary", handle: null, video_count: 1 }, mode: "newest", count: 1, transcriptMode: "native", lang: null,
        enum: { source: "shorts_playlist", playlistId: "x", uploadsPlaylist: "y", pageToken: null, pages: 1, finished: true, historyComplete: false, historyCapped: false, unavailable: 0, excludedLong: 0, seen: 1 }, shortfall: null, stoppedReason: null, export: null };
      s.exec("INSERT INTO jobs(id, state, created, updated) VALUES(?,?,?,?)", job.id, JSON.stringify(job), now, now);
      s.exec("INSERT INTO items(job, vid, ord, title, dur, pub, views, url, status, transcript, chars, hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        job.id, "abcdefghijk", 0, "Stary tytuł", 30, "2026-01-01T00:00:00Z", 123, "https://www.youtube.com/shorts/abcdefghijk", "ok", "stary transkrypt", 16, "h");
      s.exec("INSERT INTO cache(k, v, exp) VALUES(?,?,?)", "tx:native::https://www.youtube.com/watch?v=abcdefghijk", '{"content":[]}', now + 10 * 86400_000);
      s.exec("INSERT INTO cache(k, v, exp) VALUES(?,?,?)", "ch:inne", "{}", now + 1000);
      migrate(s);
      migrate(s); // drugi raz: bez błędów i bez ponownego wydłużania
      const cols = s.exec("PRAGMA table_info(items)").toArray().map((r: any) => r.name);
      return {
        cols,
        item: s.exec("SELECT title, transcript, views FROM items").one(),
        tx: Number(s.exec("SELECT exp FROM cache WHERE k LIKE 'tx:%'").one().exp),
        ch: Number(s.exec("SELECT exp FROM cache WHERE k='ch:inne'").one().exp),
        ver: s.exec("SELECT v FROM meta WHERE k='schema'").one().v,
        jobs: Number(s.exec("SELECT COUNT(*) AS n FROM jobs").one().n),
      };
    });
    expect(res.cols).toEqual(expect.arrayContaining(["transcript", "likes", "segs", "cmts", "cstat", "crank", "mat"]));
    expect(res.item).toEqual({ title: "Stary tytuł", transcript: "stary transkrypt", views: 123 });
    expect(res.tx).toBe(now + 10 * 86400_000 + 335 * 86400_000);
    expect(res.ch).toBe(now + 1000); // inne wpisy cache bez zmian
    expect(res.ver).toBe(String((await import("../src/store")).SCHEMA_VERSION));
    expect(res.jobs).toBe(1);
    const info = await runExport("c-aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(info.phase).toBe("ready");
    const rows = JSON.parse((await files("c-aaaaaaaaaaaaaaaaaaaaaaaa")).json);
    expect(rows[0].transcript).toBe("stary transkrypt");
    expect(rows[0].likes).toBeNull();
  });
  it("restart Durable Object: transkrypcje, pomiary i zadania zostają; ponowne pobranie nie płaci Supadata", async () => {
    const a = await start(6);
    await drive(a.job_id);
    const snaps = (await sql("SELECT COUNT(*) AS n FROM snaps"))[0].n;
    const sdCalls = w.calls.sd;
    await evictDurableObject(stub());
    expect((await sql("SELECT COUNT(*) AS n FROM snaps"))[0].n).toBe(snaps);
    expect((await stub().status(a.job_id)).complete).toBe(true);
    const b = await start(6);
    expect((await drive(b.job_id)).complete).toBe(true);
    expect(w.calls.sd).toBe(sdCalls);
    expect((await stub().usage()).supadata_credits_today).toBe(6);
  });
  it("nowe transkrypcje dostają ważność 365 dni", async () => {
    const { job_id } = await start(1);
    await drive(job_id);
    const exp = Number((await sql("SELECT exp FROM cache WHERE k LIKE 'tx:%'"))[0].exp);
    expect(exp - Date.now()).toBeGreaterThan(364 * 86400_000);
  });
});

describe("norma kanału: mediana 0 i mała liczba rolek", () => {
  const exportRows = async (job: string) => { await runExport(job); return JSON.parse((await files(job)).json); };
  it("mediana 0: norma i krotność mediany null, z wyjaśnieniem; ranking dalej działa", async () => {
    w = buildWorld(30); for (const v of w.videos) v.views = v.views == null ? null : 0; w.videos[3].views = 500; installFetch(w);
    const { job_id } = await start(5, "most_viewed");
    const st = await drive(job_id);
    expect(st.channel_baseline.median_views).toBe(0);
    expect(st.channel_baseline.norm_usable).toBe(false);
    expect(st.channel_baseline.notes.join(" ")).toMatch(/Mediana wyświetleń kanału wynosi 0/);
    const rows = await exportRows(job_id);
    expect(rows.every((r: any) => r.above_channel_norm === null && r.views_vs_channel_median === null)).toBe(true);
    expect(rows[0].views).toBe(500);
    expect(rows[0].channel_views_rank).toBe(1);
    expect(rows[0].top_5_percent_channel).toBe(true);
    expect(rows.slice(1).every((r: any) => r.views !== 0 || r.top_5_percent_channel === false)).toBe(true); // zera nie są „TOP 5%”
  });
  it("8 rolek: norma liczona, TOP 5% nie (za mała próba)", async () => {
    w = buildWorld(8); for (const v of w.videos) v.views ??= 10; installFetch(w);
    const { job_id } = await start(8, "most_viewed");
    const st = await drive(job_id);
    expect(st.channel_baseline.top5_usable).toBe(false);
    expect(st.channel_baseline.norm_usable).toBe(true);
    const rows = await exportRows(job_id);
    expect(rows.every((r: any) => r.top_5_percent_channel === null)).toBe(true);
    expect(rows.every((r: any) => typeof r.above_channel_norm === "boolean")).toBe(true);
  });
  it("3 rolki: ani normy, ani TOP 5%; same wyświetlenia i pozycja", async () => {
    w = buildWorld(3); for (const v of w.videos) v.views ??= 10; installFetch(w);
    const { job_id } = await start(3, "newest");
    const st = await drive(job_id);
    expect(st.channel_baseline.notes.join(" ")).toMatch(/Za mało Shortsów/);
    const rows = await exportRows(job_id);
    expect(rows.every((r: any) => r.top_5_percent_channel === null && r.above_channel_norm === null && r.channel_views_rank != null)).toBe(true);
  });
  it("status.json zawiera zastrzeżenie o wieku publikacji", async () => {
    w = buildWorld(30); installFetch(w);
    const { job_id } = await start(3);
    await drive(job_id);
    await runExport(job_id);
    expect((await files(job_id)).status.definitions.age_caveat).toMatch(/NIE uwzględniają wieku publikacji/);
  });
});
