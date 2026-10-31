import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runDurableObjectAlarm, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { buildWorld, installFetch, stub, drive, runExport, setEnv, expectedText, resetStore, rej, type World, makeText, CHANNEL_ID } from "./helpers";
import { COLUMNS, CSV_COLUMNS, parseCsv } from "../src/csv";

const FIELDS = [...COLUMNS]; // pola JSON
const CSV_FIELDS = [...CSV_COLUMNS]; // kolumny CSV: pola JSON + vision_json, vision_json_chars
let w: World;
const start = (count: number, mode: any = "newest", tm: any = "native") => stub().startJob({ channel: "@przyklad", mode, count, transcriptMode: tm, lang: null });
const files = async (job: string) => ({
  csv: (await stub().exportChunks(job, "csv")).join("") as string,
  json: (await stub().exportChunks(job, "json")).join("") as string,
  status: JSON.parse((await stub().exportChunks(job, "status")).join("")),
});
const expectedOrder = (mode: string, n: number) => {
  const avail = w.videos.filter((v) => !v.unavailable);
  const key = (v: any) => Date.parse(v.pub);
  const sorted = [...avail].sort((a, b) =>
    mode === "newest" ? key(b) - key(a) || (a.id < b.id ? -1 : 1) : mode === "oldest" ? key(a) - key(b) || (a.id < b.id ? -1 : 1) : (b.views ?? 0) - (a.views ?? 0) || key(b) - key(a) || (a.id < b.id ? -1 : 1));
  return sorted.slice(0, n);
};

beforeEach(async () => { await resetStore(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("tryby sortowania (atrapy API)", () => {
  beforeEach(async () => { w = buildWorld(230, { unavailable: [3, 77, 150] }); installFetch(w); });
  for (const mode of ["newest", "oldest", "most_viewed"] as const) {
    it(`${mode}: 25 rekordów we właściwej kolejności, bez duplikatów`, async () => {
      const s = stub();
      const { job_id } = await start(25, mode);
      const st = await drive(job_id);
      expect(st.complete).toBe(true);
      expect(st.progress.total).toBe(25);
      await runExport(job_id);
      const f = await files(job_id);
      const rows = JSON.parse(f.json);
      expect(rows.map((r: any) => r.url)).toEqual(expectedOrder(mode, 25).map((v) => `https://www.youtube.com/shorts/${v.id}`));
      expect(new Set(rows.map((r: any) => r.url)).size).toBe(25);
      void s;
    });
  }
  it("most_viewed: filmy bez liczby wyświetleń trafiają na koniec, views=null (nic nie wymyślone)", async () => {
    const { job_id } = await start(230, "most_viewed");
    const st = await drive(job_id);
    expect(st.progress.total).toBe(227);
    expect(st.enumeration.unavailable_videos).toBe(3);
    await runExport(job_id);
    const rows = JSON.parse((await files(job_id)).json);
    const nulls = rows.filter((r: any) => r.views === null).length;
    expect(nulls).toBeGreaterThan(0);
    expect(rows.slice(-nulls).every((r: any) => r.views === null)).toBe(true);
  });
  it("prosi o więcej niż jest: shortfall jawnie, bez zmyślania", async () => {
    const { job_id } = await start(500, "newest");
    const st = await drive(job_id);
    expect(st.complete).toBe(true);
    expect(st.progress.total).toBe(227);
    expect(st.shortfall).toEqual({ requested: 500, available: 227 });
  });
});

describe("100 Shortsów, długie transkrypcje, integralność", () => {
  beforeEach(async () => {
    w = buildWorld(230, { unavailable: [3, 77, 150], long: { 5: 44000, 9: 9000, 40: 25000 }, none: [12, 60], empty: [20] });
    installFetch(w);
  });
  it("100 najnowszych: CSV i JSON zgodne z danymi źródłowymi co do znaku", async () => {
    const { job_id } = await start(100);
    const st = await drive(job_id);
    expect(st.complete).toBe(true);
    expect(st.progress.total).toBe(100);
    expect(st.progress.no_captions).toBe(2);
    expect(st.progress.empty).toBe(1);
    const info = await runExport(job_id);
    expect(info.phase).toBe("ready");
    const f = await files(job_id);
    const exp = expectedOrder("newest", 100);

    // JSON
    const rows = JSON.parse(f.json);
    expect(rows).toHaveLength(100);
    // CSV (niezależny parser)
    const grid = parseCsv(f.csv.replace(/^﻿/, ""));
    expect(grid[0]).toEqual(CSV_FIELDS);
    expect(grid).toHaveLength(101);
    exp.forEach((v, i) => {
      const r = rows[i];
      expect(Object.keys(r)).toEqual(FIELDS); // stały zestaw pól, w tej kolejności
      expect(r.title).toBe(v.title);
      expect(r.duration_seconds).toBe(v.dur);
      expect(r.published_at).toBe(v.pub);
      expect(r.url).toBe(`https://www.youtube.com/shorts/${v.id}`);
      expect(r.views).toBe(v.views);
      const want = v.tr === "none" ? null : v.tr === "empty" ? "" : expectedText(v.text);
      expect(r.transcript).toBe(want);
      const c = grid[i + 1];
      expect(c).toHaveLength(CSV_FIELDS.length);
      const col = (k: string) => c[FIELDS.indexOf(k as any)];
      expect(c.slice(0, 6)).toEqual([v.title, String(v.dur), want ?? "", v.pub, r.url, v.views == null ? "" : String(v.views)]);
      expect([col("video_id"), col("likes"), col("comments_count")]).toEqual([v.id, v.likes == null ? "" : String(v.likes), v.comments == null ? "" : String(v.comments)]);
      expect(r.video_id).toBe(v.id);
      expect(r.channel_id).toBe(CHANNEL_ID);
      expect(r.transcript_status).toBe(v.tr === "none" ? "no_captions" : v.tr === "empty" ? "empty" : "ok");
      expect(r.likes).toBe(v.likes);
      expect(r.comments_count).toBe(v.comments);
    });
    // długie transkrypcje nietknięte
    const long = rows.find((r: any) => r.url.endsWith(w.videos[5].id));
    expect(long.transcript.length).toBeGreaterThanOrEqual(43000);
    expect(long.transcript).toBe(expectedText(w.videos[5].text));
    // status.json: liczby i sumy kontrolne
    expect(f.status.selected).toBe(100);
    expect(f.status.files.csv.records).toBe(100);
    expect(f.status.complete).toBe(true);
    const sha = async (t: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(f.status.files.csv.sha256).toBe(await sha(f.csv));
    expect(f.status.files.json.sha256).toBe(await sha(f.json));
    const rec5 = f.status.records.find((r: any) => r.video_id === w.videos[5].id);
    expect(rec5.transcript_sha256).toBe(await sha(expectedText(w.videos[5].text)));
    // brakujące dane oznaczone jawnie
    const missing = f.status.records.filter((r: any) => r.status === "no_captions");
    expect(missing).toHaveLength(2);
    expect(rows.find((r: any) => r.url.endsWith(w.videos[12].id)).transcript).toBeNull();
  });

  it("żaden krok (alarm) nie przekracza 50 subżądań", async () => {
    await setEnv({ ALARM_DELAY_MS: "100000000" }); // alarmy tylko ręcznie: każdy krok jest mierzony osobno
    const { job_id } = await start(100);
    const s = stub();
    let max = 0;
    for (let i = 0; i < 500; i++) {
      const st = await s.status(job_id);
      if (!st.running) break;
      const before = w.calls.yt + w.calls.sd;
      await runDurableObjectAlarm(s);
      max = Math.max(max, w.calls.yt + w.calls.sd - before);
    }
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(50);
    await setEnv({ ALARM_DELAY_MS: undefined });
  });

  it("read_collection: duże transkrypcje składają się z kawałków bez strat", async () => {
    const { job_id } = await start(10);
    await drive(job_id);
    const s = stub();
    const got = new Map<string, string>();
    let cur: string | null = null, pages = 0;
    do {
      const r: any = await s.read(job_id, cur, 5000);
      for (const it of r.items) got.set(it.url, (got.get(it.url) ?? "") + (it.transcript ?? ""));
      cur = r.next_cursor;
      pages++;
    } while (cur && pages < 200);
    expect(got.size).toBe(10);
    for (const v of expectedOrder("newest", 10)) expect(got.get(`https://www.youtube.com/shorts/${v.id}`) ?? "").toBe(v.tr === "none" ? "" : expectedText(v.text));
    expect(pages).toBeGreaterThan(1);
  });
});

describe("wznawianie, restarty, ponawianie", () => {
  beforeEach(() => { w = buildWorld(120, { none: [4] }); installFetch(w); });

  it("restart DO w połowie: zadanie dokańcza się, bez duplikatów i bez ponownego płacenia za gotowe", async () => {
    const s = stub();
    const { job_id } = await start(60);
    for (let i = 0; i < 6; i++) await runDurableObjectAlarm(s); // częściowy postęp
    const mid = await s.status(job_id);
    expect(mid.complete).toBe(false);
    await evictDurableObject(s); // symulacja restartu
    const sdBefore = w.calls.sd;
    const doneBefore = mid.progress.ok;
    const st = await drive(job_id);
    expect(st.complete).toBe(true);
    expect(st.progress.total).toBe(60);
    // po restarcie nie pobierano ponownie transkrypcji, które były gotowe
    expect(w.calls.sd - sdBefore).toBeLessThanOrEqual(60 - doneBefore + 2);
    await runExport(job_id);
    const rows = JSON.parse((await files(job_id)).json);
    expect(new Set(rows.map((r: any) => r.url)).size).toBe(60);
  });

  it("zatrzymanie z powodu limitu Supadata i wznowienie po podniesieniu limitu", async () => {
    await setEnv({ SUPADATA_DAILY_CREDIT_BUDGET: "7" });
    const { job_id } = await start(20);
    const st = await drive(job_id);
    expect(st.running).toBe(false);
    expect(st.complete).toBe(false);
    expect(st.stopped_reason).toMatch(/limit bezpieczeństwa/);
    expect(w.calls.sd).toBeLessThanOrEqual(7); // twardy bezpiecznik: nigdy powyżej
    expect(st.progress.ok + st.progress.no_captions).toBe(7);
    await setEnv({ SUPADATA_DAILY_CREDIT_BUDGET: "300" });
    await stub().resume(job_id, {});
    const st2 = await drive(job_id);
    expect(st2.complete).toBe(true);
    expect(st2.progress.total).toBe(20);
    await setEnv({ SUPADATA_DAILY_CREDIT_BUDGET: undefined });
  });

  it("limit dzienny YouTube (quotaExceeded) wstrzymuje zadanie czytelnym komunikatem, wznowienie działa", async () => {
    w.ytFail = (u) => (u.pathname.endsWith("/videos") ? new Response(JSON.stringify({ error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } }), { status: 403 }) : null);
    const { job_id } = await start(10);
    const st = await drive(job_id);
    expect(st.running).toBe(false);
    expect(st.stopped_reason).toMatch(/limit YouTube/);
    w.ytFail = undefined;
    await stub().resume(job_id, {});
    expect((await drive(job_id)).complete).toBe(true);
  });

  it("zły klucz Supadata (401): natychmiastowe zatrzymanie, bez marnowania kredytów", async () => {
    w.sdFail = () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const { job_id } = await start(15);
    const st = await drive(job_id);
    expect(st.running).toBe(false);
    expect(st.stopped_reason).toMatch(/SUPADATA_API_KEY/);
    expect(w.calls.sd).toBeLessThanOrEqual(2);
    const usage = await stub().usage();
    expect(usage.supadata_credits_today).toBe(0); // zwrot rezerwacji przy błędzie
  });

  it("retencja 30 dni działa z alarmu (także bez nowej aktywności) i zostaje zaplanowany alarm porządkowy", async () => {
    const { job_id } = await start(5);
    expect((await drive(job_id)).complete).toBe(true);
    const old = Date.now() - 40 * 86400_000;
    await (runInDurableObject as any)(stub(), (inst: any) => {
      const sql = inst.ctx.storage.sql;
      sql.exec("UPDATE jobs SET created=?, state=json_set(state,'$.created',?,'$.completedAt',?)", old, old, old);
      sql.exec("DELETE FROM vis_state WHERE k='last_prune'");
    });
    expect(await runDurableObjectAlarm(stub())).toBe(true); // alarm porządkowy z końca poprzedniego alarmu
    const left = await (runInDurableObject as any)(stub(), (inst: any) => ({
      jobs: inst.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").one().n,
      items: inst.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM items").one().n,
    }));
    expect(Number(left.jobs)).toBe(0);
    expect(Number(left.items)).toBe(0);
    expect(await (runInDurableObject as any)(stub(), (inst: any) => inst.ctx.storage.getAlarm())).not.toBeNull(); // kolejny alarm porządkowy
  });

  it("429 z Supadata: ponowienie z retry-after, potem zatrzymanie z możliwością wznowienia", async () => {
    let n = 0;
    w.sdFail = () => (n++ < 99 ? new Response(JSON.stringify({ error: "limit" }), { status: 429, headers: { "retry-after": "0" } }) : null);
    const { job_id } = await start(5);
    const st = await drive(job_id);
    expect(st.running).toBe(false);
    expect(st.complete).toBe(false);
    w.sdFail = undefined;
    await stub().resume(job_id, {});
    expect((await drive(job_id)).complete).toBe(true);
  });

  it("błąd pojedynczego filmu (404) nie zatrzymuje reszty; retry_failed ponawia", async () => {
    w = buildWorld(120); installFetch(w);
    const bad = w.videos[2].id;
    w.sdFail = (u) => (u.searchParams.get("url")?.endsWith(bad) ? new Response(JSON.stringify({ error: "not-found", message: "x" }), { status: 404 }) : null);
    const { job_id } = await start(8);
    const st = await drive(job_id);
    expect(st.complete).toBe(true);
    expect(st.progress.error_video).toBe(1); // 404 z Supadata: błąd dotyczy filmu, nie usługi
    expect(st.progress.ok).toBe(7);
    expect(st.problems[0].url).toContain(bad);
    w.sdFail = undefined;
    await stub().resume(job_id, { retryFailed: true });
    const st2 = await drive(job_id);
    expect(st2.progress.ok).toBe(8);
  });

  it("transcript_mode=auto: zadanie asynchroniczne AI jest odpytywane do końca", async () => {
    w = buildWorld(40, { ai: [1] }); installFetch(w);
    const { job_id } = await start(3, "newest", "auto");
    const st = await drive(job_id);
    expect(st.complete).toBe(true);
    expect(st.progress.ok).toBe(3);
  });

  it("native → brak napisów; resume z auto ponawia tylko te filmy", async () => {
    w = buildWorld(40, { ai: [1] }); installFetch(w);
    const { job_id } = await start(3, "newest", "native");
    const st = await drive(job_id);
    expect(st.progress.no_captions).toBe(1);
    await stub().resume(job_id, { transcriptMode: "auto" });
    const st2 = await drive(job_id);
    expect(st2.progress.no_captions).toBe(0);
    expect(st2.progress.ok).toBe(3);
  });

  it("cache: powtórne zadanie dla tych samych filmów nie zużywa kredytów Supadata", async () => {
    w = buildWorld(120); installFetch(w);
    const a = await start(10);
    await drive(a.job_id);
    const before = w.calls.sd;
    const b = await start(10);
    const st = await drive(b.job_id);
    expect(st.complete).toBe(true);
    expect(w.calls.sd - before).toBe(0);
  });

  it("fallback: brak playlisty UUSH → uploads filtrowane po czasie trwania", async () => {
    const origFetch = globalThis.fetch;
    w.videos[0].dur = 400; // film długi: musi zostać odfiltrowany
    vi.stubGlobal("fetch", (i: any, init: any) => {
      const u = new URL(typeof i === "string" ? i : i.url);
      if (u.pathname.endsWith("/playlistItems") && u.searchParams.get("playlistId")!.startsWith("UUSH")) {
        return Promise.resolve(new Response(JSON.stringify({ error: { message: "nf", errors: [{ reason: "playlistNotFound" }] } }), { status: 404 }));
      }
      return origFetch(i, init);
    });
    const { job_id } = await start(5);
    const st = await drive(job_id);
    expect(st.complete).toBe(true);
    expect(st.enumeration.source).toBe("uploads_filtered_by_duration");
    expect(st.enumeration.excluded_as_not_short).toBeGreaterThanOrEqual(1);
    await runExport(job_id);
    const rows = JSON.parse((await files(job_id)).json);
    expect(rows.every((r: any) => r.duration_seconds <= 180)).toBe(true);
  });
});

describe("integralność eksportu", () => {
  beforeEach(() => { w = buildWorld(60); installFetch(w); });
  it("uszkodzenie danych w bazie jest wykrywane i eksport nie oddaje złych plików", async () => {
    const { job_id } = await start(5);
    await drive(job_id);
    await (runInDurableObject as any)(stub(), (inst: any) => {
      inst.ctx.storage.sql.exec("UPDATE items SET transcript = substr(transcript, 1, 50) WHERE job=? AND ord=2", job_id);
    });
    const info = await runExport(job_id);
    expect(info.phase).toBe("failed");
    expect(info.error).toMatch(/Niezgodność długości/);
    expect(await stub().exportChunks(job_id, "csv")).toBeNull();
  });
  it("eksport częściowy tylko na życzenie i oznaczony jako częściowy", async () => {
    await setEnv({ SUPADATA_DAILY_CREDIT_BUDGET: "4" });
    const { job_id } = await start(10);
    await drive(job_id);
    await expect(rej(stub().startExport(job_id, false))).rejects.toThrow(/nie jest zakończone/);
    const info = await runExport(job_id, true);
    expect(info.phase).toBe("ready");
    expect(info.partial).toBe(true);
    const f = await files(job_id);
    expect(f.status.complete).toBe(false);
    expect(f.status.partial_export).toBe(true);
    await setEnv({ SUPADATA_DAILY_CREDIT_BUDGET: undefined });
  });
  it("pole transkrypcji bez zmian: cudzysłowy, nowe linie, emoji", async () => {
    const { job_id } = await start(30);
    await drive(job_id);
    await runExport(job_id);
    const f = await files(job_id);
    expect(f.csv).toContain("\r\n");
    const grid = parseCsv(f.csv.replace(/^﻿/, ""));
    expect(grid.slice(1).every((r) => r.length === CSV_FIELDS.length)).toBe(true);
    expect(grid.slice(1).some((r) => r[0].includes("\n"))).toBe(true);
    expect(grid.slice(1).some((r) => r[2].includes("😀") && r[2].includes('"cytat"'))).toBe(true);
  });
  it("walidacja wejścia", async () => {
    await expect(rej(start(0))).rejects.toThrow(/count/);
    await expect(rej(start(501))).rejects.toThrow(/count/);
    await expect(rej(stub().startJob({ channel: "@nieistnieje", mode: "newest", count: 1, transcriptMode: "native", lang: null }))).rejects.toThrow(/Nie znaleziono kanału/);
    await expect(rej(stub().startJob({ channel: "@przyklad", mode: "zly", count: 1, transcriptMode: "native", lang: null }))).rejects.toThrow(/mode/);
  });
});
void makeText;
