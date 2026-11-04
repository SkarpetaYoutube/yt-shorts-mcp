import { it, expect, beforeEach, afterEach, vi, describe } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { stub, resetStore, setEnv, rej } from "./helpers";
import { dispatch } from "../src/mcp";
import { parseTikTokUrl, splitUrls, normMeta, TT_COLUMNS } from "../src/tiktok";
import { parseCsv } from "../src/csv";

const jsonResp = (b: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...h } });
const U = (user: string, id: string) => `https://www.tiktok.com/@${user}/video/${id}`;

interface TV { id: string; user: string; views: number | null; tr: "ok" | "none" | "empty" | "ai" | "plain"; meta?: "ok" | "photo" | "404" | "500" | "other_platform"; }
interface W { vids: TV[]; calls: { meta: number; tr: number; poll: number; urls: string[] }; fail?: (u: URL) => Response | null; jobs: Map<string, number> }

function mkWorld(vids: TV[]): W { return { vids, calls: { meta: 0, tr: 0, poll: 0, urls: [] }, jobs: new Map() }; }
const textOf = (v: TV) => `Transkrypt ${v.id}: "cytat", ąęł 😀 koniec.`;
const segs = (v: TV) => { const w = textOf(v).split(" "); const out = []; for (let i = 0; i < w.length; i += 3) out.push({ text: w.slice(i, i + 3).join(" "), offset: i * 400, duration: 1500, lang: "en" }); return out; };

function install(w: W) {
  vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    if (url.hostname !== "api.supadata.ai") return new Response("unmocked " + url.href, { status: 599 });
    const f = w.fail?.(url);
    if (f) return f;
    if ((init?.headers as Record<string, string>)?.["x-api-key"] !== "SDKEY-MARKER-456") return jsonResp({ error: "unauthorized" }, 401);
    const target = url.searchParams.get("url") ?? "";
    const id = /(\d{6,25})\/?$/.exec(target)?.[1];
    const v = w.vids.find((x) => x.id === id);
    if (url.pathname === "/v1/metadata") {
      w.calls.meta++; w.calls.urls.push(target);
      if (!v || v.meta === "404") return jsonResp({ error: "not-found", message: "Not found" }, 404);
      if (v.meta === "500") return jsonResp({ error: "internal-error", message: "boom" }, 500);
      return jsonResp({
        platform: v.meta === "other_platform" ? "youtube" : "tiktok", type: v.meta === "photo" ? "image" : "video", id: v.id, url: U(v.user, v.id),
        title: `Tytuł ${v.id}`, description: `Opis ${v.id} #tag, "cudzysłów"\nnowa linia`, author: { username: v.user, displayName: `Konto ${v.user}`, verified: v.user === "anna" },
        stats: { views: v.views, likes: 10, comments: 2, shares: 1 }, media: { type: "video", duration: 31 }, tags: ["tag", "inny"], createdAt: "2026-10-01T10:00:00Z",
      });
    }
    if (url.pathname === "/v1/transcript") {
      w.calls.tr++;
      if (!v || v.tr === "none" || (v.tr === "ai" && url.searchParams.get("mode") === "native")) return new Response(null, { status: 206 });
      if (v.tr === "ai") { const j = "job-" + v.id; w.jobs.set(j, 0); return jsonResp({ jobId: j }, 202); }
      if (v.tr === "empty") return jsonResp({ lang: "en", content: [] });
      if (v.tr === "plain") return jsonResp({ lang: "en", content: textOf(v) });
      return jsonResp({ lang: "en", availableLangs: ["en"], content: segs(v) });
    }
    if (url.pathname.startsWith("/v1/transcript/")) {
      w.calls.poll++;
      const j = decodeURIComponent(url.pathname.split("/").pop()!);
      const n = (w.jobs.get(j) ?? 0) + 1; w.jobs.set(j, n);
      if (n < 2) return jsonResp({ status: "active" });
      const v2 = w.vids.find((x) => "job-" + x.id === j)!;
      return jsonResp({ status: "completed", lang: "en", content: segs(v2) });
    }
    return new Response("unmocked " + url.href, { status: 599 });
  });
}

beforeEach(async () => {
  await resetStore();
  await (runInDurableObject as any)(stub(), (inst: any) => { for (const t of ["tt_batches", "tt_videos", "tt_exports"]) inst.ctx.storage.sql.exec(`DELETE FROM ${t}`); });
});
afterEach(() => vi.unstubAllGlobals());

const start = (p: Record<string, unknown>) => stub().startTikTok({ urls: undefined, batchId: null, label: null, mode: null, lang: null, retryFailed: false, stepItems: null, ...p });

describe("linki TikTok", () => {
  it("przyjmuje linki do filmów i krótkie linki, odrzuca resztę", () => {
    expect(parseTikTokUrl("https://www.tiktok.com/@jan.kowalski/video/7300000000000000001?is_from_webapp=1&sender_device=pc")).toEqual({ url: U("jan.kowalski", "7300000000000000001"), key: "7300000000000000001", id: "7300000000000000001" });
    expect(parseTikTokUrl("https://m.tiktok.com/@a_b/video/123456789/")?.id).toBe("123456789");
    expect(parseTikTokUrl("https://vm.tiktok.com/ZMabc123/")?.id).toBeNull();
    expect(parseTikTokUrl("https://www.tiktok.com/t/ZTabc123")?.url).toBe("https://www.tiktok.com/t/ZTabc123/");
    for (const bad of ["https://www.tiktok.com/@jan", "https://www.tiktok.com/@jan/photo/123456789", "https://evil.com/@a/video/123456789", "https://www.tiktok.com.evil.com/@a/video/123456789", "javascript:alert(1)", "ftp://www.tiktok.com/@a/video/123456789", "to nie link", ""]) {
      expect(parseTikTokUrl(bad), bad).toBeNull();
    }
    expect(splitUrls("a b,c;d\ne")).toEqual(["a", "b", "c", "d", "e"]);
    expect(splitUrls(["x y", "z"])).toEqual(["x", "y", "z"]);
  });
  it("normMeta: brakujące pola to null, nie zgadujemy", () => {
    const m = normMeta({ platform: "tiktok", id: 5, stats: { views: "12", likes: null }, tags: ["a", 3] });
    expect(m).toMatchObject({ id: "5", views: 12, likes: null, comments: null, shares: null, duration_s: null, title: null, tags: ["a"], type: "video" });
  });
});

describe("collect_tiktok / export_tiktok", () => {
  const vids: TV[] = [
    { id: "7000000000000000001", user: "anna", views: 900, tr: "ok" },
    { id: "7000000000000000002", user: "anna", views: 100, tr: "none" },
    { id: "7000000000000000003", user: "anna", views: 500, tr: "plain" },
    { id: "7000000000000000004", user: "bartek", views: 5000, tr: "ai" },
    { id: "7000000000000000005", user: "bartek", views: null, tr: "empty" },
    { id: "7000000000000000006", user: "bartek", views: 7, tr: "ok", meta: "photo" },
    { id: "7000000000000000007", user: "bartek", views: 7, tr: "ok", meta: "404" },
  ];
  const urls = vids.map((v) => U(v.user, v.id));

  it("próbka kosztu: pierwsze wywołanie pobiera 1 film i podaje zużycie; kolejne po 10; cały przebieg i eksport", async () => {
    const w = mkWorld(vids); install(w);
    const s = stub();
    const r1 = await start({ urls, label: "test", mode: "auto" });
    expect(r1.step.processed).toBe(1); expect(r1.total).toBe(7); expect(r1.complete).toBe(false); expect(r1.remaining).toBe(6);
    expect(r1.step.credits_used).toBe(2); // metadane 1 + transkrypt 1
    expect(r1.next_step).toMatch(/Próbka: 1 film zużył 2 kredytów/);
    expect(w.calls.meta).toBe(1); expect(w.calls.tr).toBe(1);
    let r = await start({ batchId: r1.batch_id });
    expect(r.step.processed).toBe(6);
    // film z AI czeka na zadanie (202), reszta gotowa
    expect(r.counts.transcript_status.pending_ai).toBe(1);
    r = await start({ batchId: r1.batch_id }); // odpytanie zadania (1. odpowiedź „active”)
    r = await start({ batchId: r1.batch_id }); // 2. odpowiedź: gotowe
    expect(r.counts.transcript_status.pending_ai ?? 0).toBe(0);
    expect(r.complete).toBe(true);
    expect(r.counts.stats_status).toEqual({ ok: 5, not_video: 1, unavailable: 1 });
    expect(r.counts.transcript_status).toMatchObject({ ok: 3, no_captions: 1, empty: 1, error_video: 2 });
    // eksport
    const info = await s.exportTikTok({ batchIds: [r1.batch_id], allowPartial: false, label: "test" });
    expect(info.id).toMatch(/^t-[a-f0-9]{24}$/); expect(info.records).toBe(7); expect(info.partial).toBe(false);
    const rows = JSON.parse((await s.exportChunks(info.id, "json")).join(""));
    expect(rows).toHaveLength(7);
    const byId = (id: string) => rows.find((x: any) => x.video_id === id);
    const a = byId("7000000000000000001");
    expect(a).toMatchObject({ platform: "tiktok", channel_handle: "@anna", channel_title: "Konto anna", channel_verified: true, views: 900, likes: 10, comments_count: 2, shares: 1, duration_seconds: 31, transcript_status: "ok", transcript_lang: "en", stats_status: "ok", tags: ["tag", "inny"] });
    expect(a.transcript).toBe(textOf(vids[0]));
    expect(a.transcript_timed.length).toBeGreaterThan(1); expect(a.transcript_timed[0]).toMatchObject({ start_s: 0, end_s: 1.5 });
    expect(a.transcript_timed.map((x: any) => x.text).join(" ")).toBe(a.transcript);
    expect(a.transcript_timed_status).toBe("ok");
    expect(byId("7000000000000000003").transcript_timed_status).toBe("no_segments_in_response"); // Supadata zwróciło sam tekst
    expect(byId("7000000000000000002")).toMatchObject({ transcript: null, transcript_status: "no_captions", transcript_timed_status: "no_transcript" });
    expect(byId("7000000000000000005")).toMatchObject({ views: null, transcript_status: "empty", author_views_rank_in_sample: null });
    expect(byId("7000000000000000006")).toMatchObject({ stats_status: "not_video", transcript_status: "error_video" });
    expect(byId("7000000000000000007")).toMatchObject({ stats_status: "unavailable", transcript_status: "error_video" });
    // pozycje w próbie: anna 900/500/100, bartek 5000 (reszta bez wyświetleń lub 7)
    expect(a.author_views_rank_in_sample).toBe(1); expect(byId("7000000000000000003").author_views_rank_in_sample).toBe(2); expect(byId("7000000000000000002").author_views_rank_in_sample).toBe(3);
    expect(a.author_videos_in_sample).toBe(3); expect(a.set_size).toBe(7); expect(byId("7000000000000000004").set_views_rank).toBe(1);
    // CSV i Markdown
    const csv = (await s.exportChunks(info.id, "csv")).join("");
    expect(csv.startsWith("﻿platform,title,description")).toBe(true);
    const parsed = parseCsv(csv.replace(/^﻿/, ""));
    expect(parsed.length).toBe(8); expect(parsed[0]).toEqual([...TT_COLUMNS]); // nagłówek + 7 filmów; pola z nowymi liniami i cudzysłowami zostają w jednej komórce
    expect(parsed.every((r) => r.length === TT_COLUMNS.length)).toBe(true);
    expect(parsed[1][TT_COLUMNS.indexOf("description")]).toBe('Opis 7000000000000000001 #tag, "cudzysłów"\nnowa linia');
    const md = (await s.exportChunks(info.id, "md-1")).join("");
    expect(md).toContain("7000000000000000001"); expect(md).toContain("udostępnienia: 1"); expect(md).toContain("[0:00.0]");
    const status = JSON.parse((await s.exportChunks(info.id, "status")).join(""));
    expect(status).toMatchObject({ platform: "tiktok", complete: true, records: 7 });
    expect(Object.keys(status.files)).toEqual(expect.arrayContaining(["csv", "json", "md-1"]));
    // sumy kontrolne zgadzają się z treścią
    const enc = new TextEncoder();
    for (const f of ["csv", "json", "md-1"]) {
      const all = (await s.exportChunks(info.id, f)).join("");
      const d = await crypto.subtle.digest("SHA-256", enc.encode(all));
      expect([...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("")).toBe(status.files[f].sha256);
      expect(enc.encode(all).length).toBe(status.files[f].bytes);
    }
    expect(await s.exportChunks(info.id, "md-9")).toBeNull();
    const ei = await s.exportInfo(info.id);
    expect(ei).toMatchObject({ phase: "ready", partial: false, set_id: info.id });
    // zużycie: transkrypt natywny dla 5 filmów (bez zdjęcia i bez 404) + metadane dla 7 + 1 transkrypt dla filmu AI po odpytaniu (nie liczone: polling 0)
    const u = await s.usage();
    expect(u.supadata_credits_today).toBeGreaterThan(7);
  });

  it("eksport niepełnej partii wymaga allow_partial; duplikaty i błędne linki", async () => {
    const w = mkWorld(vids); install(w);
    const s = stub();
    const r1 = await start({ urls: [...urls.slice(0, 3), urls[0], "https://example.com/x", "śmieć"], label: "t" });
    expect(r1.total).toBe(3); expect(r1.duplicates_skipped).toBe(1); expect(r1.rejected_links).toEqual(["https://example.com/x", "śmieć"]);
    await expect(rej(s.exportTikTok({ batchIds: [r1.batch_id], allowPartial: false, label: null }))).rejects.toThrow(/Nie wszystkie filmy są gotowe \(2 z 3\)/);
    const part = await s.exportTikTok({ batchIds: [r1.batch_id], allowPartial: true, label: null });
    expect(part.partial).toBe(true); expect(part.records).toBe(3);
    await expect(rej(start({ urls: ["nic", "tu"] }))).rejects.toThrow(/Brak poprawnych linków/);
    await expect(rej(start({ batchId: "tb-nie-ma" }))).rejects.toThrow(/Nie ma partii TikTok/);
    const list = await start({});
    expect(list.batches).toHaveLength(1);
  });

  it("wyczerpane kredyty Supadata zatrzymują krok bez błędu; wznowienie dokańcza", async () => {
    const w = mkWorld(vids.slice(0, 3));
    let exhausted = true;
    w.fail = () => (exhausted ? jsonResp({ error: "limit-exceeded", message: "x", details: "Plan usage limit was exceeded." }, 429, { "retry-after": "0" }) : null);
    install(w);
    const r1 = await start({ urls: urls.slice(0, 3), stepItems: 3 });
    expect(r1.step.stopped).toBe("credits");
    expect(r1.counts.stats_status.no_credits).toBe(1); expect(r1.complete).toBe(false);
    expect(r1.next_step).toMatch(/Kredyty Supadata/);
    exhausted = false;
    const r2 = await start({ batchId: r1.batch_id });
    expect(r2.complete).toBe(true); expect(r2.counts.stats_status).toEqual({ ok: 3 });
  });

  it("dzienny bezpiecznik kredytów: spokojne zatrzymanie z komunikatem", async () => {
    const w = mkWorld(vids.slice(0, 3)); install(w);
    await setEnv({ SUPADATA_DAILY_CREDIT_BUDGET: "3" });
    const r1 = await start({ urls: urls.slice(0, 3), stepItems: 3 });
    expect(r1.step.stopped).toBe("daily_limit");
    expect(r1.next_step).toMatch(/Dzienny limit bezpieczeństwa/);
    expect(r1.supadata_credits_today).toBeLessThanOrEqual(3);
  });

  it("transcript_mode=auto ponawia filmy bez napisów; błąd usługi czeka na retry_failed", async () => {
    const w = mkWorld([vids[1], vids[3]]); install(w);
    const r1 = await start({ urls: [urls[1], urls[3]], stepItems: 2 });
    expect(r1.counts.transcript_status).toMatchObject({ no_captions: 2 });
    const r2 = await start({ batchId: r1.batch_id, mode: "auto" });
    expect(r2.counts.transcript_status.pending_ai).toBe(1); // film „ai” generuje się, film bez mowy nadal bez napisów
    expect(r2.counts.transcript_status.no_captions).toBe(1);
    // błąd usługi przy metadanych: bez retry_failed nie ponawia
    const w2 = mkWorld([{ id: "7000000000000000009", user: "zed", views: 1, tr: "ok", meta: "500" }]); install(w2);
    const r3 = await start({ urls: [U("zed", "7000000000000000009")] });
    expect(r3.counts.stats_status).toEqual({ error_service: 1 });
    const before = w2.calls.meta;
    await start({ batchId: r3.batch_id });
    expect(w2.calls.meta).toBe(before);
    await start({ batchId: r3.batch_id, retryFailed: true });
    expect(w2.calls.meta).toBeGreaterThan(before);
  });

  it("zły klucz Supadata (401) przerywa z komunikatem i nie zapisuje fałszywych statusów", async () => {
    const w = mkWorld(vids.slice(0, 2));
    w.fail = () => jsonResp({ error: "unauthorized", message: "bad key" }, 401);
    install(w);
    await expect(rej(start({ urls: urls.slice(0, 2) }))).rejects.toThrow(/SUPADATA_API_KEY/);
    const list = await start({});
    expect(list.batches[0].remaining).toBe(2);
  });

  it("przez dispatch: narzędzia collect_tiktok i export_tiktok, linki podpisane, sekrety nie wyciekają", async () => {
    const w = mkWorld(vids.slice(0, 1)); install(w);
    const st = stub();
    const r: any = await dispatch(env as any, "https://yt-mcp.test", st, "collect_tiktok", { urls: [urls[0]], step_items: 1 });
    expect(r.complete).toBe(true);
    const e: any = await dispatch(env as any, "https://yt-mcp.test", st, "export_tiktok", { batch_id: r.batch_id });
    expect(e.set_id).toMatch(/^t-/); expect(e.download_links.json).toMatch(/^https:\/\/yt-mcp\.test\/exports\/t-[a-f0-9]{24}\/json\?exp=\d+&sig=[a-f0-9]{64}$/);
    expect(e.manifest_link).toContain("/manifest?");
    expect(JSON.stringify(e)).not.toContain("SDKEY-MARKER");
    // odczyt bez linków przez export_collection
    const rd: any = await dispatch(env as any, "https://yt-mcp.test", st, "export_collection", { set_id: e.set_id, read_file: "json" });
    expect(JSON.parse(rd.content)).toHaveLength(1);
  });
});
