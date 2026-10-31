import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { buildWorld, installFetch, stub, drive, resetStore, rej, vid, CHANNEL_ID, CHANNEL_ID2, makeText, expectedText, type World, type MockVideo } from "./helpers";
import { COLUMNS, parseCsv } from "../src/csv";

let w: World;
const start = (count: number, mode: any = "newest", extra: Record<string, unknown> = {}, channel = "@przyklad") =>
  stub().startJob({ channel, mode, count, transcriptMode: "native", lang: null, ...extra });
const PHASES = ["selecting", "ordering", "building"];
async function buildSet(spec: Record<string, any>) {
  const s = stub();
  const full = { allowPartial: false, sortBy: "selection", sortDir: "asc", filters: {}, mdPartChars: null, ...spec };
  const r = await s.startSet(full);
  for (let i = 0; i < 400; i++) {
    const info = await s.setInfo(r.set_id);
    if (!PHASES.includes(info.phase)) return info;
    await runDurableObjectAlarm(s);
  }
  throw new Error("zestaw nie skończył się");
}
const chunk = async (id: string, fmt: string) => ((await stub().exportChunks(id, fmt)) ?? []).join("") as string;
const rowsOf = async (id: string) => JSON.parse(await chunk(id, "json"));
const statusOf = async (id: string) => JSON.parse(await chunk(id, "status"));
const sql = async (q: string, ...args: unknown[]) => (runInDurableObject as any)(stub(), (inst: any) => inst.ctx.storage.sql.exec(q, ...args).toArray());

function otherChannel(n: number): MockVideo[] {
  const base = Date.parse("2026-09-03T08:00:00Z");
  return Array.from({ length: n }, (_, i) => ({
    id: vid(5000 + i), title: `Drugi ${i} ŁÓDŹ`, dur: 20 + (i % 30), pub: new Date(base - i * 3600_000 * 7).toISOString().replace(".000Z", "Z"),
    views: 1000 * (n - i), tr: "ok" as const, text: makeText(5000 + i, 400 + (i % 5) * 300), likes: 10 * i, comments: i, commentsOff: false,
  }));
}

beforeEach(async () => { await resetStore(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("paczka Markdown dla modelu", () => {
  beforeEach(() => { w = buildWorld(60, { long: { 3: 30000 }, none: [7] }); installFetch(w); });
  it("części nie przecinają rolek; każda rolka dokładnie raz; za duża rolka sama w części z oznaczeniem", async () => {
    const { job_id } = await start(30);
    await drive(job_id);
    const info = await buildSet({ jobIds: [job_id], mdPartChars: 20000 });
    expect(info.phase).toBe("ready");
    const parts = info.md_parts;
    expect(parts.length).toBeGreaterThan(3);
    const all: string[] = [];
    for (const p of parts) all.push(await chunk(info.set_id, `md-${p.part}`));
    const rows = await rowsOf(info.set_id);
    for (const r of rows) {
      const where = all.map((t, i) => (t.includes(`- ID: \`${r.video_id}\``) ? i : -1)).filter((i) => i >= 0);
      expect(where).toHaveLength(1); // dokładnie jedna część
      const t = all[where[0]];
      if (r.transcript_timed) for (const seg of r.transcript_timed) expect(t).toContain(seg.text); // cały transkrypt w tej samej części
      expect(t).toContain(r.url);
    }
    const big = parts.find((p: any) => p.oversized_record);
    expect(big).toBeTruthy();
    expect(big.records).toBe(1);
    // żadna część bez zbyt dużej rolki nie przekracza limitu
    for (const p of parts) if (!p.oversized_record) expect(p.chars).toBeLessThanOrEqual(20000 + 200);
    // pierwsza część: źródła, definicje, rozróżnienie rankingów, bez ocen
    expect(all[0]).toContain("## Definicje");
    expect(all[0]).toContain("RANKING ZESTAWU");
    expect(all[0]).toContain("NIE uwzględniają wieku publikacji");
    // brak transkryptu opisany jawnie
    const none = rows.find((r: any) => r.video_id === w.videos[7].id);
    expect(none.transcript_status).toBe("no_captions");
    expect(all.join("")).toContain("brak transkryptu (film nie ma napisów)");
    const st = await statusOf(info.set_id);
    expect(st.records.every((r: any) => r.md_part >= 1)).toBe(true);
    expect(st.files["md-1"].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("filtry i sortowanie", () => {
  beforeEach(() => { w = buildWorld(120); installFetch(w); });
  const exp = (pred: (v: MockVideo) => boolean, n = 60) => w.videos.slice(0, n).filter(pred).map((v) => v.id).sort();

  it("data, długość, wyświetlenia, polubienia: dokładnie rolki spełniające wszystkie warunki", async () => {
    const { job_id } = await start(60);
    await drive(job_id);
    const f = { published_from: "2026-08-25", published_to: "2026-08-30", min_duration: 20, max_duration: 50, min_views: 1000, max_likes: 900 };
    const info = await buildSet({ jobIds: [job_id], filters: f });
    const got = (await rowsOf(info.set_id)).map((r: any) => r.video_id).sort();
    const want = exp((v) => v.pub >= "2026-08-25T00:00:00Z" && v.pub <= "2026-08-30T23:59:59Z" && v.dur >= 20 && v.dur <= 50 && v.views != null && v.views >= 1000 && v.likes != null && v.likes <= 900);
    expect(want.length).toBeGreaterThan(3);
    expect(got).toEqual(want);
  });
  it("frazy w tytułach i transkryptach (bez względu na wielkość liter, także polskie znaki), lista fraz = dowolna", async () => {
    const { job_id } = await start(60);
    await drive(job_id);
    const t1 = await buildSet({ jobIds: [job_id], filters: { text: "CUDZYSŁOWEM", text_in: "title" } });
    expect((await rowsOf(t1.set_id)).map((r: any) => r.video_id).sort()).toEqual(exp((v) => v.title.toLowerCase().includes("cudzysłowem")));
    const t2 = await buildSet({ jobIds: [job_id], filters: { text: ["wideo 5:", "wideo 17:"], text_in: "transcript" } });
    const got2 = (await rowsOf(t2.set_id)).map((r: any) => r.video_id).sort();
    expect(got2).toEqual(exp((v) => /Wideo (5|17):/.test(v.text)));
    const t3 = await buildSet({ jobIds: [job_id], filters: { text: "ĄĘŚ" } }); // tytuły „Short N ąęś”
    expect((await rowsOf(t3.set_id)).length).toBe(exp((v) => v.title.includes("ąęś")).length);
  });
  it("wynik względem mediany kanału", async () => {
    const { job_id } = await start(60, "most_viewed");
    const st = await drive(job_id);
    const med = st.channel_baseline.median_views;
    const info = await buildSet({ jobIds: [job_id], filters: { min_median_ratio: 1.5 } });
    const rows = await rowsOf(info.set_id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.views >= 1.5 * med && r.views_vs_channel_median >= 1.5)).toBe(true);
    const all = w.videos.filter((v) => !v.unavailable && v.views != null);
    const top60 = [...all].sort((a, b) => b.views! - a.views!).slice(0, 60);
    expect(rows.length).toBe(top60.filter((v) => v.views! >= 1.5 * med).length);
  });
  it("sortowanie po polubieniach, dacie, długości: rosnąco/malejąco, braki na końcu", async () => {
    const { job_id } = await start(40);
    await drive(job_id);
    for (const [by, key] of [["likes", "likes"], ["published_at", "published_at"], ["duration_seconds", "duration_seconds"], ["comments_count", "comments_count"]] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const info = await buildSet({ jobIds: [job_id], sortBy: by, sortDir: dir });
        const vals = (await rowsOf(info.set_id)).map((r: any) => r[key]);
        const nn = vals.filter((x: any) => x != null);
        const sorted = [...nn].sort((a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0));
        expect(nn).toEqual(dir === "asc" ? sorted : sorted.reverse());
        expect(vals.slice(nn.length).every((x: any) => x == null)).toBe(true);
      }
    }
  });
  it("walidacja filtrów i sortowania", async () => {
    const { job_id } = await start(5);
    await drive(job_id);
    const s = stub();
    const base = { jobIds: [job_id], allowPartial: false, sortBy: "selection", sortDir: "asc", filters: {}, mdPartChars: null };
    await expect(rej(s.startSet({ ...base, filters: { min_views: -1 } }))).rejects.toThrow(/min_views/);
    await expect(rej(s.startSet({ ...base, filters: { published_from: "wczoraj" } }))).rejects.toThrow(/published_from/);
    await expect(rej(s.startSet({ ...base, filters: { min_views: 10, max_views: 5 } }))).rejects.toThrow(/większe/);
    await expect(rej(s.startSet({ ...base, sortBy: "zle" }))).rejects.toThrow(/sort_by/);
    await expect(rej(s.startSet({ ...base, mdPartChars: 100 }))).rejects.toThrow(/md_part_chars/);
    await expect(rej(s.startSet({ ...base, jobIds: ["c-" + "0".repeat(24)] }))).rejects.toThrow(/Nie ma zadania/);
  });
});

describe("zestawy z wielu kanałów", () => {
  beforeEach(() => { w = buildWorld(60); w.other = otherChannel(30); installFetch(w); });
  it("wspólny eksport: informacja o kanale, ranking kanału osobno od rankingu zestawu, filtr kanału", async () => {
    const a = await start(10, "most_viewed");
    const b = await start(10, "most_viewed", {}, "@drugi");
    await drive(a.job_id);
    await drive(b.job_id);
    const info = await buildSet({ jobIds: [a.job_id, b.job_id], sortBy: "views", sortDir: "desc" });
    const rows = await rowsOf(info.set_id);
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((r: any) => r.channel_id))).toEqual(new Set([CHANNEL_ID, CHANNEL_ID2]));
    // ranking zestawu: 1..20 po wyświetleniach w całym pliku; ranking kanału: w obrębie własnego kanału
    const withViews = rows.filter((r: any) => r.views != null);
    withViews.forEach((r: any) => expect(r.set_views_rank).toBe(withViews.filter((x: any) => x.views > r.views).length + 1));
    expect(rows.every((r: any) => r.set_size === 20)).toBe(true);
    const second = rows.filter((r: any) => r.channel_id === CHANNEL_ID2);
    expect(second.map((r: any) => r.channel_views_rank)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(second[0].channel_handle).toBe("@drugi");
    const md = await chunk(info.set_id, "md-1");
    expect(md).toContain("Drugi Kanał (@drugi)");
    expect(md).toContain("Ranking kanału (wśród Shortsów tego kanału)");
    expect(md).toContain("Ranking zestawu (wśród rolek w tym pliku)");
    const only = await buildSet({ jobIds: [a.job_id, b.job_id], filters: { channel: "@drugi" } });
    expect((await rowsOf(only.set_id)).every((r: any) => r.channel_id === CHANNEL_ID2)).toBe(true);
  });
  it("duplikaty po ID filmu: zostaje rolka z najnowszym pomiarem, liczba usuniętych w statusie", async () => {
    const a = await start(15, "newest");
    await drive(a.job_id);
    await sql("UPDATE snaps SET at = at - ?", 2 * 3600_000);
    await sql("UPDATE items SET mat = mat - ? WHERE job=?", 2 * 3600_000, a.job_id);
    w.videos[1].views = w.videos[1].views! + 777;
    const b = await start(10, "newest");
    await drive(b.job_id);
    const info = await buildSet({ jobIds: [a.job_id, b.job_id] });
    const rows = await rowsOf(info.set_id);
    expect(rows).toHaveLength(15);
    expect(new Set(rows.map((r: any) => r.video_id)).size).toBe(15);
    expect(info.duplicates_removed).toBe(10);
    const r1 = rows.find((r: any) => r.video_id === w.videos[1].id);
    expect(r1.views).toBe(w.videos[1].views); // nowszy pomiar
    expect(r1.views_gain).toBe(777);
    expect((await statusOf(info.set_id)).records.find((r: any) => r.video_id === w.videos[1].id).job_id).toBe(b.job_id);
  });
});

describe("odświeżanie samych statystyk i komentarzy", () => {
  beforeEach(() => { w = buildWorld(50); installFetch(w); });
  for (const channelStats of [false, true]) {
    it(`bez pobierania transkrypcji (${channelStats ? "z przeliczeniem kanału" : "tylko wybrane rolki"}); historia i przyrost zachowane`, async () => {
      const { job_id } = await start(8, "newest", { channelStats });
      await drive(job_id);
      await sql("UPDATE snaps SET at = at - ?", 3 * 3600_000);
      await sql("UPDATE items SET mat = mat - ? WHERE job=?", 3 * 3600_000, job_id);
      const sd = w.calls.sd, cm = w.calls.comments;
      for (const v of w.videos.slice(0, 8)) if (v.views != null) v.views += 100;
      w.videos[1].likes = 4242;
      const r = await stub().refresh(job_id, { comments: true, channelStats });
      expect(r.refresh_estimate.supadata_credits).toBe(0);
      const st = await drive(job_id);
      expect(st.complete).toBe(true);
      expect(w.calls.sd).toBe(sd); // zero zapytań o transkrypcje
      expect(w.calls.comments - cm).toBe(8); // komentarze pobrane od nowa
      const info = await buildSet({ jobIds: [job_id] });
      const rows = await rowsOf(info.set_id);
      const r1 = rows.find((x: any) => x.video_id === w.videos[1].id);
      expect(r1.likes).toBe(4242);
      expect(r1.views_gain).toBe(100);
      expect(r1.views_history.length).toBe(2);
      expect(r1.transcript).toBe(expectedText(w.videos[1].text)); // transkrypt nietknięty
      expect(Date.parse(r1.measured_at)).toBeGreaterThan(Date.now() - 60_000);
      expect(r1.comments_status).toBe("ok");
    });
  }
  it("film zniknął przy odświeżeniu: stare statystyki zostają ze statusem unavailable", async () => {
    const { job_id } = await start(5, "newest", { channelStats: false });
    await drive(job_id);
    w.videos[2].unavailable = true;
    await stub().refresh(job_id, { comments: false, channelStats: false });
    await drive(job_id);
    const rows = await rowsOf((await buildSet({ jobIds: [job_id] })).set_id);
    const r2 = rows.find((x: any) => x.video_id === w.videos[2].id);
    expect(r2.stats_status).toBe("unavailable");
    expect(r2.views).toBe(w.videos[2].views);
  });
  it("odświeżenie pracującego zadania jest odrzucane", async () => {
    const { job_id } = await start(5);
    await expect(rej(stub().refresh(job_id, { comments: true, channelStats: null }))).rejects.toThrow(/pracuje/);
  });
});

describe("statusy braków, ponawianie i szacunek kosztów", () => {
  beforeEach(() => { w = buildWorld(60); installFetch(w); });
  it("wyczerpane kredyty (402): status no_credits dla niepobranych; wznowienie ponawia tylko je", async () => {
    let calls = 0;
    w.sdFail = () => (++calls > 4 ? new Response(JSON.stringify({ error: "limit-exceeded", message: "Limit Exceeded" }), { status: 402 }) : null);
    const { job_id } = await start(10, "newest", { comments: false });
    const st = await drive(job_id);
    expect(st.running).toBe(false);
    expect(st.progress.ok).toBe(4);
    expect(st.progress.no_credits).toBe(6);
    expect(st.problems.every((p: any) => p.status === "no_credits")).toBe(true);
    w.sdFail = undefined;
    const before = w.calls.sd;
    await stub().resume(job_id, {});
    const st2 = await drive(job_id);
    expect(st2.complete).toBe(true);
    expect(w.calls.sd - before).toBe(6); // tylko brakujące
  });
  it("429 limit tempa (details: rate limit): to nie brak kredytów — filmy zostają pending, zadanie staje, wznowienie kończy", async () => {
    let calls = 0;
    w.sdFail = () => (++calls > 4 ? new Response(JSON.stringify({ error: "limit-exceeded", message: "Limit Exceeded", details: "Request rate limit on current plan was exceeded." }), { status: 429, headers: { "retry-after": "0" } }) : null);
    const { job_id } = await start(10, "newest", { comments: false });
    const st = await drive(job_id);
    expect(st.running).toBe(false);
    expect(st.progress.ok).toBe(4);
    expect(st.progress.no_credits).toBe(0);
    expect(st.progress.pending).toBe(6);
    expect(st.stopped_reason).toMatch(/tempa zapytań.*nie brak kredytów/);
    w.sdFail = undefined;
    await stub().resume(job_id, {});
    const st2 = await drive(job_id);
    expect(st2.complete).toBe(true);
    expect(st2.progress.ok).toBe(10);
  });
  it("429 limit kredytów (details: Plan usage limit): status no_credits, wznowienie ponawia tylko brakujące", async () => {
    let calls = 0;
    w.sdFail = () => (++calls > 4 ? new Response(JSON.stringify({ error: "limit-exceeded", message: "Limit Exceeded", details: "Plan usage limit was exceeded." }), { status: 429, headers: { "retry-after": "0" } }) : null);
    const { job_id } = await start(10, "newest", { comments: false });
    const st = await drive(job_id);
    expect(st.running).toBe(false);
    expect(st.progress.ok).toBe(4);
    expect(st.progress.no_credits).toBe(6);
    expect(st.stopped_reason).toMatch(/limit kredytów/);
    w.sdFail = undefined;
    const before = w.calls.sd;
    await stub().resume(job_id, {});
    expect((await drive(job_id)).complete).toBe(true);
    expect(w.calls.sd - before).toBe(6);
  });
  it("błąd usługi (5xx) → error_service; błąd filmu (404) → error_video; komentarze 500 → error; retry_failed ponawia tylko je", async () => {
    const bad = w.videos[1].id, gone = w.videos[2].id, cbad = w.videos[3].id;
    let fix = false;
    w.sdFail = (u) => (fix ? null : u.searchParams.get("url")?.endsWith(bad) ? new Response("{}", { status: 503 }) : u.searchParams.get("url")?.endsWith(gone) ? new Response(JSON.stringify({ error: "not-found" }), { status: 404 }) : null);
    w.ytFail = (u) => (!fix && u.pathname.endsWith("/commentThreads") && u.searchParams.get("videoId") === cbad ? new Response(JSON.stringify({ error: { message: "backend", errors: [{ reason: "backendError" }] } }), { status: 500 }) : null);
    const { job_id } = await start(6);
    const st = await drive(job_id);
    expect(st.complete).toBe(true);
    expect(st.progress.error_service).toBe(1);
    expect(st.progress.error_video).toBe(1);
    expect(st.comments.error).toBe(1);
    const info = await buildSet({ jobIds: [job_id] });
    const rows = await rowsOf(info.set_id);
    expect(rows.find((r: any) => r.video_id === bad).transcript_status).toBe("error_service");
    expect(rows.find((r: any) => r.video_id === cbad).comments_status).toBe("error");
    expect(rows.find((r: any) => r.video_id === w.videos[0].id).comments_status).toBe("disabled"); // indeks 0: komentarze wyłączone
    fix = true;
    const sd = w.calls.sd, cm = w.calls.comments;
    await stub().resume(job_id, { retryFailed: true });
    const st2 = await drive(job_id);
    expect(st2.progress.ok).toBe(6);
    expect(w.calls.sd - sd).toBe(2);
    expect(w.calls.comments - cm).toBe(1);
  });
  it("szacunek przed pobraniem uwzględnia zapisane transkrypcje i jest zgodny z faktycznym zużyciem", async () => {
    const a = await start(10);
    await drive(a.job_id);
    const b = await start(25, "newest", { estimateFirst: true });
    const st = await drive(b.job_id);
    expect(st.awaiting_confirmation).toBe(true);
    expect(st.running).toBe(false);
    expect(st.estimate.videos_to_transcribe).toBe(25);
    expect(st.estimate.transcripts_already_saved).toBe(10);
    expect(st.estimate.supadata_credits_estimated).toBe(15);
    expect(st.estimate.youtube_units_comments).toBe(25);
    const sd = w.calls.sd;
    expect(w.calls.sd).toBe(sd); // nic nie pobrano przed potwierdzeniem
    await stub().resume(b.job_id, {});
    const st2 = await drive(b.job_id);
    expect(st2.complete).toBe(true);
    expect(w.calls.sd - sd).toBe(15);
  });
});

void COLUMNS; void parseCsv; void CHANNEL_ID;

describe("przechowywanie danych YouTube API: najwyżej 30 dni od ostatniego pomiaru", () => {
  beforeEach(() => { w = buildWorld(30); installFetch(w); });
  it("stare zadanie i pomiary są usuwane; zadanie odświeżone niedawno zostaje", async () => {
    const a = await start(3, "newest", { comments: false });
    const b = await start(3, "newest", { comments: false });
    await drive(a.job_id);
    await drive(b.job_id);
    const old = Date.now() - 31 * 86400_000;
    await (runInDurableObject as any)(stub(), (inst: any) => {
      const s = inst.ctx.storage.sql;
      for (const id of [a.job_id, b.job_id]) {
        const j = JSON.parse(String(s.exec("SELECT state FROM jobs WHERE id=?", id).one().state));
        j.created = old; j.completedAt = old;
        if (id === b.job_id) j.refresh = { startedAt: Date.now() - 1000, comments: false, via: "items", finishedAt: Date.now() - 500 };
        s.exec("UPDATE jobs SET state=?, created=? WHERE id=?", JSON.stringify(j), old, id);
      }
      s.exec("UPDATE snaps SET at = ?", old);
    });
    await start(1, "newest", { comments: false }); // startJob uruchamia porządki
    expect((await sql("SELECT id FROM jobs WHERE id=?", a.job_id)).length).toBe(0);
    expect((await sql("SELECT COUNT(*) AS n FROM items WHERE job=?", a.job_id))[0].n).toBe(0);
    expect((await sql("SELECT id FROM jobs WHERE id=?", b.job_id)).length).toBe(1);
    expect((await sql("SELECT COUNT(*) AS n FROM snaps WHERE at <= ?", old))[0].n).toBe(0);
  });
});
