import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";

// ------------------------------------------------------------------ świat atrap (YouTube + Supadata)
export const CHANNEL_ID = "UC" + "abcdefghijklmnopqrstuv"; // UC + 22 znaki
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
export function vid(i: number): string {
  let n = i * 7919 + 13, s = "";
  for (let k = 0; k < 11; k++) { s += ALPHA[n % 64]; n = Math.floor(n / 64) + (k + 1) * 31 + i; }
  return s;
}
export interface MockVideo {
  id: string; title: string; dur: number; pub: string; views: number | null; unavailable?: boolean; tr: "ok" | "none" | "long" | "ai" | "empty"; text: string;
  likes: number | null; comments: number | null; commentsOff?: boolean;
}
/** Komentarze atrapy: celowo NIE posortowane wg polubień (tak jak kolejność trafności YouTube). */
export const mockComments = (v: MockVideo) => [3, 50, 7, 1, 20].map((likes, k) => ({ text: `Komentarz ${k + 1} do ${v.id}, "z cudzysłowem"\ni nową linią`, likes, published_at: "2026-09-02T10:00:0" + k + "Z" }));
export function makeText(i: number, len: number): string {
  const base = `Wideo ${i}: "cytat", przecinek, średnik; ąęłńóśźż 😀\nnowa linia\ttab — myślnik. `;
  let t = "";
  while (t.length < len) t += base + (t.length % 7);
  return t.slice(0, len);
}

export const CHANNEL_ID2 = "UC" + "zyxwvutsrqponmlkjihgfe";
export interface World {
  videos: MockVideo[]; // kolejność: od najnowszego
  /** drugi kanał (@drugi) – do testów zestawów z wielu kanałów */
  other?: MockVideo[];
  calls: { yt: number; sd: number; github: number; comments: number; urls: string[] };
  ytFail?: (url: URL) => Response | null;
  sdFail?: (url: URL) => Response | null;
  sdJobs: Map<string, number>;
  kv: Record<string, string>;
  /** atrapa Gemini: dostaje (fps, body) i zwraca odpowiedź; brak = 599 */
  gemini?: (fps: number, body: any, url: URL) => Response;
  geminiCalls?: { fps: number; key: string | null; body: any; url?: string }[];
  /** opóźnienie odpowiedzi atrapy Gemini (ms) i licznik wywołań w toku – do testów równoległości */
  geminiDelayMs?: number;
  geminiInflight?: number;
  geminiMaxInflight?: number;
}

export function buildWorld(n = 230, opts: { unavailable?: number[]; none?: number[]; long?: Record<number, number>; ai?: number[]; empty?: number[] } = {}): World {
  const videos: MockVideo[] = [];
  const base = Date.parse("2026-09-01T12:00:00Z");
  for (let i = 0; i < n; i++) {
    const long = opts.long?.[i];
    const tr: MockVideo["tr"] = opts.none?.includes(i) ? "none" : opts.ai?.includes(i) ? "ai" : opts.empty?.includes(i) ? "empty" : long ? "long" : "ok";
    videos.push({
      id: vid(i),
      title: i % 11 === 0 ? `Tytuł, z "cudzysłowem" i przecinkiem #${i}` : i % 13 === 0 ? `Tytuł\nz nową linią ${i}` : `Short ${i} ąęś`,
      dur: 15 + (i % 45),
      pub: new Date(base - i * 3600_000 * 5).toISOString().replace(".000Z", "Z"),
      views: i % 29 === 0 ? null : ((i * 7919) % 100003) + 1, // niepowtarzalne
      unavailable: opts.unavailable?.includes(i),
      tr,
      text: tr === "long" ? makeText(i, long!) : tr === "ok" || tr === "ai" ? makeText(i, 300 + (i % 9) * 900) : "",
      likes: i % 5 === 0 ? null : (i * 31) % 997,
      comments: i % 17 === 0 ? null : (i * 3) % 101,
      commentsOff: i % 17 === 0,
    });
  }
  return { videos, calls: { yt: 0, sd: 0, github: 0, comments: 0, urls: [] }, sdJobs: new Map(), kv: {} };
}

const isoDur = (s: number) => `PT${Math.floor(s / 60) ? Math.floor(s / 60) + "M" : ""}${s % 60}S`;
const jsonResp = (b: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...h } });

export function installFetch(w: World) {
  const impl = async (input: any, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    w.calls.urls.push(url.hostname + url.pathname);
    if (url.hostname === "www.googleapis.com") {
      w.calls.yt++;
      const f = w.ytFail?.(url);
      if (f) return f;
      const key = (init?.headers as Record<string, string>)?.["x-goog-api-key"];
      if (key !== "YTKEY-MARKER-123") return jsonResp({ error: { message: "API key not valid", errors: [{ reason: "keyInvalid" }] } }, 400);
      const ep = url.pathname.split("/").pop();
      const all = () => [...w.videos, ...(w.other ?? [])];
      if (ep === "channels") {
        const h = url.searchParams.get("forHandle"), id = url.searchParams.get("id");
        if (w.other && (h === "@drugi" || id === CHANNEL_ID2)) {
          return jsonResp({ items: [{ id: CHANNEL_ID2, snippet: { title: "Drugi Kanał", customUrl: "@drugi" }, statistics: { videoCount: String(w.other.length) }, contentDetails: { relatedPlaylists: { uploads: "UU" + CHANNEL_ID2.slice(2) } } }] });
        }
        if (h !== "@przyklad" && id !== CHANNEL_ID) return jsonResp({ items: [] });
        return jsonResp({ items: [{ id: CHANNEL_ID, snippet: { title: "Kanał Przykład", customUrl: "@przyklad" }, statistics: { videoCount: String(w.videos.length) }, contentDetails: { relatedPlaylists: { uploads: "UU" + CHANNEL_ID.slice(2) } } }] });
      }
      if (ep === "playlistItems") {
        const pl = url.searchParams.get("playlistId")!;
        const list = pl.endsWith(CHANNEL_ID.slice(2)) ? w.videos : w.other && pl.endsWith(CHANNEL_ID2.slice(2)) ? w.other : null;
        if (!list || !(pl.startsWith("UUSH") || pl.startsWith("UU"))) return jsonResp({ error: { message: "x", errors: [{ reason: "playlistNotFound" }] } }, 404);
        const start = Number(url.searchParams.get("pageToken") ?? 0);
        const page = list.slice(start, start + 50);
        return jsonResp({ items: page.map((v) => ({ contentDetails: { videoId: v.id } })), ...(start + 50 < list.length ? { nextPageToken: String(start + 50) } : {}) });
      }
      if (ep === "videos") {
        const ids = url.searchParams.get("id")!.split(",");
        if (ids.length > 50) return jsonResp({ error: { message: "too many ids" } }, 400);
        const items = ids.map((id) => all().find((v) => v.id === id)).filter((v): v is MockVideo => !!v && !v.unavailable).map((v) => ({
          id: v.id, snippet: { title: v.title, publishedAt: v.pub, channelId: CHANNEL_ID }, contentDetails: { duration: isoDur(v.dur) },
          statistics: {
            ...(v.views == null ? {} : { viewCount: String(v.views) }),
            ...(v.likes == null ? {} : { likeCount: String(v.likes) }),
            ...(v.comments == null ? {} : { commentCount: String(v.comments) }),
          },
        }));
        return jsonResp({ items });
      }
      if (ep === "commentThreads") {
        w.calls.comments++;
        const v = all().find((x) => x.id === url.searchParams.get("videoId"));
        if (!v) return jsonResp({ error: { message: "nf", errors: [{ reason: "videoNotFound" }] } }, 404);
        if (v.commentsOff) return jsonResp({ error: { message: "disabled", errors: [{ reason: "commentsDisabled" }] } }, 403);
        if (url.searchParams.get("order") !== "relevance" || url.searchParams.get("textFormat") !== "plainText") return jsonResp({ error: { message: "bad params" } }, 400);
        const n = Number(url.searchParams.get("maxResults"));
        return jsonResp({ items: mockComments(v).slice(0, n).map((c) => ({ snippet: { topLevelComment: { snippet: { textDisplay: c.text, likeCount: c.likes, publishedAt: c.published_at } } } })) });
      }
    }
    if (url.hostname === "api.supadata.ai") {
      w.calls.sd++;
      const f = w.sdFail?.(url);
      if (f) return f;
      if ((init?.headers as Record<string, string>)?.["x-api-key"] !== "SDKEY-MARKER-456") return jsonResp({ error: "unauthorized" }, 401);
      if (url.pathname === "/v1/transcript") {
        const m = /([A-Za-z0-9_-]{11})$/.exec(url.searchParams.get("url")!);
        const v = [...w.videos, ...(w.other ?? [])].find((x) => x.id === m?.[1]);
        if (!v || v.tr === "none") return new Response(null, { status: 206 });
        if (v.tr === "ai" && url.searchParams.get("mode") === "native") return new Response(null, { status: 206 });
        if (v.tr === "ai") { const id = "job-" + v.id; w.sdJobs.set(id, 0); return jsonResp({ jobId: id }, 202); }
        return jsonResp({ lang: "pl", availableLangs: ["pl"], content: v.tr === "empty" ? [] : chunkSegments(v.text) });
      }
      if (url.pathname.startsWith("/v1/transcript/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop()!);
        const n = (w.sdJobs.get(id) ?? 0) + 1;
        w.sdJobs.set(id, n);
        if (n < 2) return jsonResp({ status: "active" });
        const v = w.videos.find((x) => "job-" + x.id === id)!;
        return jsonResp({ status: "completed", lang: "pl", content: chunkSegments(v.text) });
      }
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const fps = body?.contents?.[0]?.parts?.[0]?.videoMetadata?.fps;
      (w.geminiCalls ??= []).push({ fps, key: (init?.headers as Record<string, string>)?.["x-goog-api-key"] ?? null, body, url: body?.contents?.[0]?.parts?.[0]?.fileData?.fileUri });
      w.geminiInflight = (w.geminiInflight ?? 0) + 1;
      w.geminiMaxInflight = Math.max(w.geminiMaxInflight ?? 0, w.geminiInflight);
      try {
        if (w.geminiDelayMs) await new Promise((r) => setTimeout(r, w.geminiDelayMs));
        if (w.gemini) return w.gemini(fps, body, url);
      } finally {
        w.geminiInflight!--;
      }
    }
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") { w.calls.github++; return jsonResp({ access_token: "gho_mock" }); }
    if (url.hostname === "api.github.com" && url.pathname === "/user") { w.calls.github++; return jsonResp({ login: w.kv.ghLogin ?? "Moj-Login", id: Number(w.kv.ghId ?? 4242) }); }
    return new Response("unmocked " + url.href, { status: 599 });
  };
  vi.stubGlobal("fetch", impl);
}

/** Dzieli tekst na segmenty tak, by rawToText złożyło go DOKŁADNIE z powrotem (segmenty rozdzielane pojedynczą spacją). */
export function chunkSegments(text: string): { text: string; offset: number; duration: number; lang: string }[] {
  const words = text.split(" ");
  const out = [];
  for (let i = 0; i < words.length; i += 7) out.push({ text: words.slice(i, i + 7).join(" "), offset: i * 300, duration: 2000, lang: "pl" });
  return out;
}
/** Tekst, jaki powinien powstać po złożeniu segmentów (segmenty są przycinane przez trim()). */
export const expectedText = (text: string) =>
  chunkSegments(text).map((s) => s.text.trim()).filter(Boolean).join(" ");

// ------------------------------------------------------------------------------------ sterowanie DO
export const stub = (): any => (env as any).STORE.get((env as any).STORE.idFromName("main"));

export async function setEnv(vars: Record<string, string | undefined>) {
  await (runInDurableObject as any)(stub(), (inst: any) => { for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete inst.env[k]; else inst.env[k] = v; } });
}

/** Uruchamia alarmy, aż zadanie przestanie działać (albo skończy się limit iteracji). */
export async function drive(jobId: string, max = 400): Promise<any> {
  const s = stub();
  for (let i = 0; i < max; i++) {
    const st = await s.status(jobId);
    if (!st.running) return st;
    const ran = await runDurableObjectAlarm(s);
    if (!ran) { await new Promise((r) => setTimeout(r, 5)); }
  }
  return await s.status(jobId);
}

export async function runExport(jobId: string, allowPartial = false) {
  const s = stub();
  await s.startExport(jobId, allowPartial);
  for (let i = 0; i < 200; i++) {
    const info = await s.exportInfo(jobId);
    if (info && !["selecting", "ordering", "building"].includes(info.phase)) return info;
    await runDurableObjectAlarm(s);
  }
  throw new Error("eksport nie skończył się");
}

/** Czyści całą bazę DO, alarm i nadpisane zmienne środowiskowe — każdy test zaczyna od zera. */
export async function resetStore() {
  await (runInDurableObject as any)(stub(), async (inst: any) => {
    const sql = inst.ctx.storage.sql;
    for (const t of ["budget", "cache", "jobs", "cands", "items", "exp_chunks", "snaps", "sets", "set_cands", "set_items", "vis", "vis_state"]) sql.exec(`DELETE FROM ${t}`);
    await inst.ctx.storage.deleteAlarm();
    for (const k of ["YT_DAILY_UNIT_BUDGET", "SUPADATA_DAILY_CREDIT_BUDGET", "COLLECT_MAX_COUNT", "COLLECT_MAX_HISTORY", "STEP_ITEMS", "ALARM_DELAY_MS", "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_DAILY_CALLS"]) delete inst.env[k];
    inst.lastYt.at = 0; inst.lastSd.at = 0;
  });
}
/** Obiecuje odrzucenie również dla obiektów RPC (które nie mają .catch). */
export const rej = (p: PromiseLike<unknown>) => (async () => p)();
