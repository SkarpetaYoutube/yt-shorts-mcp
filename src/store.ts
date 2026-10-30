// Durable Object (SQLite): jedyny magazyn danych. Zadania zbierania, transkrypcje, cache, limity dzienne, pomiary, zestawy eksportu.
// Praca w tle idzie przez alarmy (małe kroki, każdy z własnym limitem 50 subżądań i 10 ms CPU w planie Free).
import { DurableObject } from "cloudflare:workers";
import {
  FREE_SUBREQUEST_LIMIT,
  SHORTS_MAX_SECONDS,
  SubrequestBudget,
  SupadataError,
  YTError,
  budgetUsed,
  cacheGet,
  fetchTopComments,
  fetchVideos,
  rawToSegments,
  rawToText,
  resolveChannel,
  sdFetchRaw,
  sdLimit,
  sdPollJob,
  ytCall,
  ytLimit,
  type ChannelInfo,
  type Services,
} from "./clients";
import { PauseError, UserError, type Env } from "./types";
import { sha256Hex } from "./util";
import { SetBuilder, type SetSpec } from "./sets";
import { timedStatus } from "./csv";
import { GEMINI_DEFAULT_MODEL, compareRuns, isRetryable, runGemini, videoIdFrom, visToMarkdown, type VisRecord } from "./vision";
import { addUsed, nextPacificMidnight, reserve } from "./clients";

export type Mode = "newest" | "oldest" | "most_viewed";
export type TMode = "native" | "auto";
import { MIN_SHORTS_FOR_NORM, MIN_SHORTS_FOR_TOP5, SNAPSHOT_MIN_GAP_MS } from "./constants";
export { MIN_SHORTS_FOR_NORM, MIN_SHORTS_FOR_TOP5, NORM_MULTIPLIER, SNAPSHOT_MIN_GAP_MS } from "./constants";

/** Statusy transkrypcji. `error` to zapis z wersji 1 (traktowany jak error_service). */
export const TRANSCRIPT_STATUSES = ["ok", "empty", "no_captions", "error_video", "error_service", "no_credits", "pending", "pending_ai"] as const;

export interface Baseline {
  shorts_with_views: number;
  median_views: number | null;
  p95_views: number | null;
  history_complete: boolean;
  /** czy norma (mediana) nadaje się do porównań: pełna historia, >= MIN_SHORTS_FOR_NORM rolek, mediana > 0 */
  norm_usable?: boolean;
  /** czy TOP 5% ma sens: pełna historia i >= MIN_SHORTS_FOR_TOP5 rolek (5% z 20 = 1 rolka) */
  top5_usable?: boolean;
  notes?: string[];
  measured_at: string;
}

export interface Job {
  id: string;
  created: number;
  updated: number;
  /** licznik zmian danych zadania (transkrypcje, statystyki, komentarze); zmiana unieważnia gotowe eksporty */
  rev?: number;
  phase: "enumerating" | "transcribing" | "refreshing" | "done";
  running: boolean;
  channel: { channel_id: string; title: string; handle: string | null; video_count: number | null };
  mode: Mode;
  count: number;
  transcriptMode: TMode;
  lang: string | null;
  enum: {
    source: "shorts_playlist" | "uploads_filtered_by_duration";
    playlistId: string;
    uploadsPlaylist: string;
    pageToken: string | null;
    pages: number;
    finished: boolean;
    historyComplete: boolean;
    historyCapped: boolean;
    unavailable: number;
    excludedLong: number;
    seen: number;
  };
  shortfall: { requested: number; available: number } | null;
  stoppedReason: string | null;
  completedAt?: number;
  /** wskaźnik na zestaw eksportu tego zadania (eksport pojedynczego zadania to zestaw z jednym zadaniem) */
  export: { setId: string } | null;
  /** brak w zadaniach sprzed rozbudowy: wtedy bez komentarzy i bez statystyk kanału */
  opts?: { comments: boolean; channelStats: boolean; estimateFirst?: boolean };
  baseline?: Baseline | null;
  /** zadanie czeka na potwierdzenie po szacunku kosztów (continue_collection rusza dalej) */
  awaiting?: "confirm" | null;
  estimate?: any;
  /** odświeżanie samych statystyk/komentarzy (bez transkrypcji) */
  refresh?: { startedAt: number; comments: boolean; via: "channel" | "items"; finishedAt?: number } | null;
}

const num = (v: string | undefined, d: number) => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

const MAX_ROW_CHARS = 1_500_000; // limit wiersza SQLite w DO to 2 MB; zostawiamy zapas
/** Najdłuższy czas przechowywania statystyk i danych z YouTube API (zasady YouTube API Services: 30 dni). */
export const STATS_MAX_DAYS = 30;

/**
 * Schemat bazy. Tylko operacje nieniszczące: CREATE ... IF NOT EXISTS i ADD COLUMN. Wdrożenie nowego kodu
 * i restart Durable Object nie usuwają danych (transkrypcji, pomiarów, zadań). Wywołanie wielokrotne jest bezpieczne.
 */
export const SCHEMA_VERSION = 3;
export function migrate(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS budget (name TEXT NOT NULL, day TEXT NOT NULL, used REAL NOT NULL, PRIMARY KEY(name, day))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cands (job TEXT NOT NULL, vid TEXT NOT NULL, title TEXT NOT NULL, dur INTEGER NOT NULL,
             pub TEXT NOT NULL, ts INTEGER NOT NULL, views INTEGER, PRIMARY KEY(job, vid))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS items (job TEXT NOT NULL, vid TEXT NOT NULL, ord INTEGER NOT NULL, title TEXT NOT NULL,
             dur INTEGER NOT NULL, pub TEXT NOT NULL, views INTEGER, url TEXT NOT NULL, status TEXT NOT NULL, err TEXT,
             sjob TEXT, transcript TEXT, chars INTEGER, hash TEXT, PRIMARY KEY(job, vid))`);
  sql.exec(`CREATE INDEX IF NOT EXISTS items_ord ON items(job, ord)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS exp_chunks (job TEXT NOT NULL, fmt TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
             PRIMARY KEY(job, fmt, seq))`);
  // pomiary statystyk w czasie (historia przyrostów)
  sql.exec(`CREATE TABLE IF NOT EXISTS snaps (vid TEXT NOT NULL, at INTEGER NOT NULL, views INTEGER, likes INTEGER, ccount INTEGER,
             PRIMARY KEY(vid, at))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  // zestawy eksportu (jedno lub wiele zadań, filtry, sortowanie)
  sql.exec(`CREATE TABLE IF NOT EXISTS sets (id TEXT PRIMARY KEY, phase TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS set_cands (sid TEXT NOT NULL, vid TEXT NOT NULL, job TEXT NOT NULL, jidx INTEGER NOT NULL,
             mat INTEGER, med REAL, prevv INTEGER, PRIMARY KEY(sid, vid))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS set_items (sid TEXT NOT NULL, pos INTEGER NOT NULL, job TEXT NOT NULL, vid TEXT NOT NULL,
             srank INTEGER, PRIMARY KEY(sid, pos))`);
  // rozpoznawanie zdjęć (Gemini): jeden wiersz na przebieg (rolka + fps)
  sql.exec(`CREATE TABLE IF NOT EXISTS vis (id TEXT PRIMARY KEY, vid TEXT NOT NULL, fps REAL NOT NULL, status TEXT NOT NULL, state TEXT NOT NULL,
             created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS vis_vid ON vis(vid, created)`);
  const cols = (t: string) => new Set(sql.exec(`PRAGMA table_info(${t})`).toArray().map((r) => String(r.name)));
  const add = (t: string, defs: string[]) => {
    const have = cols(t);
    for (const d of defs) if (!have.has(d.split(" ")[0])) sql.exec(`ALTER TABLE ${t} ADD COLUMN ${d}`);
  };
  add("vis", ["batch TEXT", "attempt INTEGER", "next_at INTEGER", "secs REAL", "http INTEGER", "tokens INTEGER", "nimg INTEGER", "nmsg INTEGER", "err TEXT", "started INTEGER", "ended INTEGER"]);
  sql.exec(`CREATE INDEX IF NOT EXISTS vis_batch ON vis(batch)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS vis_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)`); // trwały stan kolejki (pauzy po 429, ostatni alarm) — przeżywa wdrożenie
  add("cands", ["likes INTEGER", "ccount INTEGER", "mat INTEGER"]);
  add("items", ["likes INTEGER", "ccount INTEGER", "mat INTEGER", "crank INTEGER", "segs TEXT", "cmts TEXT", "cstat TEXT", "cfat INTEGER", "sstat TEXT", "sgst TEXT"]);
  sql.exec(`CREATE INDEX IF NOT EXISTS cands_views ON cands(job, views)`);
  const row = sql.exec("SELECT v FROM meta WHERE k='schema'").toArray()[0];
  const ver = row ? Number(row.v) : 1;
  if (ver < 2) {
    // jednorazowo: transkrypcje zapisane w wersji 1 miały ważność 30 dni; wydłużamy do domyślnych 365 dni od zapisu
    sql.exec("UPDATE cache SET exp = exp + ? WHERE k LIKE 'tx:%'", (365 - 30) * 86400_000);
  }
  sql.exec("INSERT INTO meta(k, v) VALUES('schema', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(SCHEMA_VERSION));
}

/** Norma kanału z kandydatów wyliczenia: mediana i 95. percentyl (najbliższa ranga), z progami małej próby. */
function computeBaseline(sql: SqlStorage, job: Job): Baseline {
  const nv = Number(sql.exec("SELECT COUNT(*) AS n FROM cands WHERE job=? AND views IS NOT NULL", job.id).one().n);
  const at = (k: number) => (nv ? Number(sql.exec("SELECT views FROM cands WHERE job=? AND views IS NOT NULL ORDER BY views ASC LIMIT 1 OFFSET ?", job.id, k).one().views) : null);
  let median: number | null = null;
  if (nv) median = nv % 2 ? at((nv - 1) / 2) : ((at(nv / 2 - 1) as number) + (at(nv / 2) as number)) / 2;
  const complete = job.enum.historyComplete && !job.enum.historyCapped;
  const notes: string[] = [];
  if (!complete) notes.push("Historia kanału niepełna: pozycja, TOP 5% i norma nie są liczone.");
  if (nv < MIN_SHORTS_FOR_NORM) notes.push(`Za mało Shortsów z wyświetleniami (${nv} < ${MIN_SHORTS_FOR_NORM}), by liczyć normę kanału.`);
  else if (median === 0) notes.push("Mediana wyświetleń kanału wynosi 0: norma kanału (krotność mediany) nie ma sensu i nie jest liczona.");
  if (nv < MIN_SHORTS_FOR_TOP5) notes.push(`Za mało Shortsów z wyświetleniami (${nv} < ${MIN_SHORTS_FOR_TOP5}), by wskazać TOP 5%.`);
  return {
    shorts_with_views: nv,
    median_views: median,
    p95_views: nv ? at(Math.max(0, Math.ceil(0.95 * nv) - 1)) : null,
    history_complete: complete,
    norm_usable: complete && nv >= MIN_SHORTS_FOR_NORM && median != null && median > 0,
    top5_usable: complete && nv >= MIN_SHORTS_FOR_TOP5,
    notes,
    measured_at: new Date().toISOString(),
  };
}

const RANKED_CANDS = `SELECT *, CASE WHEN views IS NULL THEN NULL ELSE RANK() OVER (ORDER BY COALESCE(views,-1) DESC) END AS crank FROM cands WHERE job=?`;

export class Store extends DurableObject<Env> {
  private lastYt = { at: 0 };
  private lastSd = { at: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql);
    });
  }

  // ----------------------------------------------------------------------- infrastruktura

  private svc(): Services {
    return {
      sql: this.ctx.storage.sql,
      env: this.env,
      fetch: (u, i) => fetch(u as any, i),
      sub: { count: 0, max: FREE_SUBREQUEST_LIMIT - 5 },
      lastYt: this.lastYt,
      lastSd: this.lastSd,
      now: () => Date.now(),
    };
  }

  loadJob(id: string): Job {
    const row = this.ctx.storage.sql.exec("SELECT state FROM jobs WHERE id=?", id).toArray()[0];
    if (!row) throw new UserError(`Nie ma zadania ${id} (albo wygasło). Użyj list_collections.`);
    const job = JSON.parse(String(row.state)) as Job;
    // eksport w formacie wersji 2 (bez setId) nie jest już obsługiwany: zostanie zbudowany od nowa
    if (job.export && !(job.export as any).setId) job.export = null;
    return job;
  }

  saveJob(job: Job): void {
    job.updated = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO jobs(id, state, created, updated) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated=excluded.updated",
      job.id,
      JSON.stringify(job),
      job.created,
      job.updated,
    );
  }

  private bump(job: Job): void {
    job.rev = (job.rev ?? 0) + 1;
  }

  async scheduleAlarm(delayMs: number): Promise<void> {
    const at = Date.now() + Math.max(delayMs, 0);
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  private sets(): SetBuilder {
    return new SetBuilder(this.ctx.storage.sql, (id) => this.loadJob(id), (j) => this.saveJob(j), this.ctx.storage);
  }

  private prune(): void {
    const sql = this.ctx.storage.sql;
    // Zasady YouTube API Services (III.E.4): dane z API (w tym statystyki) bez autoryzacji użytkownika wolno trzymać
    // najwyżej 30 dni, potem trzeba je usunąć albo odświeżyć. Liczymy od ostatniego pomiaru statystyk zadania.
    const cutoff = Date.now() - Math.min(num(this.env.COLLECT_RETENTION_DAYS, 30), STATS_MAX_DAYS) * 86400_000;
    const old = sql
      .exec("SELECT id FROM jobs WHERE created < ?", cutoff)
      .toArray()
      .filter((r) => {
        const j = JSON.parse(String(sql.exec("SELECT state FROM jobs WHERE id=?", String(r.id)).one().state)) as Job;
        return (j.refresh?.finishedAt ?? j.completedAt ?? j.created) < cutoff && !j.running;
      });
    for (const r of old) {
      const id = String(r.id);
      for (const t of ["items", "cands", "exp_chunks"]) sql.exec(`DELETE FROM ${t} WHERE job=?`, id);
      sql.exec("DELETE FROM jobs WHERE id=?", id);
    }
    this.sets().prune(Date.now() - 7 * 86400_000);
    sql.exec("DELETE FROM vis WHERE created < ?", Date.now() - STATS_MAX_DAYS * 86400_000);
    sql.exec("DELETE FROM cache WHERE exp < ?", Date.now());
    sql.exec("DELETE FROM snaps WHERE at < ?", Date.now() - STATS_MAX_DAYS * 86400_000);
    sql.exec("DELETE FROM budget WHERE day < ?", new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10));
  }

  // --------------------------------------------------------------------------- RPC: zadania

  async startJob(p: {
    channel: string; mode: Mode; count: number; transcriptMode: TMode; lang: string | null;
    comments?: boolean; channelStats?: boolean; estimateFirst?: boolean;
  }): Promise<any> {
    const max = num(this.env.COLLECT_MAX_COUNT, 500);
    if (!Number.isInteger(p.count) || p.count < 1 || p.count > max) throw new UserError(`count musi być liczbą całkowitą 1-${max}.`);
    if (!["newest", "oldest", "most_viewed"].includes(p.mode)) throw new UserError("mode: newest, oldest albo most_viewed.");
    this.prune();
    const s = this.svc();
    let ch: ChannelInfo;
    try {
      ch = await resolveChannel(s, p.channel);
    } catch (e) {
      if (e instanceof SubrequestBudget) throw new UserError("Chwilowo za dużo zapytań, spróbuj ponownie.");
      throw e;
    }
    const id = "c-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const job: Job = {
      id,
      created: Date.now(),
      updated: Date.now(),
      rev: 0,
      phase: "enumerating",
      running: true,
      channel: { channel_id: ch.channel_id, title: ch.title, handle: ch.handle, video_count: ch.video_count },
      mode: p.mode,
      count: p.count,
      transcriptMode: p.transcriptMode,
      lang: p.lang,
      enum: this.freshEnum(ch.channel_id, ch.uploads_playlist),
      shortfall: null,
      stoppedReason: null,
      export: null,
      opts: { comments: p.comments !== false, channelStats: p.channelStats !== false, estimateFirst: p.estimateFirst === true },
      baseline: null,
      awaiting: null,
      refresh: null,
    };
    this.saveJob(job);
    await this.scheduleAlarm(0);
    return this.statusOf(job);
  }

  private freshEnum(channelId: string, uploads: string): Job["enum"] {
    return {
      source: "shorts_playlist", playlistId: "UUSH" + channelId.slice(2), uploadsPlaylist: uploads, pageToken: null, pages: 0,
      finished: false, historyComplete: false, historyCapped: false, unavailable: 0, excludedLong: 0, seen: 0,
    };
  }

  /**
   * Wznowienie. Domyślnie ponawia tylko to, czego brakuje z powodu przerwy (wyczerpane kredyty, niepobrane komentarze).
   * retry_failed dodatkowo ponawia błędy usług i filmów; transcript_mode=auto ponawia filmy bez napisów.
   */
  async resume(jobId: string, opts: { retryFailed?: boolean; transcriptMode?: TMode | null }): Promise<any> {
    const job = this.loadJob(jobId);
    const sql = this.ctx.storage.sql;
    if (opts.transcriptMode && opts.transcriptMode !== job.transcriptMode) job.transcriptMode = opts.transcriptMode;
    const requeue = ["no_credits"];
    if (opts.retryFailed) requeue.push("error", "error_service", "error_video");
    if (opts.transcriptMode === "auto") requeue.push("no_captions");
    let changed = 0;
    for (const st of requeue) changed += sql.exec("UPDATE items SET status='pending', err=NULL, sjob=NULL WHERE job=? AND status=?", jobId, st).rowsWritten;
    if (opts.retryFailed && job.opts?.comments) changed += sql.exec("UPDATE items SET cstat=NULL WHERE job=? AND cstat='error'", jobId).rowsWritten;
    if (changed && job.phase === "done") job.phase = "transcribing";
    if (changed) this.bump(job);
    if (job.awaiting === "confirm") job.awaiting = null;
    if (job.phase !== "done" && !job.running) {
      job.running = true;
      job.stoppedReason = null;
    }
    this.saveJob(job);
    if (job.running) await this.scheduleAlarm(0);
    return this.statusOf(job);
  }

  /**
   * Odświeża wyłącznie statystyki (wyświetlenia, polubienia, liczba komentarzy) i opcjonalnie komentarze.
   * Transkrypcje nie są pobierane. Każdy pomiar trafia do historii; normy i ranking kanału są liczone od nowa.
   */
  async refresh(jobId: string, p: { comments: boolean; channelStats: boolean | null }): Promise<any> {
    const job = this.loadJob(jobId);
    if (job.running) throw new UserError("Zadanie jeszcze pracuje. Odświeżyć można zadanie zatrzymane albo zakończone.");
    const total = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM items WHERE job=?", jobId).one().n);
    if (!total) throw new UserError("Zadanie nie ma jeszcze wybranych filmów.");
    const via = (p.channelStats ?? job.opts?.channelStats ?? false) ? "channel" : "items";
    job.opts = { comments: job.opts?.comments ?? false, channelStats: job.opts?.channelStats ?? false, estimateFirst: job.opts?.estimateFirst };
    if (p.comments) job.opts.comments = true;
    if (via === "channel") job.opts.channelStats = true;
    job.refresh = { startedAt: Date.now(), comments: p.comments, via };
    job.awaiting = null;
    job.stoppedReason = null;
    job.running = true;
    if (via === "channel") {
      const uploads = job.enum.uploadsPlaylist;
      job.enum = this.freshEnum(job.channel.channel_id, uploads);
      job.phase = "enumerating";
    } else job.phase = "refreshing";
    this.ctx.storage.sql.exec("DELETE FROM cands WHERE job=?", jobId);
    this.saveJob(job);
    await this.scheduleAlarm(0);
    const st = this.statusOf(job);
    const pages = Math.ceil(((job.channel.video_count ?? total) as number) / 50);
    st.refresh_estimate = {
      supadata_credits: 0,
      youtube_units_approx: (via === "channel" ? pages * 2 : Math.ceil(total / 50)) + (p.comments ? total : 0),
      note: "Transkrypcje nie są pobierane. Jednostki YouTube: lista filmów/statystyki + 1 na film za komentarze (gdy włączone).",
    };
    return st;
  }

  async status(jobId: string): Promise<any> {
    return this.statusOf(this.loadJob(jobId));
  }

  async list(limit: number): Promise<any> {
    const rows = this.ctx.storage.sql.exec("SELECT id FROM jobs ORDER BY updated DESC LIMIT ?", Math.max(1, Math.min(limit, 50))).toArray();
    const out = rows.map((r) => {
      const st = this.statusOf(this.loadJob(String(r.id)));
      return { job_id: st.job_id, complete: st.complete, phase: st.phase, channel: st.channel, mode: st.mode, requested: st.requested, selected: st.selected, progress: st.progress };
    });
    return { collections: out };
  }

  statusOf(job: Job): any {
    const sql = this.ctx.storage.sql;
    const counts: Record<string, number> = Object.fromEntries(TRANSCRIPT_STATUSES.map((s) => [s, 0]));
    let total = 0;
    for (const r of sql.exec("SELECT status, COUNT(*) AS n FROM items WHERE job=? GROUP BY status", job.id).toArray()) {
      const k = String(r.status) === "error" ? "error_service" : String(r.status);
      counts[k] = (counts[k] ?? 0) + Number(r.n);
      total += Number(r.n);
    }
    const problems = sql
      .exec("SELECT vid, url, status, err FROM items WHERE job=? AND status NOT IN ('ok','pending','pending_ai') ORDER BY ord LIMIT 50", job.id)
      .toArray()
      .map((r) => ({ video_id: String(r.vid), url: String(r.url), status: String(r.status) === "error" ? "error_service" : String(r.status), error: r.err == null ? null : String(r.err) }));
    const problemsTotal = total - counts.ok - counts.pending - counts.pending_ai;
    const done = job.phase === "done";
    let comments: any = null;
    if (job.opts?.comments) {
      const c: Record<string, number> = {};
      for (const r of sql.exec("SELECT COALESCE(cstat,'not_fetched') AS st, COUNT(*) AS n FROM items WHERE job=? GROUP BY st", job.id).toArray()) c[String(r.st)] = Number(r.n);
      comments = {
        order: "relevance (kolejność wg YouTube, nie wg polubień)",
        fetched: c.ok ?? 0, disabled: c.disabled ?? 0, unavailable: c.unavailable ?? 0, error: c.error ?? 0, not_fetched: c.not_fetched ?? 0,
      };
    }
    let next: string;
    if (job.awaiting === "confirm") next = "Szacunek kosztów gotowy (pole estimate). Jeśli się zgadzasz, wywołaj continue_collection, aby pobrać transkrypcje.";
    else if (done) next = "Gotowe. Wywołaj export_collection (CSV/JSON/Markdown) albo read_collection (czytanie w rozmowie).";
    else if (job.running) next = "Zadanie pracuje w tle na serwerze. Wywołaj continue_collection z wait_seconds albo get_collection_status za chwilę.";
    else next = `Zatrzymano: ${job.stoppedReason ?? "wstrzymane"} Po usunięciu przyczyny wywołaj continue_collection (ponowi tylko brakujące elementy).`;
    const e = job.enum;
    return {
      job_id: job.id,
      phase: job.phase,
      running: job.running,
      complete: done,
      awaiting_confirmation: job.awaiting === "confirm",
      estimate: job.estimate ?? null,
      channel: job.channel,
      mode: job.mode,
      requested: job.count,
      selected: total,
      shortfall: job.shortfall,
      progress: { total, ...counts },
      comments,
      refresh: job.refresh ?? null,
      channel_baseline: job.baseline ?? null,
      enumeration: {
        source: e.source, pages: e.pages, videos_seen: e.seen, history_complete: e.historyComplete, history_capped: e.historyCapped,
        unavailable_videos: e.unavailable, excluded_as_not_short: e.excludedLong,
      },
      stopped_reason: job.stoppedReason,
      problems_total: problemsTotal,
      problems,
      next_step: next,
    };
  }

  // ------------------------------------------------------------------------------ alarm

  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    let again = false;
    let delay = num(this.env.ALARM_DELAY_MS, 500);
    // 1) zestawy eksportu (kroki bez sieci). Jeden rodzaj pracy na alarm, by nie przekroczyć limitu CPU planu Free.
    const sb = this.sets();
    if (await sb.stepAny()) {
      await this.scheduleAlarm(0);
      return;
    }
    // 2) jeden przebieg rozpoznawania zdjęć (Gemini); długie czekanie na odpowiedź to czas zegarowy, nie CPU
    if (await this.visionStepAny()) {
      await this.scheduleAlarm(0);
      return;
    }
    // 2) jedno zadanie na alarm: każdy krok ma własny limit subżądań i CPU
    const ids = sql.exec("SELECT id FROM jobs ORDER BY updated ASC").toArray().map((r) => String(r.id));
    for (const id of ids) {
      const job = this.loadJob(id);
      if (!job.running) continue;
      const s = this.svc();
      try {
        if (job.phase === "enumerating") await this.enumStep(s, job);
        else if (job.phase === "refreshing") await this.refreshItemsStep(s, job);
        else if (job.phase === "transcribing") delay = Math.max(delay, await this.transcribeStep(s, job));
      } catch (e) {
        if (e instanceof SubrequestBudget) {
          /* normalnie: kontynuacja w następnym alarmie */
        } else if (e instanceof UserError) {
          job.running = false;
          job.stoppedReason = e.message;
        } else {
          console.error("Nieoczekiwany błąd kroku zadania", id, (e as Error)?.name, (e as Error)?.message);
          job.running = false;
          job.stoppedReason = "Wewnętrzny błąd serwera (szczegóły w logach Workera). Zadanie można wznowić.";
        }
      }
      this.bump(job);
      this.saveJob(job);
      if (job.running) again = true;
      break;
    }
    if (!again) {
      for (const r of sql.exec("SELECT id FROM jobs").toArray()) if (this.loadJob(String(r.id)).running) again = true;
      if (sb.anyBuilding()) again = true;
      const vw = this.visionWaitMs();
      if (vw !== null) {
        again = true;
        delay = Math.max(delay, Math.min(vw, 30_000)); // zaległe ponowienia: nie budzimy się częściej, niż trzeba
      }
    }
    if (again) await this.scheduleAlarm(delay);
  }

  // ------------------------------------------------------------------- wyliczanie filmów

  private async enumStep(s: Services, job: Job): Promise<void> {
    const sql = this.ctx.storage.sql;
    const e = job.enum;
    const maxHistory = num(this.env.COLLECT_MAX_HISTORY, 10_000);
    const refreshing = !!job.refresh && !job.refresh.finishedAt;
    let pages = 0;
    while (!e.finished && pages < 3) {
      if (s.sub.count + 2 > s.sub.max) break;
      const params: Record<string, string> = { part: "contentDetails", playlistId: e.playlistId, maxResults: "50" };
      if (e.pageToken) params.pageToken = e.pageToken;
      let data: any;
      try {
        data = await ytCall(s, "playlistItems", params);
      } catch (err) {
        if (err instanceof YTError && e.source === "shorts_playlist" && e.pages === 0 && (err.reason === "playlistNotFound" || err.status === 404)) {
          e.source = "uploads_filtered_by_duration";
          e.playlistId = e.uploadsPlaylist;
          e.pageToken = null;
          this.saveJob(job);
          continue;
        }
        throw err;
      }
      const ids: string[] = [];
      for (const it of data?.items ?? []) {
        const vid = it?.contentDetails?.videoId;
        if (vid && !ids.includes(vid)) ids.push(vid);
      }
      const known = new Set(
        ids.length ? sql.exec(`SELECT vid FROM cands WHERE job=? AND vid IN (${ids.map(() => "?").join(",")})`, job.id, ...ids).toArray().map((r) => String(r.vid)) : [],
      );
      const fresh = ids.filter((v) => !known.has(v));
      const rows = fresh.length ? await fetchVideos(s, fresh) : [];
      e.unavailable += fresh.length - rows.length; // prywatne/usunięte: nie da się ich pobrać, ale je zliczamy
      const mat = Date.now();
      this.ctx.storage.transactionSync(() => {
        for (const r of rows) {
          if (e.source === "uploads_filtered_by_duration" && r.duration_seconds > SHORTS_MAX_SECONDS) {
            e.excludedLong++;
            continue;
          }
          const ts = Date.parse(r.published_at);
          sql.exec(
            "INSERT OR IGNORE INTO cands(job, vid, title, dur, pub, ts, views, likes, ccount, mat) VALUES(?,?,?,?,?,?,?,?,?,?)",
            job.id, r.video_id, r.title, r.duration_seconds, r.published_at, Number.isFinite(ts) ? ts : 0, r.views, r.likes, r.comments, mat,
          );
          this.snapshot(r.video_id, mat, r.views, r.likes, r.comments);
        }
      });
      e.seen = Number(sql.exec("SELECT COUNT(*) AS n FROM cands WHERE job=?", job.id).one().n);
      e.pages++;
      pages++;
      e.pageToken = data?.nextPageToken ?? null;
      if (!e.pageToken) {
        e.finished = true;
        e.historyComplete = true;
      } else if (!refreshing && job.mode === "newest" && e.seen >= job.count && !job.opts?.channelStats) {
        e.finished = true; // lista idzie od najnowszych: dalsze strony niepotrzebne (chyba że liczymy normę kanału)
      } else if (e.seen >= maxHistory) {
        e.finished = true;
        e.historyCapped = true;
      }
      this.saveJob(job);
    }
    if (e.finished) {
      if (refreshing) this.refreshFromCands(job);
      else this.selectItems(job);
    }
  }

  /** Pomiar do historii przyrostów (nie częściej niż co SNAPSHOT_MIN_GAP_MS dla tego samego filmu). */
  private snapshot(vid: string, at: number, views: number | null, likes: number | null, ccount: number | null): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO snaps(vid, at, views, likes, ccount) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM snaps WHERE vid=? AND at > ?)",
      vid, at, views, likes, ccount, vid, at - SNAPSHOT_MIN_GAP_MS,
    );
  }

  private selectItems(job: Job): void {
    const sql = this.ctx.storage.sql;
    const order =
      job.mode === "newest" ? "ts DESC, vid ASC" : job.mode === "oldest" ? "ts ASC, vid ASC" : "COALESCE(views,0) DESC, ts DESC, vid ASC";
    if (job.opts?.channelStats) job.baseline = computeBaseline(sql, job);
    this.ctx.storage.transactionSync(() => {
      const rows = sql.exec(`SELECT vid, title, dur, pub, views, likes, ccount, mat, crank FROM (${RANKED_CANDS}) ORDER BY ${order} LIMIT ?`, job.id, job.count).toArray();
      sql.exec("DELETE FROM items WHERE job=?", job.id);
      const nul = (v: unknown) => (v == null ? null : Number(v));
      rows.forEach((r, i) => {
        sql.exec(
          `INSERT INTO items(job, vid, ord, title, dur, pub, views, url, status, likes, ccount, mat, crank, sstat) VALUES(?,?,?,?,?,?,?,?, 'pending',?,?,?,?, 'ok')`,
          job.id, String(r.vid), i, String(r.title), Number(r.dur), String(r.pub), nul(r.views),
          `https://www.youtube.com/shorts/${r.vid}`, nul(r.likes), nul(r.ccount), nul(r.mat), job.opts?.channelStats ? nul(r.crank) : null,
        );
      });
      sql.exec("DELETE FROM cands WHERE job=?", job.id);
      job.shortfall = rows.length < job.count ? { requested: job.count, available: rows.length } : null;
      job.phase = "transcribing";
      if (rows.length === 0) {
        job.phase = "done";
        job.running = false;
        job.completedAt = Date.now();
      }
    });
    if (job.phase === "transcribing") {
      job.estimate = this.estimate(job);
      if (job.opts?.estimateFirst) {
        job.awaiting = "confirm";
        job.running = false;
        job.stoppedReason = "Czeka na potwierdzenie po szacunku kosztów (estimate).";
      }
    }
  }

  /** Przewidywane zużycie: transkrypcje już zapisane w pamięci serwera nic nie kosztują. */
  private estimate(job: Job): any {
    const sql = this.ctx.storage.sql;
    const n = Number(sql.exec("SELECT COUNT(*) AS n FROM items WHERE job=? AND status IN ('pending','pending_ai')", job.id).one().n);
    const cached = Number(
      sql.exec(
        `SELECT COUNT(*) AS n FROM items i WHERE i.job=? AND i.status='pending'
           AND EXISTS (SELECT 1 FROM cache c WHERE c.k = 'tx:' || ? || ':' || ? || ':' || i.url AND c.exp > ?)`,
        job.id, job.transcriptMode, job.lang ?? "", Date.now(),
      ).one().n,
    );
    const comments = job.opts?.comments ? Number(sql.exec("SELECT COUNT(*) AS n FROM items WHERE job=? AND cstat IS NULL", job.id).one().n) : 0;
    return {
      videos_to_transcribe: n,
      transcripts_already_saved: cached,
      supadata_credits_estimated: n - cached,
      supadata_note:
        job.transcriptMode === "native"
          ? "native: 1 kredyt na film bez zapisanego transkryptu (filmy bez napisów też mogą zostać policzone przez Supadata)."
          : "auto: filmy bez napisów są generowane przez AI Supadata i mogą kosztować więcej niż 1 kredyt (zależnie od długości).",
      youtube_units_comments: comments,
      youtube_note: "Wyliczenie kanału już się odbyło. Komentarze: 1 jednostka na film (limit dzienny YouTube API: 10 000).",
      supadata_credits_today_on_server: budgetUsed(this.svc(), "sd_credits", "UTC"),
      supadata_safety_limit: sdLimit(this.svc()),
    };
  }

  /** Po odświeżeniu przez wyliczenie kanału: nowe statystyki i ranking dla wybranych filmów, bez zmiany zestawu. */
  private refreshFromCands(job: Job): void {
    const sql = this.ctx.storage.sql;
    job.baseline = computeBaseline(sql, job);
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `WITH r AS (${RANKED_CANDS})
         UPDATE items SET views=r.views, likes=r.likes, ccount=r.ccount, mat=r.mat, crank=r.crank, title=r.title, sstat='ok'
         FROM r WHERE items.job=? AND items.vid=r.vid`,
        job.id, job.id,
      );
      sql.exec("UPDATE items SET sstat='unavailable' WHERE job=? AND vid NOT IN (SELECT vid FROM cands WHERE job=?)", job.id, job.id);
      sql.exec("DELETE FROM cands WHERE job=?", job.id);
    });
    this.afterStatsRefresh(job);
  }

  /** Odświeżenie bez wyliczania kanału: videos.list dla wybranych filmów (1 jednostka na 50 filmów). */
  private async refreshItemsStep(s: Services, job: Job): Promise<void> {
    const sql = this.ctx.storage.sql;
    const since = job.refresh!.startedAt;
    for (let k = 0; k < 3; k++) {
      if (s.sub.count + 2 > s.sub.max) return;
      const ids = sql.exec("SELECT vid FROM items WHERE job=? AND (mat IS NULL OR mat < ?) AND COALESCE(sstat,'ok') != 'gone' ORDER BY ord LIMIT 50", job.id, since).toArray().map((r) => String(r.vid));
      if (!ids.length) break;
      const rows = await fetchVideos(s, ids);
      const mat = Date.now();
      const got = new Set(rows.map((r) => r.video_id));
      this.ctx.storage.transactionSync(() => {
        for (const r of rows) {
          sql.exec("UPDATE items SET views=?, likes=?, ccount=?, mat=?, title=?, sstat='ok' WHERE job=? AND vid=?", r.views, r.likes, r.comments, mat, r.title, job.id, r.video_id);
          this.snapshot(r.video_id, mat, r.views, r.likes, r.comments);
        }
        // film nie wrócił (usunięty/prywatny): zostają stare statystyki z jawnym statusem
        for (const v of ids) if (!got.has(v)) sql.exec("UPDATE items SET sstat='unavailable', mat=? WHERE job=? AND vid=?", mat, job.id, v);
      });
    }
    const left = Number(sql.exec("SELECT COUNT(*) AS n FROM items WHERE job=? AND (mat IS NULL OR mat < ?)", job.id, since).one().n);
    if (left === 0) this.afterStatsRefresh(job);
  }

  private afterStatsRefresh(job: Job): void {
    const sql = this.ctx.storage.sql;
    if (job.refresh?.comments) sql.exec("UPDATE items SET cstat=NULL WHERE job=?", job.id); // stare komentarze zostają, dopóki nie przyjdą nowe
    job.refresh!.finishedAt = Date.now();
    job.phase = "transcribing"; // transkrypcje są gotowe: krok dokończy tylko komentarze (lub od razu zakończy)
  }

  // ------------------------------------------------------------------------ transkrypcje

  /** Zwraca zalecane opóźnienie do następnego alarmu (dłuższe, gdy czekamy tylko na zadania AI). */
  private async transcribeStep(s: Services, job: Job): Promise<number> {
    const sql = this.ctx.storage.sql;
    const perStep = num(this.env.STEP_ITEMS, 10);
    const itemDelay = num(this.env.SD_ITEM_DELAY_MS, 800);
    const rows = sql
      .exec("SELECT vid, url, status, sjob FROM items WHERE job=? AND status IN ('pending','pending_ai') ORDER BY ord LIMIT ?", job.id, perStep)
      .toArray();
    let aiWaiting = 0;
    try {
      for (const r of rows) {
        if (s.sub.count >= s.sub.max - 2) break;
        const vid = String(r.vid);
        try {
          if (String(r.status) === "pending_ai") {
            const raw = await sdPollJob(s, String(r.sjob));
            if (raw == null) {
              aiWaiting++;
              continue;
            }
            await this.finishOk(job.id, vid, raw);
            continue;
          }
          const res = await sdFetchRaw(s, String(r.url), job.lang, job.transcriptMode);
          if (res.state === "ok") await this.finishOk(job.id, vid, res.raw);
          else if (res.state === "unavailable") {
            sql.exec(
              "UPDATE items SET status='no_captions', err=? WHERE job=? AND vid=?",
              "Brak dostępnych napisów (HTTP 206)." + (job.transcriptMode === "native" ? " Spróbuj transcript_mode=auto." : ""),
              job.id, vid,
            );
          } else sql.exec("UPDATE items SET status='pending_ai', sjob=? WHERE job=? AND vid=?", res.jobId, job.id, vid);
          if (!("cached" in res && res.cached) && itemDelay > 0) await new Promise((x) => setTimeout(x, itemDelay)); // spokojne tempo
        } catch (e) {
          if (e instanceof SupadataError) {
            const credits = e.status === 402 || (e.status === 429 && /limit/i.test(`${e.code} ${e.message}`));
            if (credits) {
              // wyczerpane kredyty: ten i wszystkie dalsze filmy dostają jawny status; wznowienie ponowi tylko je
              sql.exec("UPDATE items SET status='no_credits', err=? WHERE job=? AND status='pending'", e.message, job.id);
              throw e;
            }
            if (!e.fatal) {
              const st = [400, 403, 404, 413].includes(e.status) ? "error_video" : "error_service";
              sql.exec("UPDATE items SET status=?, err=?, sjob=NULL WHERE job=? AND vid=?", st, e.message, job.id, vid);
              continue;
            }
          }
          throw e;
        }
      }
      // komentarze (YouTube API, 1 jednostka na film): osobny przebieg, więc przerwanie nie gubi już pobranych transkrypcji
      if (job.opts?.comments) {
        const crows = sql.exec("SELECT vid FROM items WHERE job=? AND cstat IS NULL ORDER BY ord LIMIT ?", job.id, perStep).toArray();
        for (const r of crows) {
          if (s.sub.count >= s.sub.max - 2) break;
          const vid = String(r.vid);
          const res = await fetchTopComments(s, vid, 5);
          if (res.state === "ok") sql.exec("UPDATE items SET cstat='ok', cmts=?, cfat=? WHERE job=? AND vid=?", JSON.stringify(res.items), Date.now(), job.id, vid);
          else if (res.state === "error") sql.exec("UPDATE items SET cstat='error', cfat=? WHERE job=? AND vid=?", Date.now(), job.id, vid);
          else sql.exec("UPDATE items SET cstat=?, cmts=NULL, cfat=? WHERE job=? AND vid=?", res.state, Date.now(), job.id, vid);
        }
      }
    } finally {
      // zakończenie zadania, gdy nic nie czeka (transkrypcje i, jeśli włączone, komentarze)
      let left = Number(sql.exec("SELECT COUNT(*) AS n FROM items WHERE job=? AND status IN ('pending','pending_ai')", job.id).one().n);
      if (job.opts?.comments) left += Number(sql.exec("SELECT COUNT(*) AS n FROM items WHERE job=? AND cstat IS NULL", job.id).one().n);
      if (left === 0) {
        job.phase = "done";
        job.running = false;
        job.completedAt = Date.now();
        job.stoppedReason = null;
      }
    }
    return aiWaiting > 0 && aiWaiting === rows.length ? 10_000 : 0;
  }

  private async finishOk(jobId: string, vid: string, raw: any): Promise<void> {
    const text = rawToText(raw);
    if (text.length > MAX_ROW_CHARS) {
      // nie obcinamy: oznaczamy jawnie (praktycznie niemożliwe dla Shortsów, które mają do 3 minut)
      throw new SupadataError(`Transkrypcja ma ${text.length} znaków i przekracza limit pojedynczego rekordu bazy (${MAX_ROW_CHARS}); nie zapisuję jej w skróconej postaci.`, 413);
    }
    const hash = await sha256Hex(text);
    const segs = rawToSegments(raw);
    // kontrola: segmenty złączone spacją muszą dać dokładnie zapisany tekst (inaczej nie zapisujemy czasów)
    const segsOk = segs.length > 0 && segs.map((x) => x[2]).join(" ") === text;
    // przyczyna braku czasów zapisana razem z rekordem (nie zgadujemy jej później)
    const sgst = segsOk ? "ok" : segs.length === 0 ? "no_segments_in_response" : "mismatch_not_stored";
    this.ctx.storage.sql.exec(
      "UPDATE items SET status=?, transcript=?, chars=?, hash=?, segs=?, sgst=?, err=NULL, sjob=NULL WHERE job=? AND vid=?",
      text.trim().length ? "ok" : "empty", text, text.length, hash, segsOk ? JSON.stringify(segs) : null, sgst, jobId, vid,
    );
  }

  // --------------------------------------------------------------------------- czytanie

  async read(jobId: string, cursor: string | null, maxChars: number): Promise<any> {
    const job = this.loadJob(jobId);
    const sql = this.ctx.storage.sql;
    const budget = Math.max(5000, Math.min(Math.floor(maxChars), 80000));
    const total = Number(sql.exec("SELECT COUNT(*) AS n FROM items WHERE job=?", jobId).one().n);
    let i = 0, off = 0;
    if (cursor) {
      const m = /^(\d+):(\d+)$/.exec(cursor);
      if (!m) throw new UserError("Nieprawidłowy cursor.");
      i = Number(m[1]);
      off = Number(m[2]);
    }
    const items: any[] = [];
    let used = 0;
    let next: string | null = null;
    while (i < total && next === null) {
      const r = sql.exec("SELECT vid, title, dur, pub, views, url, status, transcript, likes, ccount, crank, cmts, cstat, sgst, CASE WHEN segs IS NULL THEN 0 ELSE json_array_length(segs) END AS nsegs FROM items WHERE job=? AND ord=?", jobId, i).toArray()[0];
      const text: string | null = r.transcript == null ? null : String(r.transcript);
      const totalChars = text == null ? 0 : text.length;
      for (;;) {
        const entry: any = {
          video_id: String(r.vid), title: String(r.title), duration_seconds: Number(r.dur), transcript: null, published_at: String(r.pub), url: String(r.url),
          views: r.views == null ? null : Number(r.views),
          likes: r.likes == null ? null : Number(r.likes), comments_count: r.ccount == null ? null : Number(r.ccount),
          channel_views_rank: r.crank == null ? null : Number(r.crank),
          top_comments_relevance: off === 0 && r.cmts != null ? JSON.parse(String(r.cmts)) : null,
          comments_status: job.opts?.comments ? (r.cstat == null ? "not_fetched" : String(r.cstat)) : "not_requested",
          transcript_status: String(r.status) === "error" ? "error_service" : String(r.status), transcript_offset: off,
          // czasy zapisane w bazie: liczba segmentów (0 = brak) i przyczyna braku (patrz timedStatus)
          timed_segments: Number(r.nsegs ?? 0),
          timed_status: timedStatus(text != null, Number(r.nsegs ?? 0), r.sgst == null ? null : String(r.sgst)),
          transcript_chars_total: text == null ? null : totalChars, transcript_complete_in_this_item: true,
        };
        const room = budget - used - JSON.stringify(entry).length - 40;
        if (items.length && room < (text != null ? 300 : 0)) {
          next = `${i}:${off}`;
          break;
        }
        let chunk: string | null = null;
        if (text != null) {
          const allowed = Math.max(room, 300);
          chunk = text.slice(off, off + allowed);
          while (JSON.stringify(chunk).length > allowed + 2 && chunk.length > 300) chunk = chunk.slice(0, Math.max(300, Math.floor(chunk.length * 0.9)));
          // nie rozcinaj pary zastępczej UTF-16
          if (chunk.length && off + chunk.length < totalChars) {
            const last = chunk.charCodeAt(chunk.length - 1);
            if (last >= 0xd800 && last <= 0xdbff) chunk = chunk.slice(0, -1);
          }
          entry.transcript = chunk;
          entry.transcript_complete_in_this_item = off + chunk.length >= totalChars;
        }
        items.push(entry);
        used += JSON.stringify(entry).length;
        if (text != null && off + (chunk as string).length < totalChars) {
          off += (chunk as string).length;
          continue;
        }
        break;
      }
      if (next === null) {
        i++;
        off = 0;
      }
    }
    return {
      job_id: jobId,
      complete: job.phase === "done",
      total_records: total,
      items,
      next_cursor: next,
      note: "Kolejne kawałki tej samej transkrypcji sklej wg transcript_offset. Brak transcript = brak danych (zobacz transcript_status).",
    };
  }

  // -------------------------------------------------------------------------- pojedynczy film

  async singleTranscript(p: { ref: string; lang: string | null; mode: TMode; offset: number; limit: number; jobId: string | null }): Promise<any> {
    const s = this.svc();
    const m = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/.exec(p.ref) ?? (/^[A-Za-z0-9_-]{11}$/.test(p.ref.trim()) ? [p.ref, p.ref.trim()] : null);
    if (!m) throw new UserError("Podaj link do filmu YouTube lub 11-znakowe ID.");
    const url = `https://www.youtube.com/watch?v=${m[1]}`;
    let raw: any;
    if (p.jobId) {
      raw = await sdPollJob(s, p.jobId);
      if (raw == null) return { ok: false, pending: true, job_id: p.jobId, note: "Nadal w trakcie. Spróbuj ponownie za chwilę." };
    } else {
      const res = await sdFetchRaw(s, url, p.lang, p.mode);
      if (res.state === "unavailable") return { ok: false, status: "no_captions", video: m[1], error: 'Brak dostępnej transkrypcji (HTTP 206). Spróbuj mode="auto".' };
      if (res.state === "pending") return { ok: false, pending: true, job_id: res.jobId, note: "Transkrypcja jest generowana. Wywołaj ponownie z job_id." };
      raw = res.raw;
    }
    const text = rawToText(raw);
    const off = Math.max(0, p.offset), lim = Math.max(1000, Math.min(p.limit, 60000));
    const chunk = text.slice(off, off + lim);
    return {
      ok: true, video: m[1], url, lang: raw?.lang ?? null, transcript: chunk, transcript_offset: off, transcript_chars_total: text.length,
      transcript_complete_in_this_item: off + chunk.length >= text.length,
      next_offset: off + chunk.length < text.length ? off + chunk.length : null,
    };
  }

  async resolve(ref: string): Promise<any> {
    return await resolveChannel(this.svc(), ref);
  }

  async usage(): Promise<any> {
    const s = this.svc();
    return {
      youtube_units_today: budgetUsed(s, "yt_units", "America/Los_Angeles"),
      youtube_units_safety_limit: ytLimit(s),
      supadata_credits_today: budgetUsed(s, "sd_credits", "UTC"),
      supadata_credits_safety_limit: sdLimit(s),
      gemini_calls_today: budgetUsed(s, "gemini_calls", "UTC"),
      gemini_calls_safety_limit: this.visCfg().dailyCalls,
      gemini_tokens_today: budgetUsed(s, "gemini_tokens", "UTC"),
      gemini_queue: await this.visQueueState(),
      note: "Liczone przez ten serwer (YouTube: doba czasu pacyficznego, Supadata: UTC). Dokładne wartości sprawdź w panelach usług.",
    };
  }

  // ------------------------------------------------------------------------------- eksport

  /** Zestaw eksportu z jednego lub wielu zadań (filtry, sortowanie, CSV/JSON/Markdown). */
  async startSet(spec: SetSpec): Promise<any> {
    const r = this.sets().create(spec);
    await this.scheduleAlarm(0);
    return r;
  }

  async setInfo(setId: string): Promise<any> {
    return this.sets().info(setId);
  }

  /** Zgodność wstecz: eksport jednego zadania (sort: selection | views_desc | views_asc). */
  async startExport(jobId: string, allowPartial: boolean, sort: "selection" | "views_desc" | "views_asc" = "selection"): Promise<any> {
    if (!["selection", "views_desc", "views_asc"].includes(sort)) throw new UserError("sort: selection, views_desc albo views_asc.");
    const r = this.sets().create({
      jobIds: [jobId], allowPartial, sortBy: sort === "selection" ? "selection" : "views", sortDir: sort === "views_desc" ? "desc" : "asc",
      filters: {}, mdPartChars: null,
    });
    await this.scheduleAlarm(0);
    return r;
  }

  async exportInfo(id: string): Promise<{ phase: string; partial: boolean; files: any; error: string | null; set_id: string } | null> {
    const setId = this.resolveSetId(id);
    if (!setId) return null;
    const i = this.sets().info(setId);
    if (!i) return null;
    return { phase: i.phase, partial: i.partial, files: i.files ?? null, error: i.error ?? null, set_id: setId };
  }

  /** Zwraca fragmenty pliku eksportu w kolejności (do strumieniowania w Workerze). */
  async exportChunks(id: string, fmt: string): Promise<string[] | null> {
    if (id.startsWith("v-")) return this.visChunks(id, fmt);
    const setId = this.resolveSetId(id);
    if (!setId) return null;
    return this.sets().chunks(setId, fmt);
  }

  private resolveSetId(id: string): string | null {
    if (id.startsWith("s-")) return id;
    try {
      return this.loadJob(id).export?.setId ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ rozpoznawanie zdjęć (Gemini)

  private loadVis(id: string): VisRecord | null {
    const r = this.ctx.storage.sql.exec("SELECT state FROM vis WHERE id=?", id).toArray()[0];
    return r ? (JSON.parse(String(r.state)) as VisRecord) : null;
  }
  private saveVis(v: VisRecord): void {
    const p = v.parsed;
    this.ctx.storage.sql.exec(
      `INSERT INTO vis(id, vid, fps, status, state, created, updated, batch, attempt, next_at, secs, http, tokens, nimg, nmsg, err, started, ended)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, state=excluded.state, updated=excluded.updated, batch=excluded.batch, attempt=excluded.attempt,
         next_at=excluded.next_at, secs=excluded.secs, http=excluded.http, tokens=excluded.tokens, nimg=excluded.nimg, nmsg=excluded.nmsg, err=excluded.err,
         started=excluded.started, ended=excluded.ended`,
      v.id, v.video_id, v.fps, v.status, JSON.stringify(v), v.created, Date.now(),
      v.batch_id ?? null, v.attempt ?? 1, v.next_at ?? 0, v.seconds, v.http_status, v.usage?.totalTokenCount ?? null,
      v.status === "ok" ? (p?.images?.length ?? 0) : null, v.status === "ok" ? (p?.messages?.length ?? 0) : null,
      v.error ? String(v.error).slice(0, 4000) : null, v.started_at ?? null, v.done_at,
    );
  }

  // konfiguracja kolejki (wszystko z wartościami zachowawczymi; limity Google nie są zgadywane)
  private visCfg() {
    const delays = String(this.env.GEMINI_RETRY_DELAYS_S ?? "30,120,300").split(",").map((x) => Number(x) * 1000).filter((x) => Number.isFinite(x) && x >= 0);
    return {
      concurrency: Math.max(1, Math.min(4, Math.floor(num(this.env.GEMINI_CONCURRENCY, 2)))),
      minStartGapMs: Math.max(0, num(this.env.GEMINI_MIN_START_INTERVAL_MS, 10_000)),
      tpm: Math.max(0, num(this.env.GEMINI_TPM_LIMIT, 0)),
      maxAttempts: Math.max(1, Math.floor(num(this.env.GEMINI_MAX_ATTEMPTS, 4))),
      delays: delays.length ? delays : [30_000, 120_000, 300_000],
      dailyCalls: num(this.env.GEMINI_DAILY_CALLS, 250),
      limits: this.modelLimits(),
      cancel: String(this.env.GEMINI_CANCEL_BATCHES ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    };
  }
  private vis = { starts: [] as number[], tokens: [] as { t: number; n: number }[] };

  /** Limity modeli z AI Studio (Rate limit, Twój projekt) podane w zmiennej GEMINI_MODEL_LIMITS: {"model":{"rpm":..,"tpm":..,"rpd":..}}. Brak wpisu = brak własnego limitu dla modelu. */
  private modelLimits(): Record<string, { rpm: number; tpm: number; rpd: number }> {
    try {
      const j = JSON.parse(String(this.env.GEMINI_MODEL_LIMITS ?? "{}"));
      const out: Record<string, { rpm: number; tpm: number; rpd: number }> = {};
      for (const [k, v] of Object.entries<any>(j)) out[k] = { rpm: Number(v?.rpm) || 0, tpm: Number(v?.tpm) || 0, rpd: Number(v?.rpd) || 0 };
      return out;
    } catch {
      return {};
    }
  }

  private kvGet(k: string): string | null {
    const r = this.ctx.storage.sql.exec("SELECT v FROM vis_state WHERE k=?", k).toArray()[0];
    return r ? String(r.v) : null;
  }
  private kvSet(k: string, v: string): void {
    this.ctx.storage.sql.exec("INSERT INTO vis_state(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v);
  }
  private getPause(model: string): { until: number; since: number; cause: string; rec_id: string; error: string } | null {
    const v = this.kvGet("pause:" + model);
    return v ? JSON.parse(v) : null;
  }

  /**
   * Co blokuje start próby dla modelu teraz (null = nic). Jedno źródło prawdy dla pętli roboczej, alarmu i raportów:
   * zaplanowane ponowienie, pauza po 429 (z treści błędu), RPM / TPM / RPD modelu liczone także dla ponowień.
   */
  private visBlock(model: string, nextAt: number, now: number): { until: number; kind: string; reason: string } | null {
    const iso = (t: number) => new Date(t).toISOString();
    const pz = this.getPause(model);
    if (pz && pz.until > now) return { until: Math.max(pz.until, nextAt), kind: "pauza_429", reason: `pauza modelu po HTTP 429 (${pz.cause}); następna próba nie wcześniej niż ${iso(Math.max(pz.until, nextAt))}` };
    if (nextAt > now) return { until: nextAt, kind: "ponowienie", reason: `zaplanowane ponowienie po błędzie poprzedniej próby; nie wcześniej niż ${iso(nextAt)}` };
    const lim = this.visCfg().limits[model];
    if (!lim) return null;
    const sql = this.ctx.storage.sql;
    if (lim.rpm > 0) {
      const rows = sql.exec("SELECT started FROM vis WHERE started > ? AND json_extract(state,'$.model_requested') = ? ORDER BY started ASC", now - 60_000, model).toArray();
      if (rows.length >= lim.rpm) {
        const until = Number(rows[rows.length - lim.rpm].started) + 60_000 + 500;
        return { until, kind: "rpm", reason: `limit RPM modelu (${rows.length} prób w ostatnich 60 s, limit ${lim.rpm}; liczone z ponowieniami); następna próba nie wcześniej niż ${iso(until)}` };
      }
    }
    if (lim.tpm > 0) {
      const rows = sql.exec("SELECT ended, tokens FROM vis WHERE ended > ? AND tokens IS NOT NULL AND json_extract(state,'$.model_requested') = ? ORDER BY ended ASC", now - 60_000, model).toArray();
      const used = rows.reduce((a, r) => a + Number(r.tokens), 0);
      const est = 20_000;
      if (rows.length && used + est > lim.tpm) {
        const until = Number(rows[0].ended) + 60_000 + 500;
        return { until, kind: "tpm", reason: `limit TPM modelu (${used} tokenów w ostatnich 60 s + ok. ${est} na kolejne wywołanie > ${lim.tpm}); następna próba nie wcześniej niż ${iso(until)}` };
      }
    }
    if (lim.rpd > 0) {
      const used = budgetUsed(this.svc(), `gemini_calls:${model}`, "America/Los_Angeles");
      if (used >= lim.rpd) {
        const until = nextPacificMidnight(now);
        return { until, kind: "rpd_wlasny", reason: `własny licznik dobowy modelu: ${used} z ${lim.rpd} (doba pacyficzna, jak w Google; liczy też ponowienia). To nasz licznik, nie komunikat Google; następna próba po ${iso(until)}` };
      }
    }
    return null;
  }

  /** Anuluje oczekujące przebiegi podanych partii (trwających wywołań nie przerywa). */
  private visCancel(batchIds: string[], why: string): number {
    let n = 0;
    for (const b of batchIds) {
      for (const r of this.ctx.storage.sql.exec("SELECT id FROM vis WHERE batch=? AND status='pending'", b).toArray()) {
        const rec = this.loadVis(String(r.id))!;
        rec.status = "cancelled";
        rec.error = why;
        rec.done_at = Date.now();
        this.saveVis(rec);
        n++;
      }
    }
    return n;
  }

  private newVisRecord(vid: string, fps: number, model: string, batch: string, attempt: number, maxAttempts: number, retryOf: string | null, nextAt: number): VisRecord {
    return {
      id: "v-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24), video_id: vid, video_url: `https://www.youtube.com/watch?v=${vid}`, fps,
      model_requested: model, status: "pending", http_status: null, seconds: null, model_version: null, finish_reason: null, usage: null,
      raw: null, parsed: null, parse_error: null, error: null,
      params: { endpoint: "generateContent", fps, responseMimeType: "application/json", source: "public YouTube URL (fileData.fileUri)" },
      created: Date.now(), done_at: null, batch_id: batch, attempt, max_attempts: maxAttempts, next_at: nextAt, started_at: null, retry_of: retryOf, retry_scheduled: null, retry_after_ms: null,
    };
  }

  /**
   * Zleca rolki do kolejki Gemini (jedna lub wiele; po jednym przebiegu na rolkę i fps). Praca idzie w tle (alarm):
   * ograniczona równoległość, odstępy między startami, automatyczne ponawianie błędów przejściowych (każda próba liczy się do limitu dziennego).
   * retryBatch: ponawia tylko rolki z tej partii, które nie mają udanego wyniku.
   */
  async startVision(p: { video?: string; videos?: string[]; fps: number[]; model: string | null; retryBatch?: string | null; cancelBatch?: string | null }): Promise<any> {
    if (!this.env.GEMINI_API_KEY) {
      throw new UserError("Rozpoznawanie zdjęć jest wyłączone: brak sekretu GEMINI_API_KEY w Cloudflare (Workers & Pages → yt-mcp → Settings → Variables and Secrets).");
    }
    const cfg = this.visCfg();
    this.prune();
    const sql = this.ctx.storage.sql;
    if (p.cancelBatch) {
      const n = this.visCancel(p.cancelBatch.split(",").map((x) => x.trim()).filter(Boolean), "Anulowane na polecenie użytkownika (cancel_batch).");
      return { cancelled_pending_runs: n, note: "Trwające wywołania (status w toku) kończą się normalnie; oczekujące zostały anulowane i nie wznowią się." };
    }
    if (p.retryBatch) {
      const batch = p.retryBatch;
      const rows = sql.exec("SELECT id, vid, fps, status, attempt FROM vis WHERE batch=? ORDER BY created ASC", batch).toArray();
      if (!rows.length) throw new UserError("Nie znam takiej partii (batch_id).");
      const last = new Map<string, any>();
      for (const r of rows) last.set(`${r.vid}|${r.fps}`, r);
      const queued: string[] = [];
      for (const r of last.values()) {
        if (r.status === "ok" || r.status === "pending" || r.status === "running") continue;
        const prev = this.loadVis(String(r.id))!;
        const attempt = (prev.attempt ?? 1) + 1;
        const rec = this.newVisRecord(prev.video_id, prev.fps, prev.model_requested, batch, attempt, attempt + cfg.maxAttempts - 1, prev.id, 0);
        this.saveVis(rec);
        queued.push(prev.video_id);
      }
      await this.scheduleAlarm(0);
      return { batch_id: batch, requeued_only_failed: queued.length, videos: queued, next_step: "get_image_analysis z batch_id." };
    }
    const refs = [...(p.videos ?? []), ...(p.video ? [p.video] : [])];
    if (!refs.length) throw new UserError("Podaj video albo videos.");
    if (refs.length > 200) throw new UserError("Najwyżej 200 rolek w jednej partii.");
    const vids = [...new Set(refs.map((r) => videoIdFrom(r)))];
    const fpsList = [...new Set(p.fps)];
    if (!fpsList.length || fpsList.length > 4) throw new UserError("fps: od 1 do 4 wartości.");
    for (const f of fpsList) if (!Number.isFinite(f) || f <= 0 || f > 60) throw new UserError("fps: liczba > 0 i <= 60 (rzeczywisty limit sprawdzi API).");
    const model = p.model || this.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
    if (!/^[a-z0-9.\-]+$/i.test(model)) throw new UserError("Nieprawidłowa nazwa modelu.");
    const batch = "b-" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const runs: { id: string; video_id: string; fps: number; status: string }[] = [];
    for (const vid of vids) {
      for (const f of fpsList) {
        const rec = this.newVisRecord(vid, f, model, batch, 1, cfg.maxAttempts, null, 0);
        this.saveVis(rec);
        runs.push({ id: rec.id, video_id: vid, fps: f, status: "pending" });
      }
    }
    await this.scheduleAlarm(0);
    return {
      batch_id: batch, video_id: vids.length === 1 ? vids[0] : undefined, model, videos: vids.length, queued_runs: runs.length, runs,
      concurrency: cfg.concurrency, daily_call_limit: cfg.dailyCalls, max_attempts: cfg.maxAttempts,
      next_step: "Wywołaj get_image_analysis (z video albo batch_id) za 30–120 s.",
    };
  }

  /** Najkrótszy czas (ms) do kolejnego zaległego przebiegu; null, gdy nic nie czeka; 0, gdy coś jest gotowe do startu. */
  visionWaitMs(): number | null {
    const rows = this.ctx.storage.sql.exec("SELECT next_at, json_extract(state,'$.model_requested') AS model FROM vis WHERE status='pending' ORDER BY created ASC LIMIT 200").toArray();
    if (!rows.length) return null;
    const now = Date.now();
    let best = Infinity;
    for (const r of rows) {
      const b = this.visBlock(String(r.model ?? GEMINI_DEFAULT_MODEL), Number(r.next_at ?? 0), now);
      best = Math.min(best, b ? b.until - now : 0);
    }
    return Math.max(0, best);
  }

  /** Przebiegi „w toku”, których wykonanie przerwał restart: oznaczamy je błędem przejściowym (i planujemy ponowienie). */
  private visRecoverStale(): void {
    const rows = this.ctx.storage.sql.exec("SELECT id FROM vis WHERE status='running' AND started < ?", Date.now() - 6 * 60_000).toArray();
    for (const r of rows) {
      const rec = this.loadVis(String(r.id))!;
      rec.status = "error";
      rec.error = "Przebieg przerwany (restart serwera przed zakończeniem odpowiedzi); wywołanie mogło zostać policzone przez Google.";
      rec.done_at = Date.now();
      this.visFinish(rec);
    }
  }

  /** Zapis wyniku próby; błąd przejściowy → nowa próba z odstępem (osobny rekord), o ile nie przekroczono max_attempts. */
  private visFinish(rec: VisRecord): void {
    const cfg = this.visCfg();
    if (rec.status === "ok" && rec.usage?.totalTokenCount) {
      addUsed(this.svc(), "gemini_tokens", "UTC", Number(rec.usage.totalTokenCount));
      this.vis.tokens.push({ t: Date.now(), n: Number(rec.usage.totalTokenCount) });
    }
    let pauseWait = 0;
    if (rec.http_status === 429) {
      // pauza tylko dla tego modelu; przyczynę i termin zapisujemy trwale (przeżywa wdrożenie), „dobowy” tylko gdy wynika to z treści błędu Google
      const now = Date.now();
      const q = rec.quota;
      let until: number;
      let cause: string;
      if (q?.scope === "day") {
        until = Math.max(nextPacificMidnight(now) + 60_000, now + (rec.retry_after_ms ?? 0));
        cause = `treść błędu wskazuje limit dobowy: ${q.ids.join(", ")}`;
      } else {
        const ra = rec.retry_after_ms;
        until = now + (ra ?? 65_000);
        cause = q ? `limit z treści błędu: ${q.ids.join(", ")} (zakres: ${q.scope})` : "treść błędu nie wskazuje, który limit przekroczono — to nie jest potwierdzenie wyczerpania limitu dziennego";
        cause += ra == null ? "; brak wskazówki Retry-After, przyjęto 65 s" : `; wskazówka Google: ${Math.round(ra / 1000)} s`;
      }
      const old = this.getPause(rec.model_requested);
      if (!old || old.until < until) this.kvSet("pause:" + rec.model_requested, JSON.stringify({ until, since: now, cause, rec_id: rec.id, error: String(rec.error ?? "").slice(0, 4000) }));
      pauseWait = until - now;
    }
    const attempt = rec.attempt ?? 1;
    const maxA = rec.max_attempts ?? cfg.maxAttempts;
    if (isRetryable(rec) && attempt < maxA && rec.batch_id) {
      const wait = Math.max(cfg.delays[Math.min(attempt - 1, cfg.delays.length - 1)], rec.retry_after_ms ?? 0, pauseWait);
      const next = this.newVisRecord(rec.video_id, rec.fps, rec.model_requested, rec.batch_id, attempt + 1, maxA, rec.id, Date.now() + wait);
      rec.retry_scheduled = next.id;
      this.saveVis(next);
    }
    this.saveVis(rec);
  }

  /**
   * Kolejka: do `concurrency` wywołań naraz (okno przesuwne), odstęp między startami, opcjonalny limit tokenów/min,
   * wstrzymanie po 429. Jedno wywołanie alarmu robi najwyżej 40 wywołań (limit subżądań planu Free).
   */
  private async visionStepAny(): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    this.visRecoverStale();
    const toCancel = this.visCfg().cancel;
    if (toCancel.length) this.visCancel(toCancel, "Anulowane: partia wymieniona w GEMINI_CANCEL_BATCHES (zatrzymana przed wznowieniem).");
    if (!sql.exec("SELECT 1 FROM vis WHERE status='pending' LIMIT 1").toArray().length) return false;
    const key = this.env.GEMINI_API_KEY;
    if (!key) {
      for (const r of sql.exec("SELECT id FROM vis WHERE status='pending'").toArray()) {
        const rec = this.loadVis(String(r.id))!;
        rec.status = "not_configured";
        rec.error = "Brak sekretu GEMINI_API_KEY: obraz nie został przeanalizowany.";
        rec.done_at = Date.now();
        this.saveVis(rec);
      }
      return true;
    }
    const cfg = this.visCfg();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let launched = 0;
    const MAX_CALLS = 40;
    const t0 = Date.now();
    this.kvSet("last_alarm", String(t0));
    const worker = async () => {
      for (;;) {
        // alarm może trwać najwyżej 15 min; pojedyncze wywołanie ma limit 5 min, więc nowych nie zaczynamy po 8 min
        if (launched >= MAX_CALLS || Date.now() - t0 > 8 * 60_000) return;
        const now = Date.now();
        const cands = sql.exec("SELECT id, next_at, json_extract(state,'$.model_requested') AS model FROM vis WHERE status='pending' ORDER BY created ASC LIMIT 100").toArray();
        if (!cands.length) return;
        let row: any = null;
        let soonest = Infinity;
        for (const c of cands) {
          const b = this.visBlock(String(c.model ?? GEMINI_DEFAULT_MODEL), Number(c.next_at ?? 0), now);
          if (!b) { row = c; break; }
          soonest = Math.min(soonest, b.until);
        }
        if (!row) {
          const w = soonest - now;
          if (w > 20_000) return; // alarm obudzi nas najpóźniej po 30 s (patrz ogon alarmu); przyczyna jest w raporcie (blokady)
          await sleep(Math.max(250, Math.min(w, 5_000)));
          continue;
        }
        // tempo: odstęp od ostatniego startu
        const sinceLast = now - (this.vis.starts[this.vis.starts.length - 1] ?? 0);
        if (sinceLast < cfg.minStartGapMs) {
          await sleep(cfg.minStartGapMs - sinceLast);
          continue;
        }
        const rec = this.loadVis(String(row.id))!;
        // zajmujemy rekord synchronicznie (przed jakimkolwiek await), więc inny worker go nie weźmie
        rec.status = "running";
        rec.started_at = Date.now();
        this.saveVis(rec);
        try {
          reserve(this.svc(), "gemini_calls", "UTC", cfg.dailyCalls, 1, "wywołania Gemini");
          reserve(this.svc(), `gemini_calls:${rec.model_requested}`, "America/Los_Angeles", 0, 1, "wywołania Gemini modelu"); // sam licznik (limit sprawdza visBlock)
        } catch (e) {
          rec.status = "error";
          rec.error = e instanceof PauseError || e instanceof UserError ? e.message : `Wewnętrzny błąd (${(e as Error)?.name})`;
          rec.done_at = Date.now();
          this.saveVis(rec); // bez ponowienia: limit dzienny; po północy UTC użyj retry_batch
          continue;
        }
        launched++;
        this.vis.starts.push(Date.now());
        this.vis.starts = this.vis.starts.slice(-50);
        try {
          await runGemini(rec, key, (u, i) => fetch(u, i));
        } catch (e) {
          rec.status = "error";
          rec.error = e instanceof UserError ? e.message : `Wewnętrzny błąd (${(e as Error)?.name})`;
          rec.done_at = Date.now();
        }
        this.visFinish(rec);
      }
    };
    await Promise.all(Array.from({ length: cfg.concurrency }, () => worker()));
    return launched > 0;
  }

  /** Dlaczego kolejka stoi (albo że nie stoi): blokady z visBlock, pauzy po 429 z treścią błędu, ostatni alarm. Bez tajnych wartości. */
  async visQueueState(): Promise<any> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const pending = sql.exec("SELECT id, batch, next_at, json_extract(state,'$.model_requested') AS model FROM vis WHERE status='pending'").toArray();
    const running = Number(sql.exec("SELECT COUNT(*) AS n FROM vis WHERE status='running'").toArray()[0]?.n ?? 0);
    const blocks = new Map<string, any>();
    let ready = 0;
    for (const r of pending) {
      const model = String(r.model ?? GEMINI_DEFAULT_MODEL);
      const b = this.visBlock(model, Number(r.next_at ?? 0), now);
      if (!b) { ready++; continue; }
      const key = `${model}|${b.kind}`;
      const cur = blocks.get(key);
      if (!cur) blocks.set(key, { model, kind: b.kind, runs: 1, reason: b.reason, next_attempt_not_before: new Date(b.until).toISOString() });
      else { cur.runs++; if (new Date(b.until).toISOString() < cur.next_attempt_not_before) { cur.next_attempt_not_before = new Date(b.until).toISOString(); cur.reason = b.reason; } }
    }
    const pauses: any[] = [];
    for (const r of sql.exec("SELECT k, v FROM vis_state WHERE k LIKE 'pause:%'").toArray()) {
      const v = JSON.parse(String(r.v));
      pauses.push({ model: String(r.k).slice(6), active: v.until > now, since: new Date(v.since).toISOString(), until: new Date(v.until).toISOString(), cause: v.cause, error_body_429: v.error });
    }
    const alarm = await this.ctx.storage.getAlarm();
    const last = this.kvGet("last_alarm");
    const cfg = this.visCfg();
    let explanation: string;
    if (!pending.length && !running) explanation = "Kolejka pusta.";
    else if (running) explanation = `W toku: ${running} wywołań (max równolegle ${cfg.concurrency}); oczekujących ${pending.length}.`;
    else if (ready) explanation = `${ready} przebiegów gotowych do startu; start ogranicza odstęp ${cfg.minStartGapMs / 1000} s między wywołaniami i alarm (następny: ${alarm ? new Date(alarm).toISOString() : "BRAK ZAPLANOWANEGO ALARMU"}).`;
    else explanation = "Wszystkie oczekujące przebiegi mają znaną blokadę (patrz blocks).";
    if ((pending.length || running) && !alarm && !running) explanation += " UWAGA: brak zaplanowanego alarmu przy oczekujących przebiegach — kolejka nie ruszy sama (zgłoś błąd).";
    return {
      now: new Date(now).toISOString(), pending: pending.length, running, ready_to_start: ready, explanation, blocks: [...blocks.values()], pauses_after_429: pauses,
      next_alarm_at: alarm ? new Date(alarm).toISOString() : null, last_alarm_started_at: last ? new Date(Number(last)).toISOString() : null,
      model_limits_configured: cfg.limits,
    };
  }

  /** Każdy odrębny błąd partii raz, w pełnej treści (bez klucza), z liczbą wystąpień i wskazaniem przekroczonego limitu. */
  private visDistinctErrors(batchId: string): any[] {
    const out = new Map<string, any>();
    for (const r of this.ctx.storage.sql.exec("SELECT id FROM vis WHERE batch=? AND status NOT IN ('ok','pending','running','cancelled') ORDER BY created ASC", batchId).toArray()) {
      const rec = this.loadVis(String(r.id))!;
      const key = `${rec.http_status ?? "-"}|${rec.quota?.ids.join(",") ?? String(rec.error ?? "").replace(/\d+(\.\d+)?/g, "#").slice(0, 160)}`;
      const cur = out.get(key);
      if (cur) cur.count++;
      else out.set(key, { http: rec.http_status, count: 1, first_run_id: rec.id, quota: rec.quota ?? null, retry_after_s: rec.retry_after_ms != null ? Math.round(rec.retry_after_ms / 1000) : null, full_error: String(rec.error ?? "").slice(0, 4000) });
    }
    return [...out.values()];
  }

  private visRunSummary(r: VisRecord) {
    return {
      id: r.id, fps: r.fps, status: r.status, attempt: r.attempt ?? 1, model_requested: r.model_requested, model_version: r.model_version, http_status: r.http_status,
      seconds: r.seconds, finish_reason: r.finish_reason, error: r.error, usage: r.usage,
      image_status: r.status !== "ok" ? "nie przeanalizowano obrazu" : r.parsed.images.length ? "wykryto zdjęcia" : "nie wykryto zdjęć",
      images: r.status === "ok" ? r.parsed.images : null,
      messages_count: r.status === "ok" ? r.parsed.messages.length : null,
      unclear_ranges: r.status === "ok" ? r.parsed.unclear_ranges ?? [] : null,
    };
  }

  /** Wyniki dla rolki: ostatni przebieg dla każdego fps (z historią prób), porównanie skrajnych fps, linki do surowej odpowiedzi i opisu. */
  async visionStatus(video: string): Promise<any> {
    const vid = videoIdFrom(video);
    const rows = this.ctx.storage.sql.exec("SELECT id FROM vis WHERE vid=? ORDER BY created DESC", vid).toArray();
    const latest = new Map<number, VisRecord>();
    const history = new Map<number, any[]>();
    for (const r of rows) {
      const v = this.loadVis(String(r.id))!;
      if (!latest.has(v.fps)) latest.set(v.fps, v);
      const h = history.get(v.fps) ?? [];
      h.unshift({ id: v.id, attempt: v.attempt ?? 1, status: v.status, http_status: v.http_status, seconds: v.seconds });
      history.set(v.fps, h);
    }
    // wynik udany ma pierwszeństwo przed późniejszą nieudaną próbą (np. ręczne ponowienie po sukcesie nie ukrywa wyniku)
    const runs = [...latest.values()].sort((a, b) => a.fps - b.fps);
    const ok = runs.filter((r) => r.status === "ok");
    return {
      video_id: vid,
      runs: runs.map((r) => ({ ...this.visRunSummary(r), attempts: history.get(r.fps) })),
      comparison: ok.length >= 2 ? { a_fps: ok[0].fps, b_fps: ok[ok.length - 1].fps, ...compareRuns(ok[0].parsed, ok[ok.length - 1].parsed) } : null,
      pending: runs.some((r) => r.status === "pending" || r.status === "running"),
      images_exported: false,
      note: "Gemini zwraca tylko tekst (czasy, opisy, odczytane wiadomości). Plików obrazów z linku YouTube nie da się uzyskać; obrazy tylko z lokalnego MP4. Czasy w opisach są przybliżone.",
    };
  }

  /** Tabela partii: jedna pozycja na rolkę (i fps) z liczbą prób, czasem i zużyciem; bez wczytywania pełnych odpowiedzi. */
  async visionBatch(batchId: string): Promise<any> {
    const rows = this.ctx.storage.sql
      .exec("SELECT id, vid, fps, status, attempt, secs, http, tokens, nimg, nmsg, err, started, ended, created, next_at, json_extract(state,'$.model_requested') AS model FROM vis WHERE batch=? ORDER BY created ASC", batchId)
      .toArray();
    if (!rows.length) throw new UserError("Nie znam takiej partii (batch_id).");
    const by = new Map<string, any[]>();
    for (const r of rows) {
      const k = `${r.vid}|${r.fps}`;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    const table = [...by.values()].map((att) => {
      const lastRow = att[att.length - 1];
      const okRow = att.find((a) => a.status === "ok");
      const fin = okRow ?? lastRow;
      const apiSeconds = att.reduce((a, x) => a + (Number(x.secs) || 0), 0);
      const waiting = !okRow && (lastRow.status === "pending" || lastRow.status === "running");
      const cancelled = !okRow && lastRow.status === "cancelled";
      let waitingReason: string | null = null;
      let notBefore: string | null = null;
      if (waiting && lastRow.status === "pending") {
        const b = this.visBlock(String(lastRow.model ?? GEMINI_DEFAULT_MODEL), Number(lastRow.next_at ?? 0), Date.now());
        if (b) { waitingReason = b.reason; notBefore = new Date(b.until).toISOString(); }
        else waitingReason = `gotowe do startu (kolejność, odstęp ${this.visCfg().minStartGapMs / 1000} s między startami, max ${this.visCfg().concurrency} równolegle)`;
      }
      const failed = att.filter((a) => a.status !== "ok" && a.status !== "pending" && a.status !== "running" && a.status !== "cancelled");
      return {
        video_id: String(lastRow.vid), fps: Number(lastRow.fps),
        status: okRow ? "ok" : cancelled ? "anulowane" : waiting ? (lastRow.status === "running" ? "w toku" : "czeka (kolejka/ponowienie)") : `błąd: ${String(lastRow.err ?? lastRow.status).slice(0, 120)}`,
        model: String(lastRow.model ?? ""),
        waiting_reason: waitingReason,
        next_attempt_not_before: notBefore,
        attempt_errors: failed.map((a) => ({ attempt: Number(a.attempt), http: a.http ?? null, error: String(a.err ?? "").slice(0, 400) })),
        attempts: att.length,
        attempt_log: att.map((a) => `${a.attempt}: ${a.status}${a.http != null ? ` HTTP ${a.http}` : ""}${a.secs != null ? ` ${a.secs}s` : ""}`),
        attempt_times: att.map((a) => ({ attempt: Number(a.attempt), started_at: a.started ? new Date(Number(a.started)).toISOString() : null, ended_at: a.ended ? new Date(Number(a.ended)).toISOString() : null })),
        source: "nowy pomiar (wywołanie z tej partii)",
        api_seconds_ok_attempt: okRow ? Number(okRow.secs) : null,
        api_seconds_all_attempts: Math.round(apiSeconds * 10) / 10,
        tokens: fin.tokens != null ? Number(fin.tokens) : null,
        images_found: okRow ? Number(okRow.nimg) : null,
        messages_read: okRow ? Number(okRow.nmsg) : null,
        run_id: okRow ? String(okRow.id) : String(lastRow.id),
      };
    });
    const started = Math.min(...rows.map((r) => Number(r.created)));
    const done = table.every((t) => t.status === "ok" || t.status === "anulowane" || t.status.startsWith("błąd"));
    const ended = done ? Math.max(...rows.map((r) => Number(r.ended ?? 0))) : null;
    const counts = { ok: 0, pending: 0, failed: 0, cancelled: 0 };
    for (const t of table) t.status === "ok" ? counts.ok++ : t.status === "anulowane" ? counts.cancelled++ : t.status.startsWith("błąd") ? counts.failed++ : counts.pending++;
    const attemptsTotal = rows.length;
    // największa liczba wywołań trwających jednocześnie (z czasów startu i końca każdej próby)
    const ev: [number, number][] = [];
    for (const r of rows) if (r.started && r.ended) { ev.push([Number(r.started), 1], [Number(r.ended), -1]); }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, maxParallel = 0;
    for (const [, d] of ev) { cur += d; maxParallel = Math.max(maxParallel, cur); }
    const okTimes = table.filter((t) => t.api_seconds_ok_attempt != null).map((t) => t.api_seconds_ok_attempt as number);
    const cfg = this.visCfg();
    return {
      batch_id: batchId,
      counts, runs_total: table.length, attempts_total: attemptsTotal, max_parallel_calls_observed: maxParallel,
      started_at: new Date(started).toISOString(), finished_at: ended ? new Date(ended).toISOString() : null,
      wall_seconds: Math.round(((ended ?? Date.now()) - started) / 100) / 10,
      ok_call_seconds: okTimes.length ? { min: Math.min(...okTimes), mean: Math.round((okTimes.reduce((a, b) => a + b, 0) / okTimes.length) * 10) / 10, max: Math.max(...okTimes) } : null,
      tokens_ok_total: table.reduce((a, t) => a + (t.status === "ok" ? t.tokens ?? 0 : 0), 0),
      config: { concurrency: cfg.concurrency, min_start_interval_ms: cfg.minStartGapMs, max_attempts: cfg.maxAttempts, retry_delays_s: cfg.delays.map((d) => d / 1000), daily_call_limit: cfg.dailyCalls, model_limits: cfg.limits },
      calls_today: budgetUsed(this.svc(), "gemini_calls", "UTC"),
      distinct_errors: this.visDistinctErrors(batchId),
      queue_state: await this.visQueueState(),
      table,
      pending: counts.pending > 0,
      note: "Czasy w opisach zdjęć są przybliżone (szacunek modelu). Lista zdjęć nie jest dowodem kompletności: pominięte zdjęcia wykaże dopiero ręczne sprawdzenie.",
    };
  }

  visChunks(id: string, fmt: string): string[] | null {
    const v = this.loadVis(id);
    if (!v || v.status === "pending" || v.status === "running") return null;
    if (fmt === "json") return [JSON.stringify(v, null, 1)];
    if (fmt === "md") return [visToMarkdown(v)];
    return null;
  }

  // pomocnicze dla testów: odczyt pamięci podręcznej
  async _debugCache(key: string): Promise<string | null> {
    return cacheGet(this.svc(), key);
  }
}

void PauseError;

// Klasy błędów nie przechodzą przez granicę RPC (zostaje zwykły Error), więc błędy użytkownika oznaczamy prefiksem.
export const UE_PREFIX = "UE:";
for (const name of [
  "startJob", "resume", "refresh", "status", "list", "read", "singleTranscript", "resolve", "usage",
  "startSet", "setInfo", "startExport", "exportInfo", "exportChunks", "startVision", "visionStatus", "visionBatch",
] as const) {
  const orig = (Store.prototype as any)[name] as (...a: unknown[]) => Promise<unknown>;
  (Store.prototype as any)[name] = async function (this: Store, ...args: unknown[]) {
    try {
      return await orig.apply(this, args);
    } catch (e) {
      if (e instanceof UserError) throw new Error(UE_PREFIX + e.message);
      throw e;
    }
  };
}
