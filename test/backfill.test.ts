import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { buildWorld, installFetch, stub, drive, runExport, resetStore, rej, expectedText, type World } from "./helpers";
import { dispatch } from "../src/mcp";

// Uzupełnianie znaczników czasu transkrypcji zapisanych starszą wersją serwera (continue_collection z fill_timestamps):
// segmenty z pamięci podręcznej, bez zapytań sieciowych i bez kredytów; tylko gdy złożone dają dokładnie zapisany tekst.

let w: World;
const sql = async (q: string, ...args: unknown[]) =>
  (runInDurableObject as any)(stub(), (inst: any) => inst.ctx.storage.sql.exec(q, ...args).toArray());

beforeEach(async () => {
  await resetStore();
  w = buildWorld(60, { none: [2] });
  installFetch(w);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("uzupełnianie znaczników czasu (fill_timestamps)", () => {
  it("rekordy sprzed zapisu segmentów dostają czasy z pamięci podręcznej: 0 zapytań, 0 kredytów, nowy eksport, reszta bez zmian", async () => {
    const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count: 8, transcriptMode: "native", lang: null });
    expect((await drive(job_id)).complete).toBe(true);
    const ids = w.videos.slice(0, 8).map((v) => v.id);
    const before = JSON.parse((await runExport(job_id), (await stub().exportChunks(job_id, "json")).join("")));
    // symulacja starszej wersji: bez segmentów i bez zapisanej przyczyny
    for (const id of [ids[0], ids[1], ids[3], ids[4], ids[5], ids[6]]) await sql("UPDATE items SET segs=NULL, sgst=NULL WHERE vid=?", id);
    await sql("UPDATE items SET segs=NULL, sgst='no_segments_in_response' WHERE vid=?", ids[7]); // przyczyna znana: nie ruszać
    await sql("DELETE FROM cache WHERE k LIKE ?", `%${ids[1]}`); // brak odpowiedzi w pamięci podręcznej
    await sql("UPDATE items SET transcript = transcript || ' DOPISEK', chars = chars + 8 WHERE vid=?", ids[3]); // zapisany tekst różni się od odpowiedzi
    await sql("UPDATE cache SET v = ? WHERE k LIKE ?", JSON.stringify({ lang: "pl", content: "sam tekst bez segmentów" }), `%${ids[4]}`); // odpowiedź bez segmentów
    const sdBefore = w.calls.sd, ytBefore = w.calls.yt;
    const creditsBefore = (await stub().usage()).supadata_credits_today;
    const res = await stub().backfillTimestamps(job_id);
    expect(res).toMatchObject({ candidates: 6, filled: 3, mismatch_not_stored: 1, no_segments_in_cached_response: 1, cache_missing: 1, credits_used: 0, cache_missing_ids: [ids[1]] });
    expect(res.note).toMatch(/kredyty/);
    expect(w.calls.sd).toBe(sdBefore); // zero zapytań do Supadata i YouTube
    expect(w.calls.yt).toBe(ytBefore);
    expect((await stub().usage()).supadata_credits_today).toBe(creditsBefore);
    const info = await runExport(job_id);
    const after = JSON.parse((await stub().exportChunks(job_id, "json")).join(""));
    expect(info.set_id).toBeTruthy();
    const by = (rows: any[], id: string) => rows.find((r) => r.video_id === id);
    for (const id of [ids[0]]) {
      const r = by(after, id);
      expect(r.transcript_timed_status).toBe("ok");
      expect(r.transcript_timed.map((s: any) => s.text).join(" ")).toBe(r.transcript);
      expect(r.transcript).toBe(expectedText(w.videos[ids.indexOf(id)].text));
      expect(r.transcript_timed).toEqual(by(before, id).transcript_timed); // te same segmenty, co przy pierwotnym pobraniu
    }
    expect(by(after, ids[5]).transcript_timed_status).toBe("ok");
    expect(by(after, ids[6]).transcript_timed_status).toBe("ok");
    expect(by(after, ids[1]).transcript_timed_status).toBe("unknown_not_recorded"); // brak w pamięci podręcznej: bez zgadywania
    expect(by(after, ids[3]).transcript_timed_status).toBe("mismatch_not_stored");
    expect(by(after, ids[4]).transcript_timed_status).toBe("no_segments_in_response");
    expect(by(after, ids[7]).transcript_timed_status).toBe("no_segments_in_response"); // znana przyczyna nietknięta
    expect(by(after, ids[2]).transcript_timed_status).toBe("no_transcript");
    // reszta danych nietknięta
    for (const r of after) if (r.video_id !== ids[3]) expect(r.transcript).toBe(by(before, r.video_id).transcript);
    expect(by(after, ids[3]).transcript).toMatch(/ DOPISEK$/); // tekstu nie nadpisujemy
    // ponowne uruchomienie: zostały tylko te bez pamięci podręcznej
    expect(await stub().backfillTimestamps(job_id)).toMatchObject({ candidates: 1, filled: 0, cache_missing: 1 });
  });

  it("zadanie bez kandydatów: 0 zmian, eksport nie jest unieważniany; zadanie w toku odrzucone; narzędzie MCP", async () => {
    const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count: 5, transcriptMode: "native", lang: null });
    expect((await drive(job_id)).complete).toBe(true);
    const first = await runExport(job_id);
    expect(await stub().backfillTimestamps(job_id)).toMatchObject({ candidates: 0, filled: 0, cache_missing: 0 });
    expect((await runExport(job_id)).set_id).toBe(first.set_id); // nic się nie zmieniło: ten sam zestaw
    // zadanie w toku
    const run = await stub().startJob({ channel: "@przyklad", mode: "newest", count: 5, transcriptMode: "native", lang: null });
    await expect(rej(stub().backfillTimestamps(run.job_id))).rejects.toThrow(/jeszcze pracuje/);
    // MCP: domyślnie wyłączone, zły typ odrzucony, wynik dołączony do statusu
    const calls: string[] = [];
    const fake = {
      backfillTimestamps: async (id: string) => { calls.push("backfill:" + id); return { filled: 3 }; },
      resume: async () => { calls.push("resume"); },
      status: async () => ({ complete: true, running: false }),
    };
    expect(await dispatch({} as any, "https://x", fake, "continue_collection", { job_id: "c-1", wait_seconds: 0 })).toEqual({ complete: true, running: false });
    expect(calls).toEqual(["resume"]);
    expect(await dispatch({} as any, "https://x", fake, "continue_collection", { job_id: "c-1", wait_seconds: 0, fill_timestamps: true })).toEqual({ complete: true, running: false, timestamps_backfill: { filled: 3 } });
    await expect(dispatch({} as any, "https://x", fake, "continue_collection", { job_id: "c-1", fill_timestamps: "tak" })).rejects.toThrow(/true albo false/);
  });
});
