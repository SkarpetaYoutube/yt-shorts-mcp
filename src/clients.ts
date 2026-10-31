// Klienci YouTube Data API v3 i Supadata + licznik subżądań, limity dzienne i cache (w SQLite Durable Object).
import { PauseError, UserError, type Env } from "./types";
import { sleep } from "./util";

export const SHORTS_MAX_SECONDS = 180;
const YT_API = "https://www.googleapis.com/youtube/v3";
const SD_API = "https://api.supadata.ai/v1";
export const FREE_SUBREQUEST_LIMIT = 50;

export interface Services {
  sql: SqlStorage;
  env: Env;
  fetch: typeof fetch;
  /** Ile subżądań wykonano w bieżącym wywołaniu (limit Workers Free: 50). */
  sub: { count: number; max: number };
  lastYt: { at: number };
  lastSd: { at: number };
  now(): number;
}

export class SubrequestBudget extends Error {}

function num(v: string | undefined, d: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}

// ------------------------------------------------------------------ limity dzienne (atomowe)

/** Doba: YouTube liczy limit wg czasu pacyficznego, Supadata wg UTC (założenia z dokumentacji). */
export function dayKey(nowMs: number, tz: "America/Los_Angeles" | "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
}

/** Najbliższa północ czasu pacyficznego (ms od epoki) — moment zerowania dobowych limitów Google. */
export function nextPacificMidnight(nowMs: number): number {
  const today = dayKey(nowMs, "America/Los_Angeles");
  let lo = nowMs, hi = nowMs + 26 * 3600_000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKey(mid, "America/Los_Angeles") === today) lo = mid; else hi = mid;
  }
  return hi;
}

export function budgetUsed(s: Services, name: string, tz: "America/Los_Angeles" | "UTC"): number {
  const day = dayKey(s.now(), tz);
  const row = s.sql.exec("SELECT used FROM budget WHERE name=? AND day=?", name, day).toArray()[0];
  return row ? Number(row.used) : 0;
}

/** Rezerwacja przed zapytaniem. DO jest jednowątkowe, a blok jest synchroniczny, więc nie ma wyścigu. */
export function reserve(s: Services, name: string, tz: "America/Los_Angeles" | "UTC", limit: number, cost: number, what: string): void {
  const day = dayKey(s.now(), tz);
  const used = budgetUsed(s, name, tz);
  if (limit > 0 && used + cost > limit) {
    throw new PauseError(
      `Dzienny limit bezpieczeństwa (${what}) wyczerpany: zużyto ${used} z ${limit}, a to zapytanie wymaga ${cost}. ` +
        `Licznik zeruje się o północy (${tz}). Limit zmienisz zmienną środowiskową.`,
    );
  }
  s.sql.exec(
    "INSERT INTO budget(name, day, used) VALUES(?,?,?) ON CONFLICT(name, day) DO UPDATE SET used = used + excluded.used",
    name,
    day,
    cost,
  );
}

export function addUsed(s: Services, name: string, tz: "America/Los_Angeles" | "UTC", amount: number): void {
  if (amount <= 0) return;
  s.sql.exec(
    "INSERT INTO budget(name, day, used) VALUES(?,?,?) ON CONFLICT(name, day) DO UPDATE SET used = used + excluded.used",
    name,
    dayKey(s.now(), tz),
    amount,
  );
}

export const ytLimit = (s: Services) => num(s.env.YT_DAILY_UNIT_BUDGET, 9000);
export const sdLimit = (s: Services) => num(s.env.SUPADATA_DAILY_CREDIT_BUDGET, 300);
export const TRANSCRIPT_CACHE_DAYS_DEFAULT = 365;
export const transcriptCacheDays = (s: Services) => Math.max(1, num(s.env.TRANSCRIPT_CACHE_DAYS, TRANSCRIPT_CACHE_DAYS_DEFAULT));

// ----------------------------------------------------------------------------- cache

export function cacheGet(s: Services, key: string): string | null {
  const row = s.sql.exec("SELECT v, exp FROM cache WHERE k=?", key).toArray()[0];
  if (!row) return null;
  if (Number(row.exp) < s.now()) {
    s.sql.exec("DELETE FROM cache WHERE k=?", key);
    return null;
  }
  return String(row.v);
}

export function cacheSet(s: Services, key: string, value: string, ttlSeconds: number): void {
  s.sql.exec(
    "INSERT INTO cache(k, v, exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp",
    key,
    value,
    s.now() + ttlSeconds * 1000,
  );
}

async function doFetch(s: Services, url: string, init: RequestInit): Promise<Response> {
  if (s.sub.count >= s.sub.max) throw new SubrequestBudget("limit subżądań w tym wywołaniu");
  s.sub.count++;
  return s.fetch(url, init);
}

// -------------------------------------------------------------------------------- YouTube

export class YTError extends UserError {
  constructor(message: string, public status = 0, public reason = "") {
    super(message);
  }
}

function explainYt(status: number, body: any): UserError {
  const err = body?.error ?? {};
  const reason: string = err.errors?.[0]?.reason ?? "";
  const message: string = err.message ?? "";
  if (reason === "rateLimitExceeded") {
    // limit TEMPA zapytań (na sekundę/minutę), nie dobowy: wystarczy chwilę poczekać
    return new PauseError("Chwilowy limit tempa zapytań YouTube Data API (to nie dzienny limit). Poczekaj minutę i wznów zadanie; postęp jest zapisany.");
  }
  if (["quotaExceeded", "dailyLimitExceeded"].includes(reason)) {
    return new PauseError(
      "Wyczerpany dzienny limit YouTube Data API. Limit resetuje się o północy czasu pacyficznego (ok. 9:00 rano w Polsce). " +
        "Postęp zadania jest zapisany: wznów je po resecie.",
    );
  }
  if (message.includes("API key not valid") || reason === "keyInvalid") {
    return new PauseError("Klucz YOUTUBE_API_KEY jest nieprawidłowy. Sprawdź go w Google Cloud Console.");
  }
  if (reason === "accessNotConfigured" || reason === "serviceDisabled") {
    return new PauseError("W projekcie Google Cloud nie jest włączone YouTube Data API v3.");
  }
  if (reason === "playlistNotFound") return new YTError("Nie znaleziono playlisty.", status, reason);
  return new YTError(`Błąd YouTube API (${status}): ${message || reason || "nieznany"}`, status, reason);
}

/** Jedno wywołanie YouTube: rezerwacja 1 jednostki PRZED zapytaniem (błędne zapytania też kosztują min. 1). */
export async function ytCall(s: Services, endpoint: string, params: Record<string, string>): Promise<any> {
  reserve(s, "yt_units", "America/Los_Angeles", ytLimit(s), 1, "jednostki YouTube API");
  const wait = s.lastYt.at + num(s.env.YT_DELAY_MS, 250) - s.now();
  if (wait > 0) await sleep(wait); // spokojne tempo między zapytaniami
  const url = `${YT_API}/${endpoint}?${new URLSearchParams(params)}`;
  let resp: Response;
  try {
    s.lastYt.at = s.now();
    resp = await doFetch(s, url, { headers: { "x-goog-api-key": s.env.YOUTUBE_API_KEY } });
  } catch (e) {
    if (e instanceof SubrequestBudget) {
      // zapytanie nie wyszło: oddaj rezerwację
      s.sql.exec("UPDATE budget SET used = used - 1 WHERE name='yt_units' AND day=?", dayKey(s.now(), "America/Los_Angeles"));
      throw e;
    }
    throw new YTError(`Błąd połączenia z YouTube API (${(e as Error).name}).`);
  }
  let body: any = null;
  try {
    body = await resp.json();
  } catch {
    /* brak JSON */
  }
  if (resp.status !== 200) throw explainYt(resp.status, body);
  return body;
}

export function parseIsoDuration(d: string | undefined): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? "");
  if (!m) return 0;
  const [, dd, h, mi, ss] = m.map((x) => Number(x ?? 0));
  return dd * 86400 + h * 3600 + mi * 60 + ss;
}

export interface VideoRow {
  video_id: string;
  title: string;
  duration_seconds: number;
  published_at: string;
  url: string;
  views: number | null;
  likes: number | null; // null = ukryte przez autora albo brak w odpowiedzi
  comments: number | null; // null = komentarze wyłączone albo brak w odpowiedzi
}

/** Liczba ze statystyk YouTube (string) albo null, gdy pola nie ma. Nie zgaduje zera. */
export function statNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export async function fetchVideos(s: Services, ids: string[]): Promise<VideoRow[]> {
  // videos.list z filtrem `id` NIE przyjmuje maxResults ani pageToken; max 50 ID na wywołanie.
  const out = new Map<string, VideoRow>();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await ytCall(s, "videos", { part: "snippet,contentDetails,statistics", id: ids.slice(i, i + 50).join(",") });
    for (const it of data?.items ?? []) {
      out.set(it.id, {
        video_id: it.id,
        title: it.snippet?.title ?? "",
        duration_seconds: parseIsoDuration(it.contentDetails?.duration),
        published_at: it.snippet?.publishedAt ?? "",
        url: `https://www.youtube.com/shorts/${it.id}`,
        views: statNum(it.statistics?.viewCount),
        likes: statNum(it.statistics?.likeCount),
        comments: statNum(it.statistics?.commentCount),
      });
    }
  }
  return ids.filter((v) => out.has(v)).map((v) => out.get(v)!);
}

export interface ChannelInfo {
  channel_id: string;
  title: string;
  handle: string | null;
  uploads_playlist: string;
  video_count: number | null;
}

async function channelBy(s: Services, filt: Record<string, string>): Promise<ChannelInfo | null> {
  const key = "ch:" + JSON.stringify(filt);
  let data: any;
  const hit = cacheGet(s, key);
  if (hit) data = JSON.parse(hit);
  else {
    data = await ytCall(s, "channels", { part: "snippet,statistics,contentDetails", ...filt });
    cacheSet(s, key, JSON.stringify(data), 24 * 3600);
  }
  const it = data?.items?.[0];
  if (!it) return null;
  return {
    channel_id: it.id,
    title: it.snippet?.title ?? "",
    handle: it.snippet?.customUrl ?? null,
    uploads_playlist: it.contentDetails?.relatedPlaylists?.uploads || "UU" + it.id.slice(2),
    video_count: it.statistics?.videoCount != null ? Number(it.statistics.videoCount) : null,
  };
}

const VIDEO_ID_RE = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/;

export async function resolveChannel(s: Services, refIn: string): Promise<ChannelInfo> {
  const ref = (refIn ?? "").trim();
  if (!ref) throw new UserError("Podaj kanał: link, @handle lub ID (UC...).");
  let found: ChannelInfo | null;
  let m: RegExpExecArray | null;
  if ((m = /youtube\.com\/channel\/(UC[\w-]{22})/.exec(ref)) || /^UC[\w-]{22}$/.test(ref)) {
    found = await channelBy(s, { id: m ? m[1] : ref });
  } else if ((m = /youtube\.com\/(@[^/?#\s]+)/.exec(ref)) || ref.startsWith("@")) {
    found = await channelBy(s, { forHandle: m ? m[1] : ref });
  } else if ((m = /youtube\.com\/user\/([^/?#\s]+)/.exec(ref))) {
    found = await channelBy(s, { forUsername: m[1] });
  } else if (ref.includes("youtube.com/") || ref.includes("youtu.be/")) {
    const vm = VIDEO_ID_RE.exec(ref);
    if (!vm) throw new UserError("Nie rozpoznaję kanału w podanym linku. Podaj @handle, link do kanału lub ID (UC...).");
    const data = await ytCall(s, "videos", { part: "snippet", id: vm[1] });
    const cid = data?.items?.[0]?.snippet?.channelId;
    found = cid ? await channelBy(s, { id: cid }) : null;
  } else {
    found = await channelBy(s, { forHandle: "@" + ref.replace(/^@/, "") });
  }
  if (!found) throw new UserError(`Nie znaleziono kanału: ${ref}`);
  return found;
}

// ---------------------------------------------------------------------- komentarze YouTube

export interface CommentRow {
  text: string;
  likes: number | null;
  published_at: string;
}
export type CommentsResult = { state: "ok"; items: CommentRow[] } | { state: "disabled" | "unavailable" | "error"; note: string };

/**
 * Do `n` komentarzy najwyższego poziomu w kolejności TRAFNOŚCI wg YouTube (order=relevance).
 * To nie jest ranking po polubieniach: YouTube sam decyduje o kolejności. Koszt: 1 jednostka.
 */
export async function fetchTopComments(s: Services, videoId: string, n = 5): Promise<CommentsResult> {
  let data: any;
  try {
    data = await ytCall(s, "commentThreads", { part: "snippet", videoId, order: "relevance", maxResults: String(n), textFormat: "plainText" });
  } catch (e) {
    if (e instanceof YTError) {
      if (e.reason === "commentsDisabled") return { state: "disabled", note: "Komentarze wyłączone przez autora." };
      if (e.status === 404 || e.reason === "videoNotFound") return { state: "unavailable", note: "Film niedostępny dla API komentarzy." };
      if (e.status === 403) return { state: "unavailable", note: `Komentarze niedostępne (${e.reason || 403}).` };
      // inne błędy usługi (np. 5xx): oznacz i idź dalej; limit dzienny i zły klucz to PauseError i zatrzymują zadanie
      return { state: "error", note: e.message };
    }
    throw e;
  }
  const items: CommentRow[] = [];
  for (const it of data?.items ?? []) {
    const sn = it?.snippet?.topLevelComment?.snippet;
    if (!sn) continue;
    items.push({ text: String(sn.textDisplay ?? sn.textOriginal ?? ""), likes: statNum(sn.likeCount), published_at: String(sn.publishedAt ?? "") });
    if (items.length >= n) break;
  }
  return { state: "ok", items };
}

// ------------------------------------------------------------------------------ Supadata

export class SupadataError extends UserError {
  constructor(message: string, public status = 0, public code = "", public details = "") {
    super(message);
  }
  /** Po takim błędzie nie ma sensu kontynuować (zły klucz, plan/kredyty, limit zapytań). */
  get fatal(): boolean {
    return [401, 402, 429].includes(this.status);
  }
  /**
   * Wyczerpane kredyty planu. Supadata używa 429 `limit-exceeded` także dla limitu tempa zapytań, więc o kredytach świadczy dopiero
   * `details` ("Plan usage limit was exceeded."); 429 bez rozpoznanego `details` nie jest uznawane za brak kredytów.
   */
  get creditsExhausted(): boolean {
    return this.status === 402 || (this.status === 429 && /usage limit|credit|quota/i.test(this.details));
  }
}

function explainSd(status: number, body: any): SupadataError {
  const hints: Record<number, string> = {
    401: "Nieprawidłowy lub brakujący SUPADATA_API_KEY.",
    402: "Ta funkcja nie jest dostępna w Twoim planie Supadata lub skończyły się kredyty.",
    403: "Film jest niedostępny publicznie (wymaga logowania, prywatny, ograniczony wiekowo lub geoblokada).",
    404: "Film lub zadanie nie istnieje (zadania wygasają po godzinie) albo film jest prywatny.",
    429: "Przekroczony limit zapytań lub kredytów Supadata.",
  };
  let text = hints[status] ?? `Błąd Supadata (${status})`;
  const message = body?.message ?? "";
  const details = String(body?.details ?? "");
  const code = body?.error ?? "";
  if (status === 429 && /usage limit|credit|quota/i.test(details)) text = "Wyczerpany limit kredytów planu Supadata.";
  else if (status === 429 && /rate limit/i.test(details)) text = "Przekroczony limit tempa zapytań Supadata (to nie brak kredytów): poczekaj chwilę i wznów zadanie.";
  const shown = [message, details].filter(Boolean).join(" — ");
  if (shown) text += ` [${code || status}: ${shown.slice(0, 200)}]`;
  return new SupadataError(text, status, String(code), details);
}

async function sdSend(s: Services, path: string, params: Record<string, string> | null, billable: boolean): Promise<Response> {
  const url = `${SD_API}${path}${params ? "?" + new URLSearchParams(params) : ""}`;
  let last: { status: number; body: any } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (billable) reserve(s, "sd_credits", "UTC", sdLimit(s), 1, "kredyty Supadata");
    const wait = s.lastSd.at + num(s.env.SD_MIN_INTERVAL_MS, 300) - s.now();
    if (wait > 0) await sleep(wait);
    let resp: Response;
    try {
      s.lastSd.at = s.now();
      resp = await doFetch(s, url, { headers: { "x-api-key": s.env.SUPADATA_API_KEY } });
    } catch (e) {
      if (billable) s.sql.exec("UPDATE budget SET used = used - 1 WHERE name='sd_credits' AND day=?", dayKey(s.now(), "UTC"));
      if (e instanceof SubrequestBudget) throw e;
      if (attempt === 2) throw new SupadataError(`Błąd połączenia z Supadata (${(e as Error).name}).`);
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (billable) {
      // rezerwacja 1 kredytu zostaje; dolicz ewentualną różnicę wg nagłówka, a przy błędzie serwera zwróć kredyt
      const billed = Number(resp.headers.get("x-billable-requests") ?? 1);
      if (resp.status >= 400) s.sql.exec("UPDATE budget SET used = used - 1 WHERE name='sd_credits' AND day=?", dayKey(s.now(), "UTC"));
      else if (Number.isFinite(billed) && billed > 1) addUsed(s, "sd_credits", "UTC", billed - 1);
    }
    if (resp.status === 429 || resp.status >= 500) {
      let body: any = null;
      try {
        body = await resp.json();
      } catch {
        /* */
      }
      last = { status: resp.status, body };
      const ra = Number(resp.headers.get("retry-after"));
      if (attempt < 2) await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 5) * 1000 : 1000 * (attempt + 1));
      continue;
    }
    return resp;
  }
  throw explainSd(last!.status, last!.body);
}

export type RawResult =
  | { state: "ok"; raw: any }
  | { state: "unavailable" }
  | { state: "pending"; jobId: string };

export function tcacheKey(url: string, lang: string | null, mode: string): string {
  return `tx:${mode}:${lang ?? ""}:${url}`;
}

/** Zwraca surowy wynik Supadata (bez przycinania). Cache transkrypcji: TRANSCRIPT_CACHE_DAYS (domyślnie 365 dni). */
export async function sdFetchRaw(s: Services, url: string, lang: string | null, mode: string): Promise<RawResult & { cached?: boolean }> {
  const key = tcacheKey(url, lang, mode);
  const hit = cacheGet(s, key);
  if (hit) return { state: "ok", raw: JSON.parse(hit), cached: true };
  const params: Record<string, string> = { url, text: "false", mode };
  if (lang) params.lang = lang;
  const resp = await sdSend(s, "/transcript", params, true);
  if (resp.status === 200) {
    const raw = await resp.json();
    cacheSet(s, key, JSON.stringify(raw), transcriptCacheDays(s) * 24 * 3600);
    return { state: "ok", raw };
  }
  if (resp.status === 202) {
    const body: any = await resp.json();
    return { state: "pending", jobId: String(body.jobId) };
  }
  if (resp.status === 206) return { state: "unavailable" };
  let body: any = null;
  try {
    body = await resp.json();
  } catch {
    /* */
  }
  throw explainSd(resp.status, body);
}

/** Sprawdza zadanie asynchroniczne: raw albo null, gdy jeszcze trwa. */
export async function sdPollJob(s: Services, jobId: string): Promise<any | null> {
  const resp = await sdSend(s, `/transcript/${encodeURIComponent(jobId)}`, null, false);
  let body: any = null;
  try {
    body = await resp.json();
  } catch {
    /* */
  }
  if (resp.status !== 200) throw explainSd(resp.status, body);
  if (body?.status === "completed") return body.result ?? body;
  if (body?.status === "failed") throw new SupadataError(`Supadata nie zdołało wygenerować transkrypcji: ${body?.error ?? "nieznany błąd"}`, 500);
  return null;
}

/**
 * Segmenty ze znacznikami czasu: [start_ms, duration_ms, tekst]. Te same segmenty i ten sam trim() co w rawToText,
 * więc złączenie tekstów spacją daje dokładnie pole transcript. Tekst bez segmentów (string) → [] (brak czasów).
 */
export function rawToSegments(raw: any): [number, number, string][] {
  const content = raw?.content;
  if (!Array.isArray(content)) return [];
  const out: [number, number, string][] = [];
  for (const seg of content) {
    const t = typeof seg?.text === "string" ? seg.text.trim() : "";
    if (!t.length) continue;
    const off = Number(seg?.offset), dur = Number(seg?.duration);
    out.push([Number.isFinite(off) ? Math.max(0, Math.round(off)) : -1, Number.isFinite(dur) ? Math.max(0, Math.round(dur)) : -1, t]);
  }
  return out;
}

/** Pełny tekst z segmentów, złączonych pojedynczą spacją. Niczego nie skraca ani nie zmienia w treści segmentów. */
export function rawToText(raw: any): string {
  const content = raw?.content;
  if (Array.isArray(content)) {
    return content
      .map((seg: any) => (typeof seg?.text === "string" ? seg.text.trim() : ""))
      .filter((t: string) => t.length > 0)
      .join(" ");
  }
  return typeof content === "string" ? content : "";
}
