import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { buildWorld, installFetch, stub, resetStore, setEnv, rej, type World } from "./helpers";
import { compareRuns, tsec } from "../src/vision";

const KEY = "GEMKEY-MARKER-789";
let w: World;
const sql = async (q: string, ...args: unknown[]) => (runInDurableObject as any)(stub(), (inst: any) => inst.ctx.storage.sql.exec(q, ...args).toArray());
const img = (id: number, t: string, desc: string, extra: Record<string, unknown> = {}) => ({
  id, first_visible: t, last_visible: t, appearances: [{ from: t, to: t }], sent_by: "right bubble", description_pl: desc, text_in_image: null,
  messages_before: [{ t: "0:01.0", sender: "Mom", text: "Where are you?" }], messages_after: [{ t: "0:05.0", sender: "Son", text: "At school" }],
  related_messages: [{ t: "0:05.0", sender: "Son", text: "At school", basis: "assumption", reason_pl: "następuje tuż po zdjęciu" }],
  uncertainty_pl: null, ...extra,
});
const result = (images: any[], messages: any[]) => ({ video_duration_s: 30, messages, images, no_images_found: images.length === 0, unclear_ranges: [], notes_pl: null });
const ok = (payload: unknown, model = "gemini-3.8-flash-001") =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1234, candidatesTokenCount: 321 }, modelVersion: model }), { status: 200 });
/** Uruchamia alarmy, aż nic nie jest w toku ani gotowe do startu (zaległe ponowienia z odstępem czekają i nie blokują). */
async function finish() {
  for (let i = 0; i < 400; i++) {
    await runDurableObjectAlarm(stub());
    const busy = await (runInDurableObject as any)(stub(), (inst: any) => {
      const rows = inst.ctx.storage.sql.exec("SELECT status, next_at FROM vis WHERE status IN ('pending','running')").toArray();
      return rows.some((r: any) => r.status === "running" || Number(r.next_at) <= Date.now());
    });
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Kilka alarmów bez czekania na koniec: dla kolejki zablokowanej limitem (rolki czekają do następnej doby). */
async function settle(n = 12) {
  for (let i = 0; i < n; i++) {
    await runDurableObjectAlarm(stub());
    await new Promise((r) => setTimeout(r, 15));
  }
}

beforeEach(async () => {
  await resetStore();
  w = buildWorld(5);
  installFetch(w);
  // testy: bez czekania między startami i ponowieniami
  await setEnv({ GEMINI_MIN_START_INTERVAL_MS: "0", GEMINI_RETRY_DELAYS_S: "0", GEMINI_CONCURRENCY: undefined, GEMINI_DAILY_CALLS: undefined, GEMINI_MAX_ATTEMPTS: undefined, GEMINI_API_KEY: undefined, GEMINI_MODEL_LIMITS: "{}", GEMINI_CANCEL_BATCHES: "" });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("rozpoznawanie zdjęć (Gemini) – atrapa API", () => {
  it("bez klucza: jasny komunikat, nic nie jest wysyłane", async () => {
    await expect(rej(stub().startVision({ video: "https://www.youtube.com/shorts/VbJLBRLiu_U", fps: [1, 5], model: null }))).rejects.toThrow(/GEMINI_API_KEY/);
    expect(w.geminiCalls ?? []).toHaveLength(0);
  });
  it("dwa przebiegi (1 i 5 fps): parametry w zapytaniu, wyniki, porównanie wykrytych/pominiętych, przypuszczenia oznaczone, bez klucza w zapisie", async () => {
    await setEnv({ GEMINI_API_KEY: KEY });
    const msgs1 = [{ t: "0:01.0", sender: "Mom", text: "Where are you?" }];
    const msgs5 = [...msgs1, { t: "0:05.0", sender: "Son", text: "At school" }];
    w.gemini = (fps) => ok(fps === 1 ? result([img(1, "0:03.0", "Zdjęcie klasy")], msgs1) : result([img(1, "0:03.2", "Zdjęcie klasy"), img(2, "0:07.4", "Krótko widoczne zdjęcie psa")], msgs5));
    const r = await stub().startVision({ video: "https://www.youtube.com/shorts/VbJLBRLiu_U", fps: [1, 5], model: null });
    expect(r.runs).toHaveLength(2);
    await finish();
    expect(w.geminiCalls!.map((c) => c.fps).sort()).toEqual([1, 5]);
    for (const c of w.geminiCalls!) {
      expect(c.key).toBe(KEY);
      expect(c.body.contents[0].parts[0].fileData.fileUri).toBe("https://www.youtube.com/watch?v=VbJLBRLiu_U");
      expect(c.body.generationConfig.responseMimeType).toBe("application/json");
    }
    const st = await stub().visionStatus("VbJLBRLiu_U");
    expect(st.runs.map((x: any) => [x.fps, x.status, x.image_status])).toEqual([[1, "ok", "wykryto zdjęcia"], [5, "ok", "wykryto zdjęcia"]]);
    expect(st.runs[0].model_version).toBe("gemini-3.8-flash-001");
    expect(st.runs[0].usage.promptTokenCount).toBe(1234);
    expect(st.comparison.images.in_both).toHaveLength(1);
    expect(st.comparison.images.only_in_b.map((x: any) => x.t)).toEqual(["0:07.4"]);
    expect(st.comparison.messages.only_in_b.map((x: any) => x.text)).toEqual(["At school"]);
    expect(st.images_exported).toBe(false);
    const id5 = st.runs[1].id;
    const raw = (await stub().exportChunks(id5, "json")).join("");
    expect(raw).toContain('"raw"');
    expect(raw).not.toContain(KEY);
    const md = (await stub().exportChunks(id5, "md")).join("");
    expect(md).toContain("PRZYPUSZCZENIE");
    expect(md).toContain("Krótko widoczne zdjęcie psa");
    expect(md).toContain("0:07.4");
  });
  it("API odrzuca parametr: zapisany rzeczywisty błąd (HTTP, treść), przebieg nieudany, klucz zamaskowany", async () => {
    await setEnv({ GEMINI_API_KEY: KEY });
    w.gemini = (fps) => (fps === 5 ? new Response(JSON.stringify({ error: { code: 400, message: `Invalid value for fps (key ${KEY})`, status: "INVALID_ARGUMENT" } }), { status: 400 }) : ok(result([], [])));
    await stub().startVision({ video: "VbJLBRLiu_U", fps: [1, 5], model: null });
    await finish();
    const st = await stub().visionStatus("VbJLBRLiu_U");
    const r5 = st.runs.find((x: any) => x.fps === 5);
    expect(r5.status).toBe("error");
    expect(r5.http_status).toBe(400);
    expect(r5.error).toMatch(/Invalid value for fps/);
    expect(r5.error).not.toContain(KEY);
    expect(r5.image_status).toBe("nie przeanalizowano obrazu");
    const r1 = st.runs.find((x: any) => x.fps === 1);
    expect(r1.image_status).toBe("nie wykryto zdjęć"); // przeanalizowano, zdjęć brak
    expect(st.comparison).toBeNull();
    expect((await stub().exportChunks(r5.id, "json")).join("")).not.toContain(KEY);
  });
  it("odpowiedź bez poprawnego JSON: invalid_output, surowa treść zachowana", async () => {
    await setEnv({ GEMINI_API_KEY: KEY });
    w.gemini = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "to nie jest json" }] }, finishReason: "STOP" }] }), { status: 200 });
    await stub().startVision({ video: "VbJLBRLiu_U", fps: [1], model: null });
    await finish();
    const st = await stub().visionStatus("VbJLBRLiu_U");
    expect(st.runs[0].status).toBe("invalid_output");
    expect((await stub().exportChunks(st.runs[0].id, "json")).join("")).toContain("to nie jest json");
  });
  it("bezpiecznik dzienny zapytań Gemini", async () => {
    await setEnv({ GEMINI_API_KEY: KEY, GEMINI_DAILY_CALLS: "1" });
    w.gemini = () => ok(result([], []));
    const r = await stub().startVision({ video: "VbJLBRLiu_U", fps: [1, 5], model: null });
    await settle();
    const st = await stub().visionStatus("VbJLBRLiu_U");
    expect(w.geminiCalls).toHaveLength(1);
    // wyczerpany bezpiecznik dobowy: druga rolka czeka w kolejce (nie kończy się błędem) i startuje po zwolnieniu limitu
    expect(st.runs.map((x: any) => x.status).sort()).toEqual(["ok", "pending"]);
    const b = await stub().visionBatch(r.batch_id);
    expect(b.queue_state.blocks[0]).toMatchObject({ kind: "limit_dobowy", runs: 1 });
    expect(b.queue_state.blocks[0].reason).toMatch(/dobowy bezpiecznik wywołań Gemini: 1 z 1/);
    await sql("DELETE FROM budget WHERE name='gemini_calls'"); // jak po północy UTC
    await setEnv({ GEMINI_DAILY_CALLS: "250" });
    await finish();
    expect(w.geminiCalls).toHaveLength(2);
    expect((await stub().visionBatch(r.batch_id)).counts).toEqual({ ok: 2, pending: 0, failed: 0, cancelled: 0 });
  });
  it("walidacja i pomocnicze", async () => {
    await setEnv({ GEMINI_API_KEY: KEY });
    await expect(rej(stub().startVision({ video: "zly", fps: [1], model: null }))).rejects.toThrow(/link/);
    await expect(rej(stub().startVision({ video: "VbJLBRLiu_U", fps: [0], model: null }))).rejects.toThrow(/fps/);
    expect(tsec("1:05.3")).toBeCloseTo(65.3);
    expect(tsec("7.4")).toBeCloseTo(7.4);
    const c = compareRuns(result([img(1, "0:10.0", "a")], []), result([], []));
    expect(c.images.only_in_a).toHaveLength(1);
  });

  // ------------------------------------------------------------ kolejka
  const failing = (status: number, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ error: { code: status, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE", ...extra } }), { status, headers: { "retry-after": "0" } });
  const vidOf = (b: any) => String(b.contents[0].parts[0].fileData.fileUri).slice(-11);
  const V = ["AAAAAAAAAA1", "AAAAAAAAAA2", "AAAAAAAAAA3", "AAAAAAAAAA4", "AAAAAAAAAA5", "AAAAAAAAAA6"];

  it("ponawia błąd przejściowy (503): 3 próby, każda liczona do limitu dziennego, wynik w tabeli partii", async () => {
    await setEnv({ GEMINI_API_KEY: KEY });
    let n = 0;
    w.gemini = () => (++n < 3 ? failing(503) : ok(result([img(1, "0:03.0", "Zdjęcie")], [{ t: "0:01.0", sender: "Mom", text: "Hi" }])));
    const r = await stub().startVision({ video: V[0], fps: [1], model: null });
    await finish();
    expect(w.geminiCalls).toHaveLength(3);
    const b = await stub().visionBatch(r.batch_id);
    expect(b.table).toHaveLength(1);
    expect(b.table[0]).toMatchObject({ video_id: V[0], status: "ok", attempts: 3, images_found: 1 });
    expect(b.table[0].attempt_log).toEqual(["1: error HTTP 503 " + b.table[0].attempt_log[0].split("HTTP 503 ")[1], expect.stringMatching(/^2: error HTTP 503/), expect.stringMatching(/^3: ok HTTP 200/)]);
    expect(b.counts).toEqual({ ok: 1, pending: 0, failed: 0, cancelled: 0 });
    expect(b.calls_today).toBe(3);
    expect((await stub().usage()).gemini_calls_today).toBe(3);
    expect(b.tokens_ok_total).toBe(0); // atrapa nie podaje totalTokenCount
  });
  it("nie ponawia błędów trwałych (400)", async () => {
    await setEnv({ GEMINI_API_KEY: KEY });
    w.gemini = () => new Response(JSON.stringify({ error: { code: 400, message: "bad" } }), { status: 400 });
    const r = await stub().startVision({ video: V[0], fps: [1], model: null });
    await finish();
    expect(w.geminiCalls).toHaveLength(1);
    expect((await stub().visionBatch(r.batch_id)).table[0]).toMatchObject({ attempts: 1 });
  });
  it("równoległość nie przekracza ustawionej (2), a 6 rolek się kończy", async () => {
    await setEnv({ GEMINI_API_KEY: KEY });
    w.geminiDelayMs = 80;
    w.gemini = () => ok(result([], []));
    const r = await stub().startVision({ videos: V, fps: [1], model: null });
    expect(r.queued_runs).toBe(6);
    expect(r.concurrency).toBe(2);
    await finish();
    expect(w.geminiMaxInflight).toBe(2);
    const b = await stub().visionBatch(r.batch_id);
    expect(b.counts.ok).toBe(6);
    expect(b.attempts_total).toBe(6);
    expect(b.max_parallel_calls_observed).toBe(2);
    expect(b.table[0].attempt_times[0].started_at).toBeTruthy();
    expect(b.table[0].source).toMatch(/nowy pomiar/);
    expect(b.wall_seconds).toBeGreaterThan(0);
  });
  it("zlecenie dodane w trakcie wiszącego wywołania nie czeka na jego koniec (wolny wątek podejmuje je w tym samym alarmie)", async () => {
    await setEnv({ GEMINI_API_KEY: KEY, GEMINI_CONCURRENCY: "2" });
    const A = "VbJLBRLiu_U", B = "AAAAAAAAAAA";
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });
    // wywołanie dla A wisi do chwili release(), dla B odpowiedź jest natychmiast
    w.gemini = ((_fps: number, body: any) => (String(body.contents[0].parts[0].fileData.fileUri).endsWith(A) ? hang.then(() => ok(result([], []))) : ok(result([], [])))) as any;
    const statusOf = async (vid: string) =>
      (await (runInDurableObject as any)(stub(), (inst: any) => inst.ctx.storage.sql.exec("SELECT status FROM vis WHERE vid=? ORDER BY created DESC", vid).toArray()))[0]?.status;
    const until = async (vid: string, want: string, ms: number) => {
      for (let t = 0; t < ms; t += 100) { if ((await statusOf(vid)) === want) return true; await new Promise((r) => setTimeout(r, 100)); }
      return false;
    };
    await stub().startVision({ video: A, fps: [1], model: null });
    const alarm = runDurableObjectAlarm(stub()); // alarm utknie na wywołaniu A
    try {
      expect(await until(A, "running", 5000)).toBe(true);
      await stub().startVision({ video: B, fps: [1], model: null }); // dodane, gdy A wisi
      expect(await until(B, "ok", 8000)).toBe(true); // B kończy się, zanim A zostanie zwolnione
      expect(await statusOf(A)).toBe("running");
    } finally {
      release();
      await alarm;
    }
    expect(await statusOf(A)).toBe("ok");
  });
  it("odstęp między startami jest zachowany", async () => {
    // odstęp 400 ms i zapas 100 ms na rozrzut planisty: przy 120/100 ms test losowo zawodził pod obciążeniem komputera (mierzymy czas wywołania atrapy, nie moment zapisu startu w kolejce)
    await setEnv({ GEMINI_API_KEY: KEY, GEMINI_MIN_START_INTERVAL_MS: "400", GEMINI_CONCURRENCY: "2" });
    const starts: number[] = [];
    w.gemini = () => { starts.push(Date.now()); return ok(result([], [])); };
    await stub().startVision({ videos: V.slice(0, 3), fps: [1], model: null });
    await finish();
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(300);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(300);
  });
  it("429: wstrzymanie wg Retry-After i ponowienie, bez przekroczenia limitu prób", async () => {
    await setEnv({ GEMINI_API_KEY: KEY, GEMINI_MAX_ATTEMPTS: "2" });
    let n = 0;
    w.gemini = () => (++n === 1 ? new Response(JSON.stringify({ error: { code: 429, message: "quota" } }), { status: 429, headers: { "retry-after": "0" } }) : ok(result([], [])));
    const r = await stub().startVision({ video: V[0], fps: [1], model: null });
    await finish();
    expect(w.geminiCalls).toHaveLength(2);
    expect((await stub().visionBatch(r.batch_id)).table[0]).toMatchObject({ status: "ok", attempts: 2 });
  });
  it("retry_batch ponawia TYLKO nieudane rolki", async () => {
    await setEnv({ GEMINI_API_KEY: KEY, GEMINI_MAX_ATTEMPTS: "2" });
    w.gemini = (_f, body) => (vidOf(body) === V[1] ? failing(503) : ok(result([], [])));
    const r = await stub().startVision({ videos: V.slice(0, 3), fps: [1], model: null });
    await finish();
    let b = await stub().visionBatch(r.batch_id);
    expect(b.counts).toEqual({ ok: 2, pending: 0, failed: 1, cancelled: 0 });
    expect(b.table.find((t: any) => t.video_id === V[1]).attempts).toBe(2);
    const before = w.geminiCalls!.length;
    w.gemini = () => ok(result([img(1, "0:02.0", "x")], []));
    const rr = await stub().startVision({ fps: [1], model: null, retryBatch: r.batch_id });
    expect(rr.videos).toEqual([V[1]]);
    await finish();
    expect(w.geminiCalls!.length - before).toBe(1);
    expect(w.geminiCalls!.slice(before).map((c) => c.url!.slice(-11))).toEqual([V[1]]);
    b = await stub().visionBatch(r.batch_id);
    expect(b.counts).toEqual({ ok: 3, pending: 0, failed: 0, cancelled: 0 });
    expect(b.table.find((t: any) => t.video_id === V[1]).attempts).toBe(3);
  });
  it("każde ponowienie liczy się do limitu dziennego: po wyczerpaniu kolejne próby nie startują", async () => {
    await setEnv({ GEMINI_API_KEY: KEY, GEMINI_DAILY_CALLS: "3" });
    w.gemini = () => failing(503);
    const r = await stub().startVision({ video: V[0], fps: [1], model: null });
    await settle();
    expect(w.geminiCalls).toHaveLength(3);
    const b = await stub().visionBatch(r.batch_id);
    expect(b.table[0].status).toMatch(/^czeka/); // czwarta próba czeka na zwolnienie limitu, nie startuje
    expect(b.table[0].waiting_reason).toMatch(/dobowy bezpiecznik wywołań Gemini: 3 z 3/);
    expect(b.calls_today).toBe(3);
  });
  it("opóźnione ponowienie czeka (nie startuje przed next_at)", async () => {
    await setEnv({ GEMINI_API_KEY: KEY, GEMINI_RETRY_DELAYS_S: "3600" });
    let n = 0;
    w.gemini = () => (++n === 1 ? failing(503) : ok(result([], [])));
    const r = await stub().startVision({ video: V[0], fps: [1], model: null });
    await finish();
    expect(w.geminiCalls).toHaveLength(1);
    const b = await stub().visionBatch(r.batch_id);
    expect(b.pending).toBe(true);
    expect(b.table[0].status).toMatch(/czeka/);
    expect(await stub().visionWaitMs()).toBeGreaterThan(3_000_000);
  });
  it("partia: limit 200 rolek, deduplikacja ID", async () => {
    await setEnv({ GEMINI_API_KEY: KEY });
    await expect(rej(stub().startVision({ videos: Array.from({ length: 201 }, (_, i) => V[0].slice(0, 8) + String(i).padStart(3, "0")), fps: [1], model: null }))).rejects.toThrow(/200/);
    const r = await stub().startVision({ videos: [V[0], `https://www.youtube.com/shorts/${V[0]}`], fps: [1], model: null });
    expect(r.videos).toBe(1);
  });
  it("429 z limitem dobowym: pełna treść błędu, przyczyna, termin; pauza trwała i tylko dla tego modelu", async () => {
    await setEnv({ GEMINI_API_KEY: KEY });
    const body = { error: { code: 429, message: "You exceeded your current quota", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaDimensions: { model: "gemini-3.6-flash" } }] }] } };
    w.gemini = () => new Response(JSON.stringify(body), { status: 429 });
    const r = await stub().startVision({ video: V[0], fps: [1], model: "gemini-3.6-flash" });
    await finish();
    expect(w.geminiCalls).toHaveLength(1);
    const b = await stub().visionBatch(r.batch_id);
    const d = b.distinct_errors[0];
    expect(d.http).toBe(429);
    expect(d.full_error).toContain("GenerateRequestsPerDayPerProjectPerModel-FreeTier");
    expect(d.full_error).not.toContain(KEY);
    expect(d.quota.scope).toBe("day");
    const q = b.queue_state;
    expect(q.pauses_after_429[0]).toMatchObject({ model: "gemini-3.6-flash", active: true });
    expect(q.pauses_after_429[0].cause).toMatch(/limit dobowy/);
    expect(new Date(q.pauses_after_429[0].until).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(b.table[0].waiting_reason).toMatch(/pauza modelu po HTTP 429/);
    expect(b.table[0].next_attempt_not_before).toBeTruthy();
    // inny model nie jest wstrzymany
    w.gemini = () => ok(result([], []));
    const r2 = await stub().startVision({ video: V[1], fps: [1], model: "gemini-3.5-flash-lite" });
    await finish();
    expect((await stub().visionBatch(r2.batch_id)).table[0].status).toBe("ok");
  });
  it("429 bez wskazania limitu: nie zakłada wyczerpania limitu dziennego", async () => {
    await setEnv({ GEMINI_API_KEY: KEY });
    w.gemini = () => new Response(JSON.stringify({ error: { code: 429, message: "Resource exhausted" } }), { status: 429 });
    const r = await stub().startVision({ video: V[0], fps: [1], model: null });
    await finish();
    const p = (await stub().visionBatch(r.batch_id)).queue_state.pauses_after_429[0];
    expect(p.cause).toMatch(/nie jest potwierdzenie wyczerpania limitu dziennego/);
    expect(p.cause).toMatch(/65 s/);
  });
  it("cancel_batch: oczekujące ponowienia są anulowane i nie wznawiają się", async () => {
    await setEnv({ GEMINI_API_KEY: KEY, GEMINI_RETRY_DELAYS_S: "0" });
    w.gemini = () => new Response(JSON.stringify({ error: { code: 429, message: "x" } }), { status: 429 });
    const r = await stub().startVision({ videos: V.slice(0, 2), fps: [1], model: null });
    await finish();
    const c = await stub().startVision({ fps: [1], model: null, cancelBatch: r.batch_id });
    expect(c.cancelled_pending_runs).toBeGreaterThan(0);
    const n = w.geminiCalls!.length;
    await finish();
    expect(w.geminiCalls!.length).toBe(n);
    const b = await stub().visionBatch(r.batch_id);
    expect(b.counts.pending).toBe(0);
    expect(b.counts.cancelled).toBe(2);
    expect(b.table[0].status).toBe("anulowane");
  });
  it("GEMINI_CANCEL_BATCHES anuluje oczekujące przebiegi partii przy najbliższym alarmie", async () => {
    await setEnv({ GEMINI_API_KEY: KEY, GEMINI_MODEL_LIMITS: JSON.stringify({ "model-z": { rpm: 0, tpm: 0, rpd: 1 } }) });
    w.gemini = () => ok(result([], []));
    const r = await stub().startVision({ videos: V.slice(0, 2), fps: [1], model: "model-z" });
    await finish(); // pierwsza rolka przechodzi, druga czeka na własny licznik dobowy
    expect(w.geminiCalls).toHaveLength(1);
    await setEnv({ GEMINI_CANCEL_BATCHES: r.batch_id });
    await finish();
    expect(w.geminiCalls).toHaveLength(1);
    const b = await stub().visionBatch(r.batch_id);
    expect(b.table.map((t: any) => t.status).sort()).toEqual(["anulowane", "ok"]);
  });
  it("limit RPM modelu liczony z ponowieniami: nadmiarowe próby czekają z jawną przyczyną", async () => {
    await setEnv({ GEMINI_API_KEY: KEY, GEMINI_MODEL_LIMITS: JSON.stringify({ "model-x": { rpm: 2, tpm: 0, rpd: 0 } }) });
    w.gemini = () => ok(result([], []));
    const r = await stub().startVision({ videos: V.slice(0, 3), fps: [1], model: "model-x" });
    await finish();
    expect(w.geminiCalls).toHaveLength(2);
    const b = await stub().visionBatch(r.batch_id);
    const waiting = b.table.filter((t: any) => t.status.startsWith("czeka"));
    expect(waiting).toHaveLength(1);
    expect(waiting[0].waiting_reason).toMatch(/limit RPM modelu \(2 prób/);
    expect(await stub().visionWaitMs()).toBeGreaterThan(30_000);
  });
  it("własny licznik dobowy modelu (RPD) blokuje start i podaje przyczynę, bez błędu", async () => {
    await setEnv({ GEMINI_API_KEY: KEY, GEMINI_MODEL_LIMITS: JSON.stringify({ "model-y": { rpm: 0, tpm: 0, rpd: 1 } }) });
    w.gemini = () => ok(result([], []));
    const r = await stub().startVision({ videos: V.slice(0, 2), fps: [1], model: "model-y" });
    await finish();
    expect(w.geminiCalls).toHaveLength(1);
    const b = await stub().visionBatch(r.batch_id);
    const t = b.table.find((x: any) => x.status.startsWith("czeka"));
    expect(t.waiting_reason).toMatch(/własny licznik dobowy modelu: 1 z 1/);
    expect(b.queue_state.explanation).toMatch(/blokad/);
  });
});
