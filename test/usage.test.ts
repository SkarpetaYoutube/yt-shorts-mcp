import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { runDurableObjectAlarm } from "cloudflare:test";
import { buildWorld, installFetch, stub, resetStore, runExport, setEnv, expectedText } from "./helpers";

beforeEach(resetStore);
afterEach(() => vi.unstubAllGlobals());

// Pomiar liczby operacji (NIE czasu CPU — tego lokalnie nie da się zmierzyć) dla 20/100/500 Shortsów, tryb newest.
for (const n of [20, 100, 500]) {
  it(`zużycie operacji dla ${n} Shortsów`, async () => {
    const w = buildWorld(Math.max(600, n + 50), { long: { 1: 44000 } });
    installFetch(w);
    await setEnv({ SUPADATA_DAILY_CREDIT_BUDGET: "2000" });
    const s = stub();
    const { job_id } = await s.startJob({ channel: "@przyklad", mode: "newest", count: n, transcriptMode: "native", lang: null });
    let alarms = 0, maxSub = 0;
    for (let i = 0; i < 3000; i++) {
      const st = await s.status(job_id);
      if (!st.running) break;
      const b = w.calls.yt + w.calls.sd;
      await runDurableObjectAlarm(s); alarms++;
      maxSub = Math.max(maxSub, w.calls.yt + w.calls.sd - b);
    }
    const st = await s.status(job_id);
    expect(st.complete).toBe(true);
    expect(st.progress.ok).toBe(n);
    const exp0 = alarms;
    await runExport(job_id);
    const info = await s.exportInfo(job_id);
    expect(info.phase).toBe("ready");
    const rows = JSON.parse((await s.exportChunks(job_id, "json")).join(""));
    expect(rows).toHaveLength(n);
    expect(rows[1].transcript).toBe(expectedText(w.videos[1].text));
    const csvBytes = info.files.csv.bytes, jsonBytes = info.files.json.bytes;
    const usage = await s.usage();
    expect(maxSub).toBeLessThanOrEqual(50);
    expect(usage.supadata_credits_today).toBe(n);
    expect(usage.youtube_units_today).toBe(w.calls.yt);
    expect(csvBytes).toBeGreaterThan(0);
    expect(jsonBytes).toBeGreaterThan(0);
  }, 120000);
}
