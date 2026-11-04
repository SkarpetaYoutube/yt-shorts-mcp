// TikTok: transkrypty i statystyki pojedynczych filmów przez Supadata (lista filmów kanału nie jest dostępna: linki podaje użytkownik).
// Własne tabele (tt_*), bez YouTube API i bez Gemini. Eksport CSV/JSON/Markdown trafia do tego samego mechanizmu linków co zestawy YouTube (id "t-...").
import { SubrequestBudget, SupadataError, budgetUsed, rawToSegments, rawToText, sdFetchRaw, sdMetadata, sdPollJob, type Services } from "./clients";
import { TIMED_STATUS_PL, TRANSCRIPT_STATUS_PL, csvSafe, timedToText, type TimedSegment } from "./csv";
import { PauseError, UserError } from "./types";
import { sha256Hex, sleep } from "./util";

const num = (v: string | undefined, d: number): number => { const x = Number(v); return v != null && v !== "" && Number.isFinite(x) ? x : d; };

export const TT_MAX_URLS = 100;
export const TT_STEP_DEFAULT = 10;
export const TT_MD_PART_CHARS = 180_000;

// ------------------------------------------------------------------------------------------------ linki
export interface TtUrl { url: string; key: string; id: string | null }

/** Przyjmuje tylko publiczne linki do filmów TikTok (także krótkie vm./vt.//t/). Zwraca null dla reszty (nic nie jest zgadywane). */
export function parseTikTokUrl(raw: string): TtUrl | null {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
    if (!/^\/[A-Za-z0-9]{4,32}\/?$/.test(u.pathname)) return null;
    const url = `https://${host}${u.pathname.replace(/\/?$/, "/")}`;
    return { url, key: url, id: null };
  }
  if (host === "tiktok.com" || host === "www.tiktok.com" || host === "m.tiktok.com") {
    const m = /^\/@([A-Za-z0-9._-]{1,64})\/video\/(\d{6,25})\/?$/.exec(u.pathname);
    if (m) return { url: `https://www.tiktok.com/@${m[1]}/video/${m[2]}`, key: m[2], id: m[2] };
    const t = /^\/t\/([A-Za-z0-9]{4,32})\/?$/.exec(u.pathname);
    if (t) { const url = `https://www.tiktok.com/t/${t[1]}/`; return { url, key: url, id: null }; }
  }
  return null;
}

/** Lista linków z tablicy albo tekstu (rozdzielanego białymi znakami, przecinkami i nowymi liniami). */
export function splitUrls(input: unknown): string[] {
  const parts = Array.isArray(input) ? input.map((x) => String(x)) : typeof input === "string" ? [input] : [];
  return parts.flatMap((p) => p.split(/[\s,;]+/)).map((x) => x.trim()).filter(Boolean);
}

// ------------------------------------------------------------------------------------------------ model
export type MetaStatus = "pending" | "ok" | "not_video" | "unavailable" | "error_service" | "no_credits";
export type TStatus = "pending" | "ok" | "empty" | "no_captions" | "error_video" | "error_service" | "no_credits" | "pending_ai";

export interface TtMeta {
  id: string | null; url: string | null; title: string | null; description: string | null;
  author_username: string | null; author_name: string | null; author_verified: boolean | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null;
  duration_s: number | null; tags: string[]; created_at: string | null; type: string;
}
export interface TtRec {
  url: string; key: string; id: string | null;
  meta_status: MetaStatus; meta: TtMeta | null; meta_err: string | null; measured_at: string | null;
  tstat: TStatus; tmode: "native" | "auto"; text: string | null; segs: [number, number, string][]; lang: string | null; job: string | null; terr: string | null;
}
export interface TtBatch { id: string; label: string | null; mode: "native" | "auto"; lang: string | null; created: number; rejected: string[] }

export function migrateTt(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS tt_batches (id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS tt_videos (batch TEXT NOT NULL, ord INTEGER NOT NULL, key TEXT NOT NULL, rec TEXT NOT NULL, PRIMARY KEY(batch, ord))`);
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tt_videos_key ON tt_videos(batch, key)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS tt_exports (id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL)`);
}

export function pruneTt(sql: SqlStorage, cutoff: number): void {
  for (const r of sql.exec("SELECT id FROM tt_batches WHERE updated < ?", cutoff).toArray()) {
    sql.exec("DELETE FROM tt_videos WHERE batch=?", String(r.id));
    sql.exec("DELETE FROM tt_batches WHERE id=?", String(r.id));
  }
  for (const r of sql.exec("SELECT id FROM tt_exports WHERE created < ?", cutoff).toArray()) {
    sql.exec("DELETE FROM exp_chunks WHERE job=?", String(r.id));
    sql.exec("DELETE FROM tt_exports WHERE id=?", String(r.id));
  }
}

const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 24);
const loadBatch = (sql: SqlStorage, id: string): TtBatch => {
  const row = sql.exec("SELECT state FROM tt_batches WHERE id=?", id).toArray()[0];
  if (!row) throw new UserError(`Nie ma partii TikTok ${id} (albo wygasła). Wywołaj collect_tiktok bez parametrów, by zobaczyć listę.`);
  return JSON.parse(String(row.state)) as TtBatch;
};
const saveBatch = (sql: SqlStorage, b: TtBatch): void => {
  sql.exec("INSERT INTO tt_batches(id, state, created, updated) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated=excluded.updated", b.id, JSON.stringify(b), b.created, Date.now());
};
const loadRecs = (sql: SqlStorage, batch: string): { ord: number; rec: TtRec }[] =>
  sql.exec("SELECT ord, rec FROM tt_videos WHERE batch=? ORDER BY ord", batch).toArray().map((r) => ({ ord: Number(r.ord), rec: JSON.parse(String(r.rec)) as TtRec }));
const saveRec = (sql: SqlStorage, batch: string, ord: number, rec: TtRec): void => {
  sql.exec("UPDATE tt_videos SET rec=? WHERE batch=? AND ord=?", JSON.stringify(rec), batch, ord);
};

// ------------------------------------------------------------------------------------------------ metadane
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

/** Ujednolicona odpowiedź Supadata /metadata → pola eksportu. Brak pola = null (nie zgadujemy). */
export function normMeta(j: any): TtMeta {
  return {
    id: j?.id != null ? String(j.id) : null,
    url: strOrNull(j?.url),
    title: strOrNull(j?.title),
    description: strOrNull(j?.description),
    author_username: strOrNull(j?.author?.username),
    author_name: strOrNull(j?.author?.displayName),
    author_verified: typeof j?.author?.verified === "boolean" ? j.author.verified : null,
    views: numOrNull(j?.stats?.views),
    likes: numOrNull(j?.stats?.likes),
    comments: numOrNull(j?.stats?.comments),
    shares: numOrNull(j?.stats?.shares),
    duration_s: numOrNull(j?.media?.duration),
    tags: Array.isArray(j?.tags) ? j.tags.filter((x: unknown) => typeof x === "string") : [],
    created_at: strOrNull(j?.createdAt),
    type: strOrNull(j?.type) ?? "video",
  };
}

// ------------------------------------------------------------------------------------------------ partie
export interface StartOpts { label: string | null; mode: "native" | "auto"; lang: string | null; batchId: string | null }

/** Tworzy partię albo dopisuje linki do istniejącej. Zwraca id i listę odrzuconych linków. */
export function ttAddUrls(sql: SqlStorage, urlsIn: unknown, o: StartOpts): { batch: TtBatch; added: number; duplicates: number; rejected: string[] } {
  const raw = splitUrls(urlsIn);
  const ok: TtUrl[] = [], rejected: string[] = [];
  for (const r of raw) { const p = parseTikTokUrl(r); if (p) ok.push(p); else rejected.push(r.slice(0, 120)); }
  if (!ok.length) throw new UserError(`Brak poprawnych linków do filmów TikTok (np. https://www.tiktok.com/@konto/video/1234567890).${rejected.length ? ` Odrzucono: ${rejected.slice(0, 5).join(", ")}.` : ""}`);
  let batch: TtBatch;
  if (o.batchId) batch = loadBatch(sql, o.batchId);
  else batch = { id: "tb-" + rid(), label: o.label, mode: o.mode, lang: o.lang, created: Date.now(), rejected: [] };
  const have = new Set(sql.exec("SELECT key FROM tt_videos WHERE batch=?", batch.id).toArray().map((r) => String(r.key)));
  let ord = Number(sql.exec("SELECT COALESCE(MAX(ord), -1) AS m FROM tt_videos WHERE batch=?", batch.id).one().m) + 1;
  const room = TT_MAX_URLS - have.size;
  let added = 0, duplicates = 0;
  for (const u of ok) {
    if (have.has(u.key)) { duplicates++; continue; }
    if (added >= room) throw new UserError(`Za dużo filmów w jednej partii (maks. ${TT_MAX_URLS}). Podziel listę na kilka partii.`);
    have.add(u.key);
    const rec: TtRec = { url: u.url, key: u.key, id: u.id, meta_status: "pending", meta: null, meta_err: null, measured_at: null, tstat: "pending", tmode: batch.mode, text: null, segs: [], lang: null, job: null, terr: null };
    sql.exec("INSERT INTO tt_videos(batch, ord, key, rec) VALUES(?,?,?,?)", batch.id, ord++, u.key, JSON.stringify(rec));
    added++;
  }
  if (rejected.length) batch.rejected = [...batch.rejected, ...rejected].slice(0, 50);
  saveBatch(sql, batch);
  return { batch, added, duplicates, rejected };
}

const TERMINAL_T = new Set<TStatus>(["ok", "empty", "no_captions", "error_video"]);
const needsMeta = (r: TtRec, retryFailed: boolean) => r.meta_status === "pending" || r.meta_status === "no_credits" || (retryFailed && (r.meta_status === "error_service" || r.meta_status === "unavailable"));
const needsTranscript = (r: TtRec, retryFailed: boolean, auto: boolean) =>
  r.meta_status !== "not_video" && r.meta_status !== "unavailable" &&
  (r.tstat === "pending" || r.tstat === "no_credits" || r.tstat === "pending_ai" || (retryFailed && (r.tstat === "error_service" || r.tstat === "error_video")) || (auto && r.tmode !== "auto" && r.tstat === "no_captions"));
export const isComplete = (r: TtRec): boolean =>
  (r.meta_status === "ok" || r.meta_status === "not_video" || r.meta_status === "unavailable" || r.meta_status === "error_service") &&
  (TERMINAL_T.has(r.tstat) || r.tstat === "error_service" || r.meta_status === "unavailable" || r.meta_status === "not_video");

export function ttCounts(recs: TtRec[]): Record<string, any> {
  const by = (f: (r: TtRec) => string) => recs.reduce<Record<string, number>>((a, r) => { const k = f(r); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  return { stats_status: by((r) => r.meta_status), transcript_status: by((r) => r.tstat) };
}

export interface StepResult { processed: number; stopped: string | null; stopped_msg: string | null; credits_used: number }

/**
 * Jeden krok: do `limit` filmów, które czegoś potrzebują (statystyki, transkrypt, odpytanie zadania AI).
 * Wyczerpane kredyty albo limit podżądań kończą krok bez błędu (postęp jest zapisany); zły klucz to błąd.
 */
export async function ttStep(s: Services, batchId: string, o: { retryFailed: boolean; mode: "native" | "auto" | null; limit: number }): Promise<StepResult> {
  const sql = s.sql;
  const batch = loadBatch(sql, batchId);
  const mode = o.mode ?? batch.mode;
  if (o.mode && o.mode !== batch.mode) { batch.mode = o.mode; saveBatch(sql, batch); }
  const itemDelay = num(s.env.SD_ITEM_DELAY_MS, 800);
  const before = budgetUsed(s, "sd_credits", "UTC");
  let processed = 0, stopped: string | null = null, stoppedMsg: string | null = null;
  const todo = loadRecs(sql, batchId).filter(({ rec }) => needsMeta(rec, o.retryFailed) || needsTranscript(rec, o.retryFailed, mode === "auto")).slice(0, o.limit);
  for (const { ord, rec } of todo) {
    if (s.sub.count >= s.sub.max - 3) { stopped = "subrequest_limit"; break; }
    try {
      if (needsMeta(rec, o.retryFailed)) {
        try {
          const j = await sdMetadata(s, rec.url);
          if (j?.platform && String(j.platform).toLowerCase() !== "tiktok") { rec.meta_status = "unavailable"; rec.meta_err = "Link nie prowadzi do filmu TikTok."; }
          else {
            const m = normMeta(j);
            rec.meta = m; rec.meta_err = null; rec.measured_at = new Date(s.now()).toISOString();
            if (m.id) rec.id = m.id;
            rec.meta_status = m.type === "video" ? "ok" : "not_video";
            if (rec.meta_status === "not_video") { rec.tstat = "error_video"; rec.terr = `To nie film (typ: ${m.type}): transkrypcji nie pobieramy.`; }
          }
        } catch (e) {
          if (!(e instanceof SupadataError)) throw e;
          if (e.creditsExhausted) { rec.meta_status = "no_credits"; rec.meta_err = e.message; rec.tstat = rec.tstat === "pending" ? "no_credits" : rec.tstat; saveRec(sql, batchId, ord, rec); stopped = "credits"; break; }
          if (e.fatal) throw e;
          rec.meta_status = [400, 403, 404].includes(e.status) ? "unavailable" : "error_service";
          rec.meta_err = e.message;
          if (rec.meta_status === "unavailable") { rec.tstat = "error_video"; rec.terr = "Film niedostępny (statystyki nie zostały zwrócone): transkrypcji nie pobieramy."; }
        }
        saveRec(sql, batchId, ord, rec);
        if (itemDelay > 0) await sleep(itemDelay);
      }
      if (needsTranscript(rec, o.retryFailed, mode === "auto")) {
        if (s.sub.count >= s.sub.max - 2) { stopped = "subrequest_limit"; break; }
        try {
          if (rec.tstat === "pending_ai" && rec.job) {
            const raw = await sdPollJob(s, rec.job);
            if (raw != null) finishTranscript(rec, raw);
          } else {
            rec.tmode = mode;
            const res = await sdFetchRaw(s, rec.url, batch.lang, mode);
            if (res.state === "ok") finishTranscript(rec, res.raw);
            else if (res.state === "unavailable") { rec.tstat = "no_captions"; rec.terr = "Brak dostępnych napisów (HTTP 206)." + (mode === "native" ? " Spróbuj transcript_mode=auto (generowanie AI, droższe)." : ""); }
            else { rec.tstat = "pending_ai"; rec.job = res.jobId; }
            if (!("cached" in res && res.cached) && itemDelay > 0) await sleep(itemDelay);
          }
        } catch (e) {
          if (!(e instanceof SupadataError)) throw e;
          if (e.creditsExhausted) { rec.tstat = "no_credits"; rec.terr = e.message; saveRec(sql, batchId, ord, rec); stopped = "credits"; break; }
          if (e.fatal) throw e;
          rec.tstat = [400, 403, 404, 413].includes(e.status) ? "error_video" : "error_service";
          rec.terr = e.message; rec.job = null;
        }
        saveRec(sql, batchId, ord, rec);
      }
      processed++;
    } catch (e) {
      if (e instanceof SubrequestBudget) { stopped = "subrequest_limit"; break; }
      // dzienny bezpiecznik kredytów (nasz licznik): postęp jest zapisany, wznowienie po północy UTC albo po zmianie limitu
      if (e instanceof PauseError) { stopped = "daily_limit"; stoppedMsg = e.message; break; }
      throw e;
    }
  }
  return { processed, stopped, stopped_msg: stoppedMsg, credits_used: Math.round((budgetUsed(s, "sd_credits", "UTC") - before) * 100) / 100 };
}

function finishTranscript(rec: TtRec, raw: any): void {
  const text = rawToText(raw);
  rec.job = null; rec.lang = typeof raw?.lang === "string" ? raw.lang : null;
  if (!text.length) { rec.tstat = "empty"; rec.text = null; rec.segs = []; rec.terr = "Transkrypt pusty (nie wykryto mowy)."; return; }
  rec.tstat = "ok"; rec.text = text; rec.terr = null;
  const segs = rawToSegments(raw);
  rec.segs = segs.map((x) => x.slice() as [number, number, string]);
  // czasy zapisujemy tylko wtedy, gdy segmenty składają się dokładnie w ten sam tekst (jak w eksporcie YouTube)
  if (segs.map((x) => x[2]).join(" ") !== text) rec.segs = [];
}

export function ttStatus(sql: SqlStorage, batchId: string): any {
  const batch = loadBatch(sql, batchId);
  const recs = loadRecs(sql, batchId).map((x) => x.rec);
  const complete = recs.length > 0 && recs.every(isComplete);
  const left = recs.filter((r) => !isComplete(r)).length;
  return { batch_id: batch.id, label: batch.label, transcript_mode: batch.mode, total: recs.length, complete, remaining: left, counts: ttCounts(recs), rejected_links: batch.rejected, created_at: new Date(batch.created).toISOString() };
}

export function ttList(sql: SqlStorage, limit: number): any {
  return sql.exec("SELECT id, created FROM tt_batches ORDER BY updated DESC LIMIT ?", limit).toArray().map((r) => {
    const st = ttStatus(sql, String(r.id));
    return { batch_id: st.batch_id, label: st.label, total: st.total, complete: st.complete, remaining: st.remaining, created_at: st.created_at };
  });
}

// ------------------------------------------------------------------------------------------------ eksport
export const TT_COLUMNS = [
  "platform", "title", "description", "duration_seconds", "transcript", "published_at", "url", "views", "likes", "comments_count", "shares",
  "video_id", "channel_handle", "channel_title", "channel_verified", "tags", "measured_at",
  "author_videos_in_sample", "author_views_rank_in_sample", "views_vs_author_median_in_sample", "set_views_rank", "set_size",
  "transcript_status", "transcript_lang", "transcript_timed", "transcript_timed_status", "stats_status", "stats_note", "transcript_note",
] as const;

export interface TtExportRecord {
  platform: "tiktok"; title: string | null; description: string | null; duration_seconds: number | null; transcript: string | null; published_at: string | null; url: string;
  views: number | null; likes: number | null; comments_count: number | null; shares: number | null;
  video_id: string | null; channel_handle: string | null; channel_title: string | null; channel_verified: boolean | null; tags: string[]; measured_at: string | null;
  author_videos_in_sample: number | null; author_views_rank_in_sample: number | null; views_vs_author_median_in_sample: number | null; set_views_rank: number | null; set_size: number;
  transcript_status: string; transcript_lang: string | null; transcript_timed: TimedSegment[] | null; transcript_timed_status: string; stats_status: string; stats_note: string | null; transcript_note: string | null;
}

const median = (xs: number[]): number | null => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

/** Rekordy eksportu z partii. Pozycje i mediany liczone TYLKO w próbie (filmy podane w tym eksporcie), nie na całym koncie TikTok. */
export function buildTtRecords(recs: TtRec[]): TtExportRecord[] {
  const authorKey = (r: TtRec) => r.meta?.author_username ?? r.meta?.author_name ?? null;
  const groups = new Map<string, number[]>();
  for (const r of recs) { const k = authorKey(r); if (k && r.meta?.views != null) groups.set(k, [...(groups.get(k) ?? []), r.meta.views]); }
  const allViews = recs.map((r) => r.meta?.views).filter((v): v is number => v != null);
  const count = new Map<string, number>();
  for (const r of recs) { const k = authorKey(r); if (k) count.set(k, (count.get(k) ?? 0) + 1); }
  return recs.map((r) => {
    const m = r.meta, k = authorKey(r), v = m?.views ?? null, grp = k ? groups.get(k) : undefined;
    const timed: TimedSegment[] | null = r.segs.length ? r.segs.map(([st, du, tx]) => ({ start_s: st >= 0 ? st / 1000 : null, end_s: st >= 0 && du >= 0 ? (st + du) / 1000 : null, text: tx })) : null;
    const med = grp ? median(grp) : null;
    return {
      platform: "tiktok", title: m?.title ?? null, description: m?.description ?? null, duration_seconds: m?.duration_s ?? null, transcript: r.text, published_at: m?.created_at ?? null,
      url: m?.url ?? r.url, views: v, likes: m?.likes ?? null, comments_count: m?.comments ?? null, shares: m?.shares ?? null,
      video_id: m?.id ?? r.id, channel_handle: m?.author_username ? `@${m.author_username}` : null, channel_title: m?.author_name ?? null, channel_verified: m?.author_verified ?? null,
      tags: m?.tags ?? [], measured_at: r.measured_at,
      author_videos_in_sample: k ? count.get(k) ?? null : null,
      author_views_rank_in_sample: v != null && grp ? 1 + grp.filter((x) => x > v).length : null,
      views_vs_author_median_in_sample: v != null && med ? Math.round((v / med) * 100) / 100 : null,
      set_views_rank: v != null ? 1 + allViews.filter((x) => x > v).length : null, set_size: recs.length,
      transcript_status: r.tstat, transcript_lang: r.lang, transcript_timed: timed,
      transcript_timed_status: !r.text ? "no_transcript" : timed ? "ok" : "no_segments_in_response",
      stats_status: r.meta_status, stats_note: r.meta_err, transcript_note: r.terr,
    };
  });
}

const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const n = (v: number | null) => (v == null ? "" : String(v));
const b = (v: boolean | null) => (v == null ? "" : v ? "TAK" : "NIE");
const cells = (r: TtExportRecord): string[] => [
  r.platform, csvSafe(r.title ?? ""), csvSafe(r.description ?? ""), n(r.duration_seconds), csvSafe(r.transcript ?? ""), r.published_at ?? "", r.url, n(r.views), n(r.likes), n(r.comments_count), n(r.shares),
  r.video_id ?? "", r.channel_handle ?? "", csvSafe(r.channel_title ?? ""), b(r.channel_verified), csvSafe(r.tags.join(" ")), r.measured_at ?? "",
  n(r.author_videos_in_sample), n(r.author_views_rank_in_sample), n(r.views_vs_author_median_in_sample), n(r.set_views_rank), String(r.set_size),
  r.transcript_status, r.transcript_lang ?? "", timedToText(r.transcript_timed), r.transcript_timed_status, r.stats_status, csvSafe(r.stats_note ?? ""), csvSafe(r.transcript_note ?? ""),
];
const jsonObj = (r: TtExportRecord) => { const o: Record<string, unknown> = {}; for (const k of TT_COLUMNS) o[k] = r[k]; return o; };
const fmt = (v: number | null) => (v == null ? "brak danych" : v.toLocaleString("pl-PL").replace(/ /g, " "));

export function ttMdRecord(r: TtExportRecord, pos: number): string {
  const L: string[] = [];
  const head = (r.title ?? r.description ?? "(bez opisu)").replace(/\s*\n\s*/g, " ").slice(0, 160);
  L.push(`## ${pos}. ${head}`, "");
  L.push(`- ID: \`${r.video_id ?? "?"}\` | link: ${r.url}`);
  L.push(`- Konto: ${r.channel_title ?? "brak danych"}${r.channel_handle ? ` (${r.channel_handle})` : ""}${r.channel_verified ? ", zweryfikowane" : ""}`);
  L.push(`- Publikacja: ${r.published_at ?? "brak danych"} | długość: ${r.duration_seconds ?? "brak danych"} s | pomiar statystyk: ${r.measured_at ?? "brak danych"}${r.stats_status !== "ok" ? ` (status: ${r.stats_status}${r.stats_note ? `, ${r.stats_note}` : ""})` : ""}`);
  L.push(`- Wyświetlenia: ${fmt(r.views)} | polubienia: ${fmt(r.likes)} | komentarze: ${fmt(r.comments_count)} | udostępnienia: ${fmt(r.shares)}`);
  L.push(`- Pozycja w próbie (tylko filmy z tego pliku): konto ${r.author_views_rank_in_sample ?? "brak danych"}${r.author_videos_in_sample != null ? ` z ${r.author_videos_in_sample}` : ""}, krotność mediany konta w próbie ${r.views_vs_author_median_in_sample ?? "brak danych"}; cały plik ${r.set_views_rank ?? "brak danych"} z ${r.set_size}`);
  if (r.tags.length) L.push(`- Tagi: ${r.tags.join(" ")}`);
  if (r.description) L.push("", "### Opis filmu", "", r.description);
  L.push(`- Transkrypt: ${TRANSCRIPT_STATUS_PL[r.transcript_status] ?? r.transcript_status}${r.transcript_lang ? ` (język ${r.transcript_lang})` : ""}`);
  L.push("", "### Transkrypt ze znacznikami czasu", "");
  if (r.transcript_timed?.length) L.push(timedToText(r.transcript_timed));
  else if (r.transcript) L.push("(brak znaczników czasu; pełny tekst:)", "", r.transcript);
  else L.push(`(brak transkryptu: ${TRANSCRIPT_STATUS_PL[r.transcript_status] ?? r.transcript_status}${r.transcript_note ? `; ${r.transcript_note}` : ""})`);
  L.push("", `Czasy transkryptu: ${TIMED_STATUS_PL[r.transcript_timed_status] ?? r.transcript_timed_status}`, "", "---", "");
  return L.join("\n");
}

export const TT_DEFINITIONS = {
  views: "Wyświetlenia w chwili pomiaru (measured_at), wg Supadata. Null = brak danych.",
  "author_*_in_sample": "Pozycja i mediana liczone WYŁĄCZNIE wśród filmów tego konta, które trafiły do tego eksportu (próba podana przez użytkownika), nie na całym koncie TikTok.",
  transcript_status: "ok | empty | no_captions | error_video | error_service | no_credits | pending | pending_ai",
  stats_status: "ok | unavailable (film niedostępny) | not_video (zdjęcia/karuzela) | error_service | no_credits | pending",
  vision: "Brak: dla TikToka nie robimy analizy zdjęć (Gemini).",
};

export interface TtExportInfo { id: string; label: string | null; batches: string[]; records: number; partial: boolean; files: Record<string, { records: number; bytes: number; sha256: string }>; md_parts: { part: number; records: number; chars: number }[]; created: number; notes: string[] }

/** Buduje eksport z jednej lub wielu partii (bez duplikatów po kluczu filmu). Zapisuje fragmenty w exp_chunks pod id „t-...”. */
export async function ttBuildExport(sql: SqlStorage, batchIds: string[], o: { allowPartial: boolean; label: string | null }): Promise<TtExportInfo> {
  const ids = [...new Set(batchIds)];
  if (!ids.length) throw new UserError("Podaj batch_id (z collect_tiktok).");
  if (ids.length > 20) throw new UserError("Maksymalnie 20 partii w jednym eksporcie.");
  const seen = new Set<string>();
  const recs: TtRec[] = [];
  let dups = 0;
  for (const id of ids) { loadBatch(sql, id); for (const { rec } of loadRecs(sql, id)) { if (seen.has(rec.key)) { dups++; continue; } seen.add(rec.key); recs.push(rec); } }
  if (!recs.length) throw new UserError("Partie nie zawierają żadnych filmów.");
  const pending = recs.filter((r) => !isComplete(r)).length;
  if (pending && !o.allowPartial) throw new UserError(`Nie wszystkie filmy są gotowe (${pending} z ${recs.length}). Dokończ collect_tiktok (z batch_id) albo użyj allow_partial=true.`);
  const rows = buildTtRecords(recs);
  const id = "t-" + rid();
  const enc = new TextEncoder();
  const files: TtExportInfo["files"] = {};
  const put = async (name: string, chunks: string[], records: number) => {
    sql.exec("DELETE FROM exp_chunks WHERE job=? AND fmt=?", id, name);
    chunks.forEach((c, i) => sql.exec("INSERT INTO exp_chunks(job, fmt, seq, data) VALUES(?,?,?,?)", id, name, i, c));
    const all = chunks.join("");
    files[name] = { records, bytes: enc.encode(all).length, sha256: await sha256Hex(all) };
  };
  // CSV: BOM + nagłówek, potem partie po 10 rekordów (wiersz bazy ma limit rozmiaru)
  const csvChunks: string[] = [];
  for (let i = 0; i < rows.length; i += 10) {
    let s = i === 0 ? "﻿" + TT_COLUMNS.join(",") + "\r\n" : "";
    for (const r of rows.slice(i, i + 10)) s += cells(r).map(q).join(",") + "\r\n";
    csvChunks.push(s);
  }
  await put("csv", csvChunks, rows.length);
  const jsonChunks: string[] = [];
  for (let i = 0; i < rows.length; i += 10) jsonChunks.push((i === 0 ? "[\n" : ",\n") + rows.slice(i, i + 10).map((r) => JSON.stringify(jsonObj(r), null, 1)).join(",\n") + (i + 10 >= rows.length ? "\n]\n" : ""));
  await put("json", jsonChunks, rows.length);
  const parts: { text: string; records: number }[] = [];
  let cur: string[] = [], curLen = 0;
  const flush = () => { if (cur.length) { parts.push({ text: cur.join(""), records: cur.length }); cur = []; curLen = 0; } };
  rows.forEach((r, i) => { const s = ttMdRecord(r, i + 1); if (curLen + s.length > TT_MD_PART_CHARS && cur.length) flush(); cur.push(s); curLen += s.length; });
  flush();
  for (let i = 0; i < parts.length; i++) await put(`md-${i + 1}`, [parts[i].text], parts[i].records);
  const info: TtExportInfo = {
    id, label: o.label, batches: ids, records: rows.length, partial: pending > 0, files, created: Date.now(),
    md_parts: parts.map((p, i) => ({ part: i + 1, records: p.records, chars: p.text.length })),
    notes: [...(dups ? [`Pominięto ${dups} powtórzonych filmów.`] : []), ...(pending ? [`Eksport częściowy: ${pending} filmów niegotowych.`] : [])],
  };
  const status = JSON.stringify({
    export_id: id, label: o.label, platform: "tiktok", generated_at: new Date().toISOString(), complete: pending === 0, partial_export: pending > 0, batches: ids, records: rows.length,
    counts: ttCounts(recs), files, md_parts: info.md_parts, notes: info.notes, definitions: TT_DEFINITIONS,
    note: "Dane z Supadata (metadane i transkrypty); lista filmów pochodzi od użytkownika. Bez analizy zdjęć.",
  }, null, 1);
  sql.exec("DELETE FROM exp_chunks WHERE job=? AND fmt='status'", id);
  sql.exec("INSERT INTO exp_chunks(job, fmt, seq, data) VALUES(?,?,?,?)", id, "status", 0, status);
  sql.exec("INSERT INTO tt_exports(id, state, created) VALUES(?,?,?)", id, JSON.stringify(info), info.created);
  return info;
}

export function ttExportInfo(sql: SqlStorage, id: string): TtExportInfo | null {
  const row = sql.exec("SELECT state FROM tt_exports WHERE id=?", id).toArray()[0];
  return row ? (JSON.parse(String(row.state)) as TtExportInfo) : null;
}
export function ttExportChunks(sql: SqlStorage, id: string, f: string): string[] | null {
  const info = ttExportInfo(sql, id);
  if (!info || (f !== "status" && !info.files[f])) return null;
  return sql.exec("SELECT data FROM exp_chunks WHERE job=? AND fmt=? ORDER BY seq", id, f).toArray().map((r) => String(r.data));
}

