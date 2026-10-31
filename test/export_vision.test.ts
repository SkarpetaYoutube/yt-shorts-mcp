import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { buildWorld, installFetch, stub, drive, runExport, resetStore, setEnv, type World } from "./helpers";
import { COLUMNS, parseCsv } from "../src/csv";

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
