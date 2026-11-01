import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { buildWorld, installFetch, stub, drive, runExport, resetStore, setEnv, expectedText, mockComments, CHANNEL_ID, type World } from "./helpers";
import { COLUMNS, CSV_COLUMNS, parseCsv } from "../src/csv";

// Test integracyjny na 20 rolkach (atrapy YouTube, Supadata i Gemini): cały przepływ zbierania, wizji całego zadania i eksportu
// z mieszanką przypadków. Sprawdza kompletność danych, powiązanie wyników z właściwą rolką, jawne oznaczenia braków i błędów,
// spójność CSV / JSON / Markdown / status.json oraz to, że ponowne uruchomienie wizji dla zadania poprawia tylko to, co brakowało.

const N = 20;
const MODEL = "gemini-3.5-flash-lite";
// numery rolek (0 = najnowsza) w scenariuszu
const NO_CAPTIONS = [3, 9], EMPTY = [14];
const VIS_HARD_ERROR = 7, VIS_BAD_JSON = 11, VIS_TRANSIENT = 13, VIS_NO_IMAGES = 5, VIS_NEVER = 19;

let w: World;
const sql = async (q: string, ...args: unknown[]) =>
  (runInDurableObject as any)(stub(), (inst: any) => inst.ctx.storage.sql.exec(q, ...args).toArray());
const hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

const idOf = (body: any) => String(body.contents[0].parts[0].fileData.fileUri).slice(-11);
const msg = (t: string, sender: string, text: string) => ({ t, sender, text });
function visionBody(id: string, nImages: number) {
  const images = Array.from({ length: nImages }, (_, k) => ({
    id: k + 1, first_visible: `0:0${k * 3}.0`, last_visible: `0:0${k * 3 + 2}.0`, appearances: [{ from: `0:0${k * 3}.0`, to: `0:0${k * 3 + 2}.0` }], sent_by: "Son",
    description_pl: `Zdjęcie ${k + 1} z rolki ${id}.`, text_in_image: null,
    messages_before: [msg(`0:0${k * 3}.0`, "Dad", `przed zdjęciem ${k + 1} (${id})`)],
    messages_after: [msg(`0:0${k * 3 + 1}.0`, "Son", `po zdjęciu ${k + 1} (${id})`)],
    related_messages: [{ ...msg(`0:0${k * 3 + 1}.0`, "Son", `po zdjęciu ${k + 1} (${id})`), basis: k % 2 ? "assumption" : "explicit", reason_pl: `powód ${id}` }],
    uncertainty_pl: k === 1 ? `niepewne (${id})` : null,
  }));
  return { video_duration_s: 30, messages: [msg("0:00.0", "Dad", `wiadomość z ekranu (${id})`)], images, no_images_found: nImages === 0, unclear_ranges: [], notes_pl: null };
}
const okResp = (payload: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 5000 }, modelVersion: MODEL }), { status: 200 });

async function finishVision() {
  for (let i = 0; i < 400; i++) {
    await runDurableObjectAlarm(stub());
    const busy = (await sql("SELECT status, next_at FROM vis WHERE status IN ('pending','running')")).some((r: any) => r.status === "running" || Number(r.next_at) <= Date.now());
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}

beforeEach(async () => {
  await resetStore();
  w = buildWorld(60, { none: NO_CAPTIONS, empty: EMPTY });
  installFetch(w);
  await setEnv({ GEMINI_MIN_START_INTERVAL_MS: "0", GEMINI_RETRY_DELAYS_S: "0", GEMINI_MAX_ATTEMPTS: "2", GEMINI_API_KEY: "GEMKEY-MARKER-789", GEMINI_MODEL_LIMITS: "{}", GEMINI_CANCEL_BATCHES: "", GEMINI_DAILY_CALLS: undefined, GEMINI_CONCURRENCY: undefined });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("test integracyjny: 20 rolek od zbierania do eksportu", () => {
  it("komplet danych, poprawne powiązania, jawne braki i błędy, spójny eksport, poprawka tylko brakujących", async () => {
    const reel = (i: number) => w.videos[i];
    const idIndex = new Map(w.videos.slice(0, N).map((v, i) => [v.id, i]));
    // ------------------------------------------------------------------ 1. zbieranie (statystyki, transkrypcje, komentarze, ranking)
    const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count: N, transcriptMode: "native", lang: null });
    const st = await drive(job_id);
    expect(st.complete).toBe(true);
    expect(st).toMatchObject({ selected: N, shortfall: null, problems_total: 3 }); // 2 bez napisów + 1 pusty to NIE błędy usługi, ale problemy do wiadomości
    expect(st.progress).toMatchObject({ total: N, ok: N - 3, empty: 1, no_captions: 2, error_service: 0, error_video: 0, no_credits: 0, pending: 0 });
    expect(st.comments).toMatchObject({ fetched: 18, disabled: 2, error: 0, not_fetched: 0 });
    expect(st.channel_baseline).toMatchObject({ history_complete: true, norm_usable: true, top5_usable: true });
    expect(st.vision).toMatchObject({ ok: 0, in_progress: 0, failed: 0, not_analyzed: N });
    expect((await stub().usage()).supadata_credits_today).toBe(N); // 1 kredyt na rolkę, bez dubli

    // ------------------------------------------------------------------ 2. wizja całego zadania: szacunek, potem start
    w.gemini = (_fps, body) => {
      const id = idOf(body), i = idIndex.get(id)!;
      const seen = w.geminiCalls!.filter((c) => c.url!.endsWith(id)).length;
      if (i === VIS_HARD_ERROR) return new Response(JSON.stringify({ error: { code: 400, message: "bad request" } }), { status: 400 });
      if (i === VIS_BAD_JSON) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "to nie jest json" }] }, finishReason: "STOP" }] }), { status: 200 });
      if (i === VIS_TRANSIENT && seen === 1) return new Response(JSON.stringify({ error: { code: 503, message: "high demand", status: "UNAVAILABLE" } }), { status: 503, headers: { "retry-after": "0" } });
      return okResp(visionBody(id, i === VIS_NO_IMAGES ? 0 : i % 3 === 0 ? 2 : 1));
    };
    const est = await stub().startVision({ jobId: job_id, fps: [1], model: MODEL });
    expect(est).toMatchObject({ estimate_only: true, reels_in_job: N, runs_to_analyze: N, calls_planned: N });
    expect(w.geminiCalls ?? []).toHaveLength(0); // sam szacunek niczego nie wywołuje
    const run = await stub().startVision({ jobId: job_id, fps: [1], model: MODEL, estimateOnly: false });
    expect(run.queued_runs).toBe(N);
    await finishVision();
    // powtórzone próby tylko tam, gdzie błąd bywa przejściowy (503) albo odpowiedź nie była JSON-em; błąd 400 nie jest ponawiany
    const callsOf = (i: number) => w.geminiCalls!.filter((c) => c.url!.endsWith(reel(i).id)).length;
    expect([VIS_HARD_ERROR, VIS_BAD_JSON, VIS_TRANSIENT, 0, 5].map(callsOf)).toEqual([1, 2, 2, 1, 1]);
    expect(w.geminiCalls).toHaveLength(N + 2);
    // jedna rolka zostaje bez analizy (np. nigdy nie zlecona): jej wyniki znikają z bazy
    await sql("DELETE FROM vis WHERE vid=?", reel(VIS_NEVER).id);
    const st2 = await stub().status(job_id);
    expect(st2.vision).toMatchObject({ ok: N - 3, in_progress: 0, failed: 2, not_analyzed: 1 });

    // ------------------------------------------------------------------ 3. eksport: JSON
    const info = await runExport(job_id);
    const setInfo = await stub().setInfo(info.set_id);
    expect(setInfo).toMatchObject({ phase: "ready", records: N, duplicates_removed: 0, partial: false });
    const json = JSON.parse((await stub().exportChunks(job_id, "json")).join(""));
    expect(json).toHaveLength(N);
    const runIds = new Set<string>();
    for (const [i, r] of (json as any[]).entries()) {
      const v = reel(i);
      // tożsamość i kolejność wyboru (najnowsze pierwsze)
      expect(r.video_id).toBe(v.id);
      expect(r.url.endsWith(v.id)).toBe(true);
      expect(r.channel_id).toBe(CHANNEL_ID);
      expect(r.title).toBe(v.title);
      expect(r.views).toBe(v.views);
      expect(r.likes).toBe(v.likes);
      expect(r.comments_count).toBe(v.comments);
      // transkrypcja: pełna albo jawny brak z przyczyną
      if (NO_CAPTIONS.includes(i)) expect(r).toMatchObject({ transcript: null, transcript_status: "no_captions", transcript_timed_status: "no_transcript", transcript_timed: null });
      else if (EMPTY.includes(i)) expect(r).toMatchObject({ transcript: "", transcript_status: "empty" });
      else {
        expect(r.transcript_status).toBe("ok");
        expect(r.transcript).toBe(expectedText(v.text));
        expect(r.transcript_timed_status).toBe("ok");
        expect(r.transcript_timed.map((s: any) => s.text).join(" ")).toBe(r.transcript);
      }
      // komentarze: do 5 w kolejności trafności albo jawny brak
      if (v.commentsOff) expect(r).toMatchObject({ comments_status: "disabled", top_comments_relevance: null });
      else {
        expect(r.comments_status).toBe("ok");
        expect(r.top_comments_relevance.map((c: any) => c.likes)).toEqual(mockComments(v).map((c) => c.likes)); // nie posortowane wg polubień
        expect(r.top_comments_relevance[0].text).toContain(v.id); // komentarze tej rolki, nie innej
      }
      // statystyki i ranking
      expect(r.stats_status).toBe("ok");
      if (r.views != null) expect(r.channel_views_rank).toBeGreaterThanOrEqual(1);
      expect(r.set_size).toBe(N);
      // wizja: wynik przypisany do właściwej rolki (opisy i wiadomości zawierają ID rolki z atrapy)
      if (i === VIS_HARD_ERROR) expect(r).toMatchObject({ vision_status: "failed:error", vision: null });
      else if (i === VIS_BAD_JSON) expect(r).toMatchObject({ vision_status: "failed:invalid_output", vision: null });
      else if (i === VIS_NEVER) expect(r).toMatchObject({ vision_status: "not_analyzed", vision: null });
      else {
        expect(r.vision_status).toBe("ok");
        const nImg = i === VIS_NO_IMAGES ? 0 : i % 3 === 0 ? 2 : 1;
        expect(r.vision.images).toHaveLength(nImg);
        expect(r.vision.run.no_images_found).toBe(nImg === 0);
        expect(r.vision.run.attempt).toBe(i === VIS_TRANSIENT ? 2 : 1);
        expect(r.vision.messages[0].text).toContain(v.id);
        r.vision.images.forEach((im: any, k: number) => {
          expect(im.description_pl).toBe(`Zdjęcie ${k + 1} z rolki ${v.id}.`);
          expect(im.messages_before[0].text).toContain(v.id);
          expect(im.messages_after[0].text).toContain(v.id);
          expect(im.related_messages[0].model_basis).toBe(k % 2 ? "assumption" : "explicit");
          expect(im.related_messages[0].link_status_pl).toMatch(/model|przypuszczenie/);
          expect(im.verification_pl).toMatch(/niezweryfikowane/);
        });
        expect(r.vision.run.raw_response).toContain(v.id); // oryginalna odpowiedź tej rolki
        expect(r.vision.run.raw_response_sha256).toBe(await hex(r.vision.run.raw_response));
        runIds.add(r.vision.run.run_id);
      }
    }
    expect(runIds.size).toBe(N - 3); // każdy wynik wizji należy do dokładnie jednej rolki
    expect(new Set(json.filter((r: any) => r.set_views_rank != null).map((r: any) => r.set_views_rank)).size).toBe(json.filter((r: any) => r.views != null).length); // unikalne miejsca w zestawie

    // ------------------------------------------------------------------ 4. CSV zgodne z JSON
    const grid = parseCsv((await stub().exportChunks(job_id, "csv")).join("").replace(/^﻿/, ""));
    expect(grid[0]).toEqual([...CSV_COLUMNS]);
    expect(grid).toHaveLength(N + 1);
    grid.slice(1).forEach((row, i) => {
      const r = json[i];
      expect(row).toHaveLength(CSV_COLUMNS.length);
      const c = (k: string) => row[CSV_COLUMNS.indexOf(k as any)];
      expect(c("video_id")).toBe(r.video_id);
      expect(c("url")).toBe(r.url);
      expect(c("views")).toBe(r.views == null ? "" : String(r.views));
      expect(c("transcript_status")).toBe(r.transcript_status);
      expect(c("comments_status")).toBe(r.comments_status);
      expect(c("vision_status")).toBe(r.vision_status);
      if (r.transcript != null && !/^[=+\-@\t\r]/.test(r.transcript)) expect(c("transcript")).toBe(r.transcript);
      if (r.vision) {
        const { raw_response: _omit, ...rn } = r.vision.run;
        expect(JSON.parse(c("vision_json"))).toEqual({ ...r.vision, run: { ...rn, raw_response_note: expect.any(String) } });
        expect(c("vision_json_chars")).toBe(String(c("vision_json").length));
        for (const im of r.vision.images) expect(c("vision")).toContain(im.messages_before[0].text);
      } else {
        expect(c("vision_json")).toBe("");
        expect(c("vision_json_chars")).toBe("");
      }
    });
    expect(COLUMNS.every((k, k2) => CSV_COLUMNS[k2] === k)).toBe(true);

    // ------------------------------------------------------------------ 5. Markdown: każda rolka z ID, jawne braki
    const mdParts = setInfo.md_parts.length;
    const md = (await Promise.all(Array.from({ length: mdParts }, (_, k) => stub().exportChunks(job_id, `md-${k + 1}`)))).map((x) => x.join("")).join("\n");
    for (const v of w.videos.slice(0, N)) expect(md).toContain(`\`${v.id}\``);
    expect((md.match(/\(brak transkryptu: brak transkryptu \(film nie ma napisów\)\)/g) ?? []).length).toBe(NO_CAPTIONS.length);
    expect((md.match(/\(brak: wyłączone przez autora\)/g) ?? []).length).toBe(2);
    expect(md).toContain("rolka nie była analizowana pod kątem zdjęć");
    expect(md).toContain("failed:error");
    expect(md).toContain("failed:invalid_output");
    expect(md).toContain("Model nie wykrył żadnego zdjęcia w rozmowie");

    // ------------------------------------------------------------------ 6. status.json i sumy kontrolne plików
    const status = JSON.parse((await stub().exportChunks(job_id, "status")).join(""));
    expect(status).toMatchObject({ complete: true, selected: N, duplicates_removed: 0 });
    expect(status.counts.transcript_status).toEqual({ ok: N - 3, empty: 1, no_captions: 2 });
    expect(status.counts.comments_status).toEqual({ ok: 18, disabled: 2 });
    expect(status.counts.vision_status).toEqual({ ok: N - 3, "failed:error": 1, "failed:invalid_output": 1, not_analyzed: 1 });
    expect(status.records).toHaveLength(N);
    for (const fmt of Object.keys(info.files)) expect(await hex((await stub().exportChunks(job_id, fmt)).join(""))).toBe(info.files[fmt].sha256);
    expect((await runExport(job_id)).set_id).toBe(info.set_id); // bez zmian ten sam zestaw

    // ------------------------------------------------------------------ 7. poprawka: ponowne uruchomienie wizji zadania obejmuje tylko to, czego brakuje
    w.gemini = (_fps, body) => okResp(visionBody(idOf(body), 1));
    const before = w.geminiCalls!.length;
    const fix = await stub().startVision({ jobId: job_id, fps: [1], model: MODEL, estimateOnly: false });
    expect(fix).toMatchObject({ runs_already_done: N - 3, runs_to_analyze: 3, queued_runs: 3 });
    await finishVision();
    const redone = w.geminiCalls!.slice(before).map((c) => idIndex.get(c.url!.slice(-11))!).sort((a, b) => a - b);
    expect(redone).toEqual([VIS_HARD_ERROR, VIS_BAD_JSON, VIS_NEVER].sort((a, b) => a - b)); // dokładnie te trzy, bez dubli
    expect((await stub().status(job_id)).vision).toMatchObject({ ok: N, in_progress: 0, failed: 0, not_analyzed: 0 });
    const info2 = await runExport(job_id);
    expect(info2.set_id).not.toBe(info.set_id); // wizja doszła po eksporcie: nowy zestaw, nie stary
    const json2 = JSON.parse((await stub().exportChunks(job_id, "json")).join(""));
    expect(json2.every((r: any) => r.vision_status === "ok")).toBe(true);
    // reszta danych bez zmian względem pierwszego eksportu
    json2.forEach((r: any, i: number) => {
      expect(r.transcript).toBe(json[i].transcript);
      expect(r.top_comments_relevance).toEqual(json[i].top_comments_relevance);
      expect(r.views).toBe(json[i].views);
    });
    expect(JSON.parse((await stub().exportChunks(job_id, "status")).join("")).counts.vision_status).toEqual({ ok: N });
  }, 120000);
});
