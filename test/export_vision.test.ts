import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { buildWorld, installFetch, stub, drive, runExport, resetStore, setEnv, type World } from "./helpers";
import { COLUMNS, CSV_COLUMNS, parseCsv } from "../src/csv";
import { RAW_EXPORT_MAX_CHARS } from "../src/sets";

let w: World;
const sql = async (q: string, ...args: unknown[]) =>
  (runInDurableObject as any)(stub(), (inst: any) => inst.ctx.storage.sql.exec(q, ...args).toArray());
const ok = (payload: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, modelVersion: "gemini-3.5-flash-lite" }), { status: 200 });
const photo = {
  id: 1, first_visible: "0:00.0", last_visible: "0:02.0", appearances: [{ from: "0:00.0", to: "0:02.0" }], sent_by: "Son",
  description_pl: "Czarny pad owinięty taśmą.", text_in_image: null,
  messages_before: [], messages_after: [{ t: "0:00.0", sender: "Son", text: "I need a controller!!!" }],
  related_messages: [
    { t: "0:00.0", sender: "Son", text: "I need a controller!!!", basis: "explicit", reason_pl: "wprost o padzie" },
    { t: "0:05.0", sender: "Dad", text: "Oh no", basis: "assumption", reason_pl: "reakcja" },
  ],
  uncertainty_pl: null,
};
async function finish() {
  for (let i = 0; i < 400; i++) {
    await runDurableObjectAlarm(stub());
    const busy = await (runInDurableObject as any)(stub(), (inst: any) =>
      inst.ctx.storage.sql.exec("SELECT status, next_at FROM vis WHERE status IN ('pending','running')").toArray().some((r: any) => r.status === "running" || Number(r.next_at) <= Date.now()));
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}

beforeEach(async () => {
  await resetStore();
  w = buildWorld(60, { none: [2] });
  installFetch(w);
  await setEnv({ GEMINI_MIN_START_INTERVAL_MS: "0", GEMINI_RETRY_DELAYS_S: "0", GEMINI_API_KEY: "K", GEMINI_MODEL_LIMITS: "{}", GEMINI_CANCEL_BATCHES: "" });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("eksport: wyniki wizji i status czasów", () => {
  it("wizja trafia do json/csv/md automatycznie; powiązania zostają oceną modelu; brak analizy ma jawny status", async () => {
    const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count: 5, transcriptMode: "native", lang: null });
    expect((await drive(job_id)).complete).toBe(true);
    const target = w.videos[1].id;
    w.gemini = () => ok({ video_duration_s: 30, messages: [{ t: "0:00.0", sender: "Son", text: "I need a controller!!!" }], images: [photo], no_images_found: false, unclear_ranges: [], notes_pl: null });
    await stub().startVision({ video: target, fps: [1], model: "gemini-3.5-flash-lite" });
    await finish();
    await runExport(job_id);
    const rows = JSON.parse((await stub().exportChunks(job_id, "json")).join(""));
    const r = rows.find((x: any) => x.video_id === target);
    expect(r.vision_status).toBe("ok");
    expect(r.vision.model).toBe("gemini-3.5-flash-lite");
    expect(r.vision.images).toHaveLength(1);
    const im = r.vision.images[0];
    expect(im.description_pl).toBe("Czarny pad owinięty taśmą.");
    expect(im.first_visible).toBe("0:00.0");
    expect(im.related_messages[0].model_basis).toBe("explicit");
    expect(im.related_messages[0].link_status_pl).toMatch(/ocena modelu.*nie potwierdzona przez człowieka/);
    expect(im.related_messages[1].link_status_pl).toMatch(/przypuszczenie modelu/);
    expect(im.verification_pl).toMatch(/niezweryfikowane/);
    expect(r.vision.frames.available).toBe(false);
    expect(r.vision.messages).toHaveLength(1);
    const other = rows.find((x: any) => x.video_id === w.videos[3].id);
    expect(other.vision_status).toBe("not_analyzed");
    expect(other.vision).toBeNull();
    // CSV
    const grid = parseCsv((await stub().exportChunks(job_id, "csv")).join("").replace(/^﻿/, ""));
    const row = grid.slice(1).find((g) => g[4].endsWith(target))!;
    expect(row[COLUMNS.indexOf("vision_status")]).toBe("ok");
    expect(row[COLUMNS.indexOf("vision")]).toMatch(/Czarny pad/);
    expect(row[COLUMNS.indexOf("vision")]).toMatch(/ocena modelu/);
    // Markdown
    const md = (await stub().exportChunks(job_id, "md-1")).join("");
    expect(md).toContain("Zdjęcia i wiadomości w rozmowie (odczyt modelu Gemini)");
    expect(md).toContain("Czarny pad owinięty taśmą.");
    expect(md).toContain("ocena modelu: wiadomość wprost odnosi się do zdjęcia");
    expect(md).toContain("rolka nie była analizowana pod kątem zdjęć");
    expect(md).toContain("Obrazów (zrzutów klatek) nie ma w eksporcie");
    // status
    const st = JSON.parse((await stub().exportChunks(job_id, "status")).join(""));
    expect(st.records.find((x: any) => x.video_id === target).vision_status).toBe("ok");
  });

  it("pełna wizja bez utraty: CSV (vision_json + czytelny tekst), JSON (vision.run z oryginalną odpowiedzią i SHA-256), Markdown (linia techniczna), liczniki w statusie", async () => {
    const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count: 5, transcriptMode: "native", lang: null });
    expect((await drive(job_id)).complete).toBe(true);
    const target = w.videos[1].id;
    const rich = {
      ...photo, text_in_image: "1+1=?", uncertainty_pl: "Zdjęcie widoczne krótko.",
      messages_before: [{ t: "0:00.0", sender: "Dad", text: "Look at this, \"quote\", comma" }, { t: "0:00.5", sender: "Son", text: "=SUM(1)" }],
    };
    const payload = { video_duration_s: 30, messages: [{ t: "0:00.0", sender: "Son", text: "I need a controller!!!" }], images: [rich], no_images_found: false, unclear_ranges: [{ from: "0:10.0", to: "0:12.0", reason_pl: "rozmyte" }], notes_pl: "uwaga modelu" };
    const bodyText = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, modelVersion: "gemini-3.5-flash-lite" });
    w.gemini = () => new Response(bodyText, { status: 200 });
    await stub().startVision({ video: target, fps: [1], model: "gemini-3.5-flash-lite" });
    await finish();
    await runExport(job_id);
    const rows = JSON.parse((await stub().exportChunks(job_id, "json")).join(""));
    const r = rows.find((x: any) => x.video_id === target);
    // JSON: oryginalna odpowiedź API bez zmian + hash + dane techniczne
    const run = r.vision.run;
    expect(run.raw_response).toBe(bodyText);
    expect(run.raw_response_status).toBe("included");
    expect(run.raw_response_chars).toBe(bodyText.length);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText));
    expect(run.raw_response_sha256).toBe([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    expect(run).toMatchObject({ model_requested: "gemini-3.5-flash-lite", model_version: "gemini-3.5-flash-lite", attempt: 1, http_status: 200, finish_reason: "STOP", video_duration_s: 30, no_images_found: false });
    expect(run.usage.totalTokenCount).toBe(15);
    expect(run.params.responseMimeType).toBe("application/json");
    expect(JSON.parse(JSON.parse(run.raw_response).candidates[0].content.parts[0].text)).toEqual(payload); // z oryginału da się odtworzyć cały wynik
    expect(r.vision.images[0].messages_before).toHaveLength(2);
    // CSV: ta sama wizja w vision_json (bez surowej odpowiedzi), długość i czytelny tekst z wiadomościami przed/po
    const grid = parseCsv((await stub().exportChunks(job_id, "csv")).join("").replace(/^﻿/, ""));
    expect(grid[0]).toEqual([...CSV_COLUMNS]);
    expect(CSV_COLUMNS.slice(0, COLUMNS.length)).toEqual([...COLUMNS]); // dotychczasowe kolumny na tych samych miejscach
    const row = grid.slice(1).find((g) => g[COLUMNS.indexOf("video_id")] === target)!;
    const cell = row[CSV_COLUMNS.indexOf("vision_json")];
    const { raw_response: _omit, ...runNoRaw } = run;
    expect(JSON.parse(cell)).toEqual({ ...r.vision, run: { ...runNoRaw, raw_response_note: expect.stringMatching(/tylko w pliku JSON/) } });
    expect(row[CSV_COLUMNS.indexOf("vision_json_chars")]).toBe(String(cell.length));
    expect(cell).not.toContain('"candidates"'); // surowej odpowiedzi w CSV nie ma (candidatesTokenCount w zużyciu to co innego)
    const text = row[COLUMNS.indexOf("vision")];
    expect(text).toMatch(/wiadomości przed: 0:00\.0 Dad: Look at this, "quote", comma \| 0:00\.5 Son: =SUM\(1\)/);
    expect(text).toMatch(/wiadomości po: 0:00\.0 Son: I need a controller!!!/);
    expect(text).toMatch(/tekst na zdjęciu: 1\+1=\?/);
    expect(text).toMatch(/niepewność wg modelu: Zdjęcie widoczne krótko\./);
    const none = grid.slice(1).find((g) => g[COLUMNS.indexOf("video_id")] === w.videos[3].id)!;
    expect(none[CSV_COLUMNS.indexOf("vision_json")]).toBe("");
    expect(none[CSV_COLUMNS.indexOf("vision_json_chars")]).toBe("");
    // Markdown: linia techniczna z hashem, bez pełnej odpowiedzi
    const md = (await stub().exportChunks(job_id, "md-1")).join("");
    expect(md).toContain(`SHA-256 ${run.raw_response_sha256}`);
    expect(md).toContain("finish_reason STOP");
    expect(md).toContain("tokeny 15");
    expect(md).not.toContain('"candidates"');
    // status: liczniki wizji
    const st = JSON.parse((await stub().exportChunks(job_id, "status")).join(""));
    expect(st.counts.vision_status).toEqual({ ok: 1, not_analyzed: 4 });
    expect(st.definitions.vision_json).toMatch(/32767/);
    expect(st.definitions.vision_run).toMatch(/raw_response/);
  });

  it("oryginalna odpowiedź: brak w bazie = not_stored; zbyt duża nie jest dołączana, ale eksport działa, a partie zostają małe", async () => {
    const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count: 5, transcriptMode: "native", lang: null });
    expect((await drive(job_id)).complete).toBe(true);
    const [a, b, c, d] = [w.videos[0].id, w.videos[1].id, w.videos[3].id, w.videos[4].id];
    w.gemini = () => ok({ video_duration_s: 30, messages: [], images: [photo], no_images_found: false, unclear_ranges: [], notes_pl: null });
    await stub().startVision({ videos: [a, b, c, d], fps: [1], model: "gemini-3.5-flash-lite" });
    await finish();
    await sql("UPDATE vis SET state = json_set(state, '$.raw', NULL) WHERE vid=?", a);
    await sql("UPDATE vis SET state = json_set(state, '$.raw', ?) WHERE vid=?", "x".repeat(RAW_EXPORT_MAX_CHARS + 1), b);
    await sql("UPDATE vis SET state = json_set(state, '$.raw', ?) WHERE vid=?", "y".repeat(150_000), c); // duża, ale mieści się
    await runExport(job_id);
    const rows = JSON.parse((await stub().exportChunks(job_id, "json")).join(""));
    const g = (id: string) => rows.find((x: any) => x.video_id === id).vision.run;
    expect(g(a)).toMatchObject({ raw_response_status: "not_stored", raw_response: null, raw_response_chars: null, raw_response_sha256: null });
    expect(g(b)).toMatchObject({ raw_response_status: "omitted_too_large", raw_response: null, raw_response_chars: RAW_EXPORT_MAX_CHARS + 1, raw_response_sha256: null });
    expect(g(c).raw_response_status).toBe("included");
    expect(g(c).raw_response).toBe("y".repeat(150_000));
    expect(g(d).raw_response_status).toBe("included");
    for (const fmt of ["json", "csv", "md-1"]) for (const ch of await stub().exportChunks(job_id, fmt)) expect(ch.length).toBeLessThan(900_000); // wiersz bazy ma 2 MB
    const md = (await stub().exportChunks(job_id, "md-1")).join("");
    expect(md).toContain("zbyt duża na eksport");
    expect(md).toContain("oryginalnej odpowiedzi API nie zapisano");
    const st = JSON.parse((await stub().exportChunks(job_id, "status")).join(""));
    expect(st.counts.vision_status).toEqual({ ok: 4, not_analyzed: 1 });
  });

  it("nowy wynik wizji po eksporcie: te same parametry nie zwracają starego zestawu; bez zmian zestaw jest używany ponownie", async () => {
    const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count: 5, transcriptMode: "native", lang: null });
    expect((await drive(job_id)).complete).toBe(true);
    const target = w.videos[1].id;
    const first = await runExport(job_id);
    expect((await runExport(job_id)).set_id).toBe(first.set_id); // nic się nie zmieniło: ten sam zestaw
    const before = JSON.parse((await stub().exportChunks(job_id, "json")).join("")).find((x: any) => x.video_id === target);
    expect(before.vision_status).toBe("not_analyzed");
    w.gemini = () => ok({ video_duration_s: 30, messages: [{ t: "0:00.0", sender: "Son", text: "I need a controller!!!" }], images: [photo], no_images_found: false, unclear_ranges: [], notes_pl: null });
    await stub().startVision({ video: target, fps: [1], model: "gemini-3.5-flash-lite" });
    await finish();
    const after = await runExport(job_id);
    expect(after.set_id).not.toBe(first.set_id); // wizja doszła po eksporcie: powstaje nowy zestaw
    const row = JSON.parse((await stub().exportChunks(job_id, "json")).join("")).find((x: any) => x.video_id === target);
    expect(row.vision_status).toBe("ok");
    expect(row.vision.images).toHaveLength(1);
    expect((await runExport(job_id)).set_id).toBe(after.set_id); // po zmianie znów stabilnie ten sam zestaw
  });

  it("CSV: tekst zaczynający się od = + - @ dostaje apostrof (ochrona przed formułami); JSON, liczby i ID bez zmian", async () => {
    const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count: 5, transcriptMode: "native", lang: null });
    expect((await drive(job_id)).complete).toBe(true);
    const [a, b, c] = [w.videos[0].id, w.videos[1].id, w.videos[3].id];
    await sql("UPDATE items SET title=? WHERE vid=?", '=HYPERLINK("http://x","klik")', a);
    await sql("UPDATE items SET title=? WHERE vid=?", "-2+3 to nie formuła, ale zaczyna się od minusa", b);
    await runExport(job_id);
    const grid = parseCsv((await stub().exportChunks(job_id, "csv")).join("").replace(/^﻿/, ""));
    const cell = (vid: string, col: string) => grid.slice(1).find((g) => g[COLUMNS.indexOf("video_id")] === vid)![COLUMNS.indexOf(col as any)];
    expect(cell(a, "title")).toBe(`'=HYPERLINK("http://x","klik")`);
    expect(cell(b, "title")).toBe("'-2+3 to nie formuła, ale zaczyna się od minusa");
    const normal = JSON.parse((await stub().exportChunks(job_id, "json")).join("")).find((x: any) => x.video_id === c);
    expect(cell(c, "title")).toBe(normal.title); // zwykły tytuł bez zmian
    const json = JSON.parse((await stub().exportChunks(job_id, "json")).join(""));
    expect(json.find((x: any) => x.video_id === a).title).toBe('=HYPERLINK("http://x","klik")'); // JSON zostaje surowy
    expect(cell(a, "views")).toBe(String(json.find((x: any) => x.video_id === a).views ?? "")); // liczby nietknięte
  });

  it("status czasów: ok / brak transkryptu / przyczyna zapisana / rekord sprzed zapisu przyczyny; odczyt z bazy przez read_collection", async () => {
    const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count: 5, transcriptMode: "native", lang: null });
    expect((await drive(job_id)).complete).toBe(true);
    const a = w.videos[0].id, b = w.videos[1].id, c = w.videos[3].id;
    await sql("UPDATE items SET segs=NULL, sgst=NULL WHERE vid=?", a);
    await sql("UPDATE items SET segs=NULL, sgst='no_segments_in_response' WHERE vid=?", b);
    await runExport(job_id);
    const rows = JSON.parse((await stub().exportChunks(job_id, "json")).join(""));
    const g = (id: string) => rows.find((x: any) => x.video_id === id);
    expect(g(a).transcript_timed_status).toBe("unknown_not_recorded");
    expect(g(b).transcript_timed_status).toBe("no_segments_in_response");
    expect(g(c).transcript_timed_status).toBe("ok");
    expect(g(w.videos[2].id).transcript_timed_status).toBe("no_transcript");
    const md = (await stub().exportChunks(job_id, "md-1")).join("");
    expect(md).toMatch(/Czasy transkryptu: brak: Supadata zwróciło sam tekst bez segmentów/);
    expect(md).toMatch(/Czasy transkryptu: brak segmentów w bazie; przyczyny nie zapisano/);
    const read = await stub().read(job_id, null, 80000);
    const rc = read.items.find((x: any) => x.video_id === c);
    expect(rc.timed_status).toBe("ok");
    expect(rc.timed_segments).toBeGreaterThan(1);
    expect(read.items.find((x: any) => x.video_id === a).timed_segments).toBe(0);
    expect(read.items.find((x: any) => x.video_id === a).timed_status).toBe("unknown_not_recorded");
    // nowo pobrane transkrypty zapisują przyczynę (sgst) razem z segmentami
    const s = await sql("SELECT sgst FROM items WHERE vid=?", c);
    expect(String(s[0].sgst)).toBe("ok");
  });
});
