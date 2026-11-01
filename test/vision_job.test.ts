import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { buildWorld, installFetch, stub, drive, runExport, resetStore, setEnv, rej, type World } from "./helpers";
import { dispatch } from "../src/mcp";

// Etap 2: wizja wszystkich rolek jednego zadania (analyze_images z job_id): szacunek bez zlecania, pomijanie rolek z wynikiem
// i już czekających, respektowanie limitów (czekanie zamiast błędu), liczniki w statusie zadania i automatyczny eksport.

let w: World;
const sql = async (q: string, ...args: unknown[]) =>
  (runInDurableObject as any)(stub(), (inst: any) => inst.ctx.storage.sql.exec(q, ...args).toArray());
const MODEL = "gemini-3.5-flash-lite";
const photo = {
  id: 1, first_visible: "0:00.0", last_visible: "0:02.0", appearances: [{ from: "0:00.0", to: "0:02.0" }], sent_by: "Son",
  description_pl: "Zdjęcie.", text_in_image: null, messages_before: [], messages_after: [{ t: "0:00.0", sender: "Son", text: "Hi" }],
  related_messages: [], uncertainty_pl: null,
};
const ok = () =>
  new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ video_duration_s: 30, messages: [], images: [photo], no_images_found: false, unclear_ranges: [], notes_pl: null }) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 1000 }, modelVersion: MODEL,
  }), { status: 200 });
async function settle(n = 12) {
  for (let i = 0; i < n; i++) {
    await runDurableObjectAlarm(stub());
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function finish() {
  for (let i = 0; i < 400; i++) {
    await runDurableObjectAlarm(stub());
    const busy = await sql("SELECT status, next_at FROM vis WHERE status IN ('pending','running')").then((rows) => rows.some((r: any) => r.status === "running" || Number(r.next_at) <= Date.now()));
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function makeJob(count = 5) {
  const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count, transcriptMode: "native", lang: null });
  expect((await drive(job_id)).complete).toBe(true);
  return job_id as string;
}

beforeEach(async () => {
  await resetStore();
  w = buildWorld(60, { none: [2] });
  installFetch(w);
  await setEnv({ GEMINI_MIN_START_INTERVAL_MS: "0", GEMINI_RETRY_DELAYS_S: "0", GEMINI_API_KEY: "K", GEMINI_MODEL_LIMITS: "{}", GEMINI_CANCEL_BATCHES: "", GEMINI_DAILY_CALLS: undefined, GEMINI_MAX_ATTEMPTS: undefined, GEMINI_CONCURRENCY: undefined });
  w.gemini = () => ok();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("wizja całego zadania (analyze_images z job_id)", () => {
  it("domyślnie tylko szacunek: nic nie jest zlecane; liczby zgodne z limitami (dobowym i modelu)", async () => {
    await setEnv({ GEMINI_DAILY_CALLS: "250", GEMINI_MODEL_LIMITS: JSON.stringify({ [MODEL]: { rpm: 15, tpm: 250000, rpd: 3 } }) });
    const job = await makeJob(5);
    const est = await stub().startVision({ jobId: job, fps: [1], model: MODEL });
    expect(est).toMatchObject({ estimate_only: true, job_id: job, model: MODEL, reels_in_job: 5, runs_already_done: 0, runs_already_queued: 0, runs_to_analyze: 5, calls_planned: 5, calls_worst_case_with_retries: 20 });
    expect(est.limits).toMatchObject({ daily_calls_limit: 250, calls_used_today: 0, calls_left_today: 250, model_daily_limit: 3, model_calls_left_today: 3, calls_possible_now: 3, calls_per_day_at_most: 3 });
    expect(est.days_needed_including_today).toBe(2); // 3 dziś + 2 jutro
    expect(est.warnings.join(" ")).toMatch(/pozwala jeszcze na 3 wywołań, a potrzeba 5/);
    expect(est.time_estimate).toBeNull(); // brak wcześniejszych udanych przebiegów: nie zgadujemy
    expect(est.next_step).toMatch(/estimate_only=false/);
    expect(w.geminiCalls ?? []).toHaveLength(0);
    expect(await sql("SELECT COUNT(*) AS n FROM vis")).toEqual([{ n: 0 }]);
    expect((await stub().status(job)).vision).toMatchObject({ ok: 0, in_progress: 0, failed: 0, not_analyzed: 5, batches: [] });
  });

  it("estimate_only=false zleca tylko brakujące; wyniki trafiają do statusu zadania i do eksportu; ponowne uruchomienie nic nie wydaje", async () => {
    const job = await makeJob(5);
    const first = await stub().startVision({ jobId: job, fps: [1], model: MODEL, estimateOnly: false });
    expect(first).toMatchObject({ estimate_only: false, queued_runs: 5, runs_to_analyze: 5 });
    expect(first.batch_id).toMatch(/^b-/);
    await finish();
    expect(w.geminiCalls).toHaveLength(5);
    const st = await stub().status(job);
    expect(st.vision).toMatchObject({ ok: 5, in_progress: 0, failed: 0, not_analyzed: 0 });
    expect(st.vision.batches).toEqual([expect.objectContaining({ batch_id: first.batch_id, model: MODEL, fps: [1], runs: 5 })]);
    expect((await stub().visionBatch(first.batch_id)).counts).toEqual({ ok: 5, pending: 0, failed: 0, cancelled: 0 });
    // drugie uruchomienie (i sam szacunek): wszystko już zrobione, zero nowych wywołań
    const again = await stub().startVision({ jobId: job, fps: [1], model: MODEL, estimateOnly: false });
    expect(again).toMatchObject({ batch_id: null, runs_already_done: 5, runs_to_analyze: 0 });
    expect(await stub().startVision({ jobId: job, fps: [1], model: MODEL })).toMatchObject({ estimate_only: true, runs_to_analyze: 0, days_needed_including_today: 0 });
    await finish();
    expect(w.geminiCalls).toHaveLength(5);
    // szacunek korzysta z faktycznych czasów i zużycia z poprzednich przebiegów
    const withHist = await stub().startVision({ jobId: job, fps: [1], model: MODEL, skipDone: false });
    expect(withHist.runs_to_analyze).toBe(5);
    expect(withHist.tokens_estimate).toEqual({ avg_tokens_per_call_from_past_runs: 1000, total_for_planned_calls: 5000 });
    expect(withHist.time_estimate.concurrency).toBe(2);
    // skip_done=false zleca ponownie (świadome wydanie limitu)
    expect(await stub().startVision({ jobId: job, fps: [1], model: MODEL, skipDone: false, estimateOnly: false })).toMatchObject({ queued_runs: 5 });
    await finish();
    expect(w.geminiCalls).toHaveLength(10);
    // eksport: wizja każdej rolki wspólnie z resztą danych
    await runExport(job);
    const rows = JSON.parse((await stub().exportChunks(job, "json")).join(""));
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.vision_status).toBe("ok");
      expect(r.vision.images).toHaveLength(1);
      expect(r.vision.run.raw_response_status).toBe("included");
    }
    expect(JSON.parse((await stub().exportChunks(job, "status")).join("")).counts.vision_status).toEqual({ ok: 5 });
  });

  it("limit dobowy: rolki czekają w kolejce (nie błąd), są pomijane przy kolejnym uruchomieniu, a po zwolnieniu limitu kończą się bez dubli", async () => {
    await setEnv({ GEMINI_DAILY_CALLS: "2" });
    const job = await makeJob(5);
    const run = await stub().startVision({ jobId: job, fps: [1], model: MODEL, estimateOnly: false });
    expect(run.limits.calls_possible_now).toBe(2);
    expect(run.warnings.join(" ")).toMatch(/potrzeba 5/);
    await settle();
    expect(w.geminiCalls).toHaveLength(2);
    const st = await stub().status(job);
    expect(st.vision).toMatchObject({ ok: 2, in_progress: 3, failed: 0, not_analyzed: 0 });
    const b = await stub().visionBatch(run.batch_id);
    expect(b.counts).toEqual({ ok: 2, pending: 3, failed: 0, cancelled: 0 });
    expect(b.queue_state.blocks[0]).toMatchObject({ kind: "limit_dobowy", runs: 3 });
    // ponowne zlecenie w tym czasie: wszystko albo gotowe, albo już w kolejce
    expect(await stub().startVision({ jobId: job, fps: [1], model: MODEL, estimateOnly: false })).toMatchObject({ batch_id: null, runs_already_done: 2, runs_already_queued: 3, runs_to_analyze: 0 });
    // „następna doba”: limit się zwalnia
    await sql("DELETE FROM budget WHERE name='gemini_calls'");
    await setEnv({ GEMINI_DAILY_CALLS: "250" });
    await finish();
    expect(w.geminiCalls).toHaveLength(5);
    expect((await stub().status(job)).vision).toMatchObject({ ok: 5, in_progress: 0, failed: 0, not_analyzed: 0 });
    // każda rolka analizowana dokładnie raz
    const urls = w.geminiCalls!.map((c) => c.url!.slice(-11));
    expect(new Set(urls).size).toBe(5);
  });

  it("duża kolejka wizji nie głodzi zbierania: gdy pracuje zadanie, alarmy idą na zmianę (wizja, zbieranie)", async () => {
    await setEnv({ GEMINI_DAILY_CALLS: "1000" }); // domyślny bezpiecznik 250 mniejszy niż 400 przebiegów testu
    const batch = (from: number) => Array.from({ length: 200 }, (_, i) => "ZZZZZZZ" + String(from + i).padStart(4, "0"));
    await stub().startVision({ videos: batch(0), fps: [1], model: MODEL });
    await stub().startVision({ videos: batch(200), fps: [1], model: MODEL }); // 400 przebiegów = 10 alarmów samej wizji
    const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count: 50, transcriptMode: "native", lang: null });
    let done = false, pendingAtDone = -1;
    for (let i = 0; i < 40 && !done; i++) {
      await runDurableObjectAlarm(stub());
      if (!(await stub().status(job_id)).running) { done = true; pendingAtDone = Number((await sql("SELECT COUNT(*) AS n FROM vis WHERE status='pending'"))[0].n); }
    }
    expect(done).toBe(true);
    // zadanie skończyło się, a kolejka wizji wciąż ma zaległości (bez poprawki zbieranie czekałoby na koniec całej kolejki)
    expect(pendingAtDone).toBeGreaterThan(0);
    expect((await stub().status(job_id)).complete).toBe(true);
    await finish(); // reszta wizji i tak się kończy
    expect(w.geminiCalls).toHaveLength(400);
  }, 120000);

  it("nieudane rolki są widoczne w statusie jako failed i da się je ponowić (retry_batch)", async () => {
    await setEnv({ GEMINI_MAX_ATTEMPTS: "1" });
    const job = await makeJob(5);
    let n = 0;
    w.gemini = () => (++n === 3 ? new Response(JSON.stringify({ error: { code: 400, message: "bad" } }), { status: 400 }) : ok());
    const run = await stub().startVision({ jobId: job, fps: [1], model: MODEL, estimateOnly: false });
    await finish();
    expect((await stub().status(job)).vision).toMatchObject({ ok: 4, in_progress: 0, failed: 1, not_analyzed: 0 });
    w.gemini = () => ok();
    await stub().startVision({ retryBatch: run.batch_id, fps: [1], model: null });
    await finish();
    expect((await stub().status(job)).vision).toMatchObject({ ok: 5, failed: 0 });
  });

  it("walidacja: job_id razem z video, nieznane zadanie, zły fps, brak klucza; list_collections nie liczy wizji", async () => {
    const job = await makeJob(5);
    await expect(rej(stub().startVision({ jobId: job, video: "VbJLBRLiu_U", fps: [1], model: null }))).rejects.toThrow(/albo job_id.*albo video/);
    await expect(rej(stub().startVision({ jobId: "c-nie-ma", fps: [1], model: null }))).rejects.toThrow(/Nie ma zadania/);
    await expect(rej(stub().startVision({ jobId: job, fps: [0], model: null }))).rejects.toThrow(/fps/);
    await expect(rej(stub().startVision({ fps: [1], model: null }))).rejects.toThrow(/video, videos albo job_id/);
    await setEnv({ GEMINI_API_KEY: undefined });
    await expect(rej(stub().startVision({ jobId: job, fps: [1], model: null }))).rejects.toThrow(/GEMINI_API_KEY/);
    expect((await stub().list(10)).collections[0].vision).toBeUndefined();
  });

  it("narzędzie MCP: domyślnie estimate_only=true i skip_done=true; złe typy odrzucone", async () => {
    let got: any = null;
    const fake = { startVision: async (p: any) => { got = p; return { ok: true }; } };
    await dispatch({} as any, "https://x", fake, "analyze_images", { job_id: "c-1" });
    expect(got).toMatchObject({ jobId: "c-1", estimateOnly: true, skipDone: true, fps: [1] });
    await dispatch({} as any, "https://x", fake, "analyze_images", { job_id: "c-1", estimate_only: false, skip_done: false });
    expect(got).toMatchObject({ estimateOnly: false, skipDone: false });
    await dispatch({} as any, "https://x", fake, "analyze_images", { job_id: "c-1", estimate_only: "false", skip_done: "true" }); // tekstowe wartości logiczne starszych klientów
    expect(got).toMatchObject({ estimateOnly: false, skipDone: true });
    await expect(dispatch({} as any, "https://x", fake, "analyze_images", { job_id: "c-1", estimate_only: "nie" })).rejects.toThrow(/true albo false/);
  });
});
