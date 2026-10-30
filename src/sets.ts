// Zestawy eksportu: jedno lub wiele zadań (kanałów), filtry, sortowanie, deduplikacja po ID filmu,
// ranking kanałowy oddzielony od rankingu zestawu, pliki CSV/JSON i paczka Markdown dla modelu (dzielona bez cięcia rolki).
// Budowa idzie małymi krokami w alarmach: wybór (po jednym zadaniu) → kolejność → partie rekordów → finalizacja.
import {
  buildCsvBatch, buildJsonBatch, COLUMNS, csvCells, jsonObject, mdRecord, parseCsv, timedStatus, VISION_LIMITS_PL, FRAMES_UNAVAILABLE_PL,
  type VisionExport, type VisionImage, type VisionLink,
  type ExportRecord, type HistoryPoint, type TimedSegment, type TopComment,
} from "./csv";
import { UserError } from "./types";
import { sha256Hex } from "./util";
import { MIN_SHORTS_FOR_NORM, MIN_SHORTS_FOR_TOP5, NORM_MULTIPLIER, SNAPSHOT_MIN_GAP_MS } from "./constants";
import type { Baseline, Job } from "./store";

export const SORT_FIELDS = [
  "selection", "views", "likes", "comments_count", "published_at", "duration_seconds", "views_vs_channel_median", "views_gain", "channel_views_rank",
] as const;
export type SortBy = (typeof SORT_FIELDS)[number];

export interface Filters {
  channel?: string;
  published_from?: string;
  published_to?: string;
  min_duration?: number;
  max_duration?: number;
  min_views?: number;
  max_views?: number;
  min_likes?: number;
  max_likes?: number;
  min_median_ratio?: number;
  max_median_ratio?: number;
  /** fraza albo lista fraz (wystarczy jedna); wielkość liter bez znaczenia */
  text?: string | string[];
  text_in?: "title" | "transcript" | "both";
}

export interface SetSpec {
  jobIds: string[];
  allowPartial: boolean;
  sortBy: SortBy;
  sortDir: "asc" | "desc";
  filters: Filters;
  mdPartChars: number | null;
  label?: string | null;
}

interface MdPart { n: number; records: number; chars: number; seq: number; ids: string[]; oversized: boolean }

interface SetState {
  id: string;
  key: string;
  created: number;
  spec: SetSpec;
  label: string;
  phase: "selecting" | "ordering" | "building" | "ready" | "failed";
  jobIdx: number;
  rowOff: number;
  total: number;
  nextPos: number;
  csvSeq: number;
  jsonSeq: number;
  md: { limit: number; parts: MdPart[] };
  duplicates: number;
  notes: string[];
  partial: boolean;
  sources: { job_id: string; channel: Job["channel"]; mode: string; phase: string; rev: number; baseline: Baseline | null }[];
  files?: Record<string, { records: number; bytes: number; sha256: string }>;
  error?: string;
  readyAt?: number;
}

const BATCH_RECORDS = 6;
const BATCH_CHARS = 90_000;
const SELECT_ROWS = 100;
export const MD_PART_DEFAULT = 180_000;
const MD_PART_MIN = 20_000;
const MD_PART_MAX = 1_000_000;
const HISTORY_POINTS = 20;

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const nul = (v: unknown) => (v == null ? null : Number(v));

function normOk(b: Baseline | null | undefined): boolean {
  if (!b || !b.history_complete) return false;
  return (b.norm_usable ?? (b.shorts_with_views >= MIN_SHORTS_FOR_NORM && (b.median_views ?? 0) > 0)) && (b.median_views ?? 0) > 0;
}
function top5Ok(b: Baseline | null | undefined): boolean {
  if (!b || !b.history_complete) return false;
  return b.top5_usable ?? b.shorts_with_views >= MIN_SHORTS_FOR_TOP5;
}

/** Sprawdza i porządkuje filtry. Daty: YYYY-MM-DD albo pełne ISO (UTC). */
export function normalizeFilters(f: Filters): Filters {
  const out: Filters = {};
  const numF = (k: keyof Filters) => {
    const v = (f as any)[k];
    if (v == null) return;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new UserError(`Filtr ${k} musi być liczbą >= 0.`);
    (out as any)[k] = v;
  };
  for (const k of ["min_duration", "max_duration", "min_views", "max_views", "min_likes", "max_likes", "min_median_ratio", "max_median_ratio"] as const) numF(k);
  const date = (v: unknown, end: boolean, k: string): string | undefined => {
    if (v == null || v === "") return undefined;
    if (typeof v !== "string") throw new UserError(`Filtr ${k}: podaj datę YYYY-MM-DD.`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + (end ? "T23:59:59Z" : "T00:00:00Z");
    const t = Date.parse(v);
    if (!Number.isFinite(t)) throw new UserError(`Filtr ${k}: nieprawidłowa data.`);
    return new Date(t).toISOString().replace(".000Z", "Z");
  };
  out.published_from = date(f.published_from, false, "published_from");
  out.published_to = date(f.published_to, true, "published_to");
  if (f.channel != null && f.channel !== "") {
    if (typeof f.channel !== "string") throw new UserError("Filtr channel musi być tekstem.");
    out.channel = f.channel.trim();
  }
  if (f.text != null && f.text !== "") {
    const arr = Array.isArray(f.text) ? f.text : [f.text];
    if (!arr.every((x) => typeof x === "string" && x.trim().length)) throw new UserError("Filtr text: fraza albo lista niepustych fraz.");
    if (arr.length > 20) throw new UserError("Filtr text: maksymalnie 20 fraz.");
    out.text = arr.map((x) => x.trim());
    out.text_in = f.text_in ?? "both";
    if (!["title", "transcript", "both"].includes(out.text_in)) throw new UserError("text_in: title, transcript albo both.");
  }
  for (const [a, b] of [["min_duration", "max_duration"], ["min_views", "max_views"], ["min_likes", "max_likes"], ["min_median_ratio", "max_median_ratio"], ["published_from", "published_to"]] as const) {
    const x = (out as any)[a], y = (out as any)[b];
    if (x != null && y != null && x > y) throw new UserError(`Filtr: ${a} jest większe niż ${b}.`);
  }
  for (const k of Object.keys(out)) if ((out as any)[k] === undefined) delete (out as any)[k];
  return out;
}

function channelMatches(ch: Job["channel"], q: string): boolean {
  const s = q.toLowerCase().replace(/^https?:\/\/(www\.)?youtube\.com\//, "").replace(/\/.*$/, "");
  const h = (ch.handle ?? "").toLowerCase();
  return ch.channel_id.toLowerCase() === s || h === s || h === "@" + s.replace(/^@/, "") || ch.title.toLowerCase().includes(s);
}

/** Jeden rekord eksportu z wiersza items + zadania. Rzuca przy niespójności danych (nie oddajemy uszkodzonych plików). */
export function buildRecord(sql: SqlStorage, r: Record<string, any>, job: Job, setRank: number | null, setSize: number | null): ExportRecord {
  const status = String(r.status) === "error" ? "error_service" : String(r.status);
  const hasText = status === "ok" || status === "empty";
  const text = hasText ? String(r.transcript ?? "") : null;
  if (hasText && text!.length !== Number(r.chars)) throw new UserError(`Niezgodność długości transkrypcji dla ${r.url}: eksport przerwany, nie oddaję uszkodzonych danych.`);
  let timed: TimedSegment[] | null = null;
  if (hasText && r.segs != null) {
    const segs = JSON.parse(String(r.segs)) as [number, number, string][];
    if (segs.map((x) => x[2]).join(" ") !== text) throw new UserError(`Niezgodność segmentów czasowych z transkrypcją dla ${r.url}: eksport przerwany.`);
    timed = segs.map(([o, d, t]) => ({ start_s: o < 0 ? null : Math.round(o / 100) / 10, end_s: o < 0 || d < 0 ? null : Math.round((o + d) / 100) / 10, text: t }));
  }
  const views = nul(r.views);
  const mat = nul(r.mat);
  const vid = String(r.vid);
  let prev: { views: number | null; at: number } | null = null;
  if (mat != null) {
    const p = sql.exec("SELECT views, at FROM snaps WHERE vid=? AND at <= ? ORDER BY at DESC LIMIT 1", vid, mat - SNAPSHOT_MIN_GAP_MS).toArray()[0];
    if (p) prev = { views: nul(p.views), at: Number(p.at) };
  }
  const history: HistoryPoint[] = sql
    .exec("SELECT at, views, likes, ccount FROM snaps WHERE vid=? ORDER BY at DESC LIMIT ?", vid, HISTORY_POINTS)
    .toArray()
    .reverse()
    .map((h) => ({ at: new Date(Number(h.at)).toISOString(), views: nul(h.views), likes: nul(h.likes), comments_count: nul(h.ccount) }));
  const gain = prev && prev.views != null && views != null ? views - prev.views : null;
  const days = prev && mat != null ? (mat - prev.at) / 86400_000 : null;
  const base = job.baseline ?? null;
  const histOk = !!base && base.history_complete;
  const nOk = normOk(base);
  const median = base?.median_views ?? null;
  const crank = histOk ? nul(r.crank) : null;
  const vis = loadVisionForExport(sql, vid);
  const commentsStatus = !job.opts?.comments
    ? r.cmts != null ? "ok" : "not_requested"
    : r.cstat == null ? (r.cmts != null ? "stale" : "not_fetched") : String(r.cstat);
  return {
    title: String(r.title), duration_seconds: Number(r.dur), transcript: text, published_at: String(r.pub), url: String(r.url), views,
    video_id: vid, channel_id: job.channel.channel_id, channel_title: job.channel.title, channel_handle: job.channel.handle,
    measured_at: iso(mat),
    likes: nul(r.likes), comments_count: nul(r.ccount),
    channel_views_rank: crank,
    channel_shorts_ranked: histOk ? base!.shorts_with_views : null,
    // pozycja (RANK, remisy dzielą miejsce) w pierwszych 5% kanału
    top_5_percent_channel: top5Ok(base) && views != null && crank != null ? crank <= Math.max(1, Math.floor(0.05 * base!.shorts_with_views)) : null,
    above_channel_norm: nOk && views != null ? views >= NORM_MULTIPLIER * median! : null,
    views_vs_channel_median: nOk && views != null ? Math.round((views / median!) * 100) / 100 : null,
    set_views_rank: setRank, set_size: setSize,
    views_prev: prev?.views ?? null,
    views_prev_at: prev ? new Date(prev.at).toISOString() : null,
    views_gain: gain,
    views_gain_per_day: gain != null && days != null && days > 0 ? Math.round((gain / days) * 10) / 10 : null,
    views_history: history,
    transcript_status: status,
    comments_status: commentsStatus,
    comments_fetched_at: iso(nul(r.cfat)),
    stats_status: r.sstat == null ? "ok" : String(r.sstat),
    top_comments_relevance: r.cmts == null ? null : (JSON.parse(String(r.cmts)) as TopComment[]),
    transcript_timed: timed,
    transcript_timed_status: timedStatus(hasText, timed?.length ?? 0, r.sgst == null ? null : String(r.sgst)),
    vision_status: vis.status,
    vision: vis.vision,
  };
}

const ITEM_COLS = "vid, ord, title, dur, pub, views, url, status, err, transcript, chars, likes, ccount, mat, crank, segs, sgst, cmts, cstat, cfat, sstat";

const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : v == null ? null : String(v));
const msgList = (a: unknown): { t: string | null; sender: string | null; text: string }[] =>
  Array.isArray(a) ? a.map((m: any) => ({ t: str(m?.t), sender: str(m?.sender), text: String(m?.text ?? "") })) : [];

/** Wynik wizji rolki z tej samej bazy: ostatni udany przebieg. Powiązania zostają oceną modelu (nie obserwacją człowieka). */
export function loadVisionForExport(sql: SqlStorage, vid: string): { status: string; vision: VisionExport | null } {
  const rows = sql.exec("SELECT state, status FROM vis WHERE vid=? ORDER BY created DESC", vid).toArray();
  if (!rows.length) return { status: "not_analyzed", vision: null };
  const okRow = rows.find((x) => String(x.status) === "ok");
  if (!okRow) {
    const live = rows.some((x) => ["pending", "running"].includes(String(x.status)));
    return { status: live ? "in_progress" : `failed:${String(rows[0].status)}`, vision: null };
  }
  const rec = JSON.parse(String(okRow.state));
  const p = rec.parsed ?? {};
  const images: VisionImage[] = (Array.isArray(p.images) ? p.images : []).map((im: any) => ({
    id: typeof im?.id === "number" ? im.id : null,
    first_visible: str(im?.first_visible), last_visible: str(im?.last_visible),
    appearances: Array.isArray(im?.appearances) ? im.appearances.map((a: any) => ({ from: str(a?.from), to: str(a?.to) })) : [],
    sent_by: str(im?.sent_by), description_pl: str(im?.description_pl), text_in_image: str(im?.text_in_image),
    messages_before: msgList(im?.messages_before), messages_after: msgList(im?.messages_after),
    related_messages: (Array.isArray(im?.related_messages) ? im.related_messages : []).map((m: any): VisionLink => {
      const basis = String(m?.basis ?? "");
      return {
        t: str(m?.t), sender: str(m?.sender), text: String(m?.text ?? ""), model_basis: basis,
        link_status_pl: basis === "explicit"
          ? "ocena modelu: wiadomość wprost odnosi się do zdjęcia (nie potwierdzona przez człowieka)"
          : basis === "assumption" ? "przypuszczenie modelu (nie potwierdzone)" : "ocena modelu bez określonej podstawy (nie potwierdzona)",
        reason_pl: str(m?.reason_pl),
      };
    }),
    uncertainty_pl: str(im?.uncertainty_pl),
    verification_pl: "niezweryfikowane przez człowieka (wynik modelu)",
  }));
  return {
    status: "ok",
    vision: {
      run_id: String(rec.id), model: str(rec.model_version) ?? str(rec.model_requested), fps: Number(rec.fps), api_seconds: rec.seconds == null ? null : Number(rec.seconds),
      analyzed_at: rec.done_at ? new Date(Number(rec.done_at)).toISOString() : null,
      images, messages: msgList(p.messages),
      unclear_ranges: (Array.isArray(p.unclear_ranges) ? p.unclear_ranges : []).map((u: any) => ({ from: str(u?.from), to: str(u?.to), reason_pl: str(u?.reason_pl) })),
      notes_pl: str(p.notes_pl),
      frames: { available: false, reason_pl: FRAMES_UNAVAILABLE_PL },
      limits_pl: VISION_LIMITS_PL,
    },
  };
}

export const DEFINITIONS = {
  channel_views_rank: "RANKING KANAŁU: miejsce wg wyświetleń wśród wszystkich Shortsów kanału tej rolki (1 = najwięcej); null, gdy historia kanału niepełna",
  top_5_percent_channel: `RANKING KANAŁU: miejsce mieści się w pierwszych 5% Shortsów kanału (miejsce <= max(1, floor(5% liczby rolek)), remisy dzielą miejsce); null przy niepełnej historii lub mniej niż ${MIN_SHORTS_FOR_TOP5} rolkach`,
  above_channel_norm: `RANKING KANAŁU: wyświetlenia >= ${NORM_MULTIPLIER} × mediana Shortsów kanału; null przy niepełnej historii, mniej niż ${MIN_SHORTS_FOR_NORM} rolkach albo medianie = 0`,
  views_vs_channel_median: "RANKING KANAŁU: wyświetlenia / mediana Shortsów kanału",
  set_views_rank: "RANKING ZESTAWU: miejsce wg wyświetleń wśród rolek w tym pliku (po filtrach i deduplikacji), niezależne od kanału",
  age_caveat: "Rankingi, TOP 5% i norma liczone są z całkowitej liczby wyświetleń i NIE uwzględniają wieku publikacji: starsze rolki miały więcej czasu na zebranie wyświetleń, świeże są niedoszacowane.",
  views_gain: "przyrost wyświetleń od poprzedniego pomiaru tej rolki na serwerze (co najmniej 1 h wcześniej, najwyżej 30 dni wstecz); null przy pierwszym pomiarze",
  views_history: `do ${HISTORY_POINTS} ostatnich pomiarów z ostatnich 30 dni (czas UTC, wyświetlenia, polubienia, liczba komentarzy); zasady YouTube API pozwalają trzymać statystyki najwyżej 30 dni`,
  measured_at: "czas pomiaru statystyk tej rolki (UTC)",
  top_comments_relevance: "do 5 komentarzy w kolejności TRAFNOŚCI wg YouTube (order=relevance), nie posortowane wg polubień",
  transcript_timed_status: "ok | no_transcript | no_segments_in_response (Supadata zwróciło sam tekst) | mismatch_not_stored (segmenty niezgodne z tekstem) | unknown_not_recorded (rekord sprzed zapisu przyczyny; segmentów w bazie brak)",
  vision_status: "ok (wynik jest) | not_analyzed (nie analizowano) | in_progress | failed:<status> (analiza nieudana). Opis zdjęć, czasy i powiązania to wynik modelu Gemini, niezweryfikowany przez człowieka; powiązanie „jawne” to ocena modelu, nie potwierdzona obserwacja",
  vision: "wynik analizy zdjęć i wiadomości (Gemini): zdjęcia z opisem, czasem, nadawcą, wiadomościami przed/po i powiązaniami (z oceną modelu), wiadomości odczytane z ekranu, brak obrazów (frames.available=false)",
  transcript_timed: "te same segmenty co transcript, z czasem startu i końca w sekundach (od Supadata); segmenty napisów YouTube mogą na siebie nachodzić",
  transcript_status: "ok | empty | no_captions (brak transkryptu) | error_video | error_service | no_credits (wyczerpane kredyty) | pending | pending_ai",
  comments_status: "ok | disabled (wyłączone) | unavailable | error (błąd usługi) | not_fetched | stale (z poprzedniego pomiaru) | not_requested",
  stats_status: "ok | unavailable (film nie zwrócony przy ostatnim pomiarze; statystyki z wcześniejszego pomiaru)",
};

export class SetBuilder {
  constructor(
    private sql: SqlStorage,
    private loadJob: (id: string) => Job,
    private saveJob: (j: Job) => void,
    private storage: DurableObjectStorage,
  ) {}

  private load(id: string): SetState | null {
    const row = this.sql.exec("SELECT state FROM sets WHERE id=?", id).toArray()[0];
    return row ? (JSON.parse(String(row.state)) as SetState) : null;
  }
  private save(st: SetState): void {
    this.sql.exec(
      "INSERT INTO sets(id, phase, state, created, updated) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, state=excluded.state, updated=excluded.updated",
      st.id, st.phase, JSON.stringify(st), st.created, Date.now(),
    );
  }
  private drop(id: string): void {
    for (const t of ["set_cands", "set_items"]) this.sql.exec(`DELETE FROM ${t} WHERE sid=?`, id);
    this.sql.exec("DELETE FROM exp_chunks WHERE job=?", id);
  }

  prune(before: number): void {
    for (const r of this.sql.exec("SELECT id FROM sets WHERE updated < ?", before).toArray()) {
      this.drop(String(r.id));
      this.sql.exec("DELETE FROM sets WHERE id=?", String(r.id));
    }
  }

  create(specIn: SetSpec): any {
    const ids = [...new Set(specIn.jobIds ?? [])];
    if (!ids.length) throw new UserError("Podaj job_id albo job_ids.");
    if (ids.length > 20) throw new UserError("Maksymalnie 20 zadań w jednym zestawie.");
    if (!SORT_FIELDS.includes(specIn.sortBy)) throw new UserError(`sort_by: ${SORT_FIELDS.join(", ")}.`);
    if (!["asc", "desc"].includes(specIn.sortDir)) throw new UserError("sort_dir: asc albo desc.");
    let mdLimit = specIn.mdPartChars ?? MD_PART_DEFAULT;
    if (!Number.isFinite(mdLimit) || mdLimit < MD_PART_MIN || mdLimit > MD_PART_MAX) throw new UserError(`md_part_chars: ${MD_PART_MIN}-${MD_PART_MAX}.`);
    mdLimit = Math.floor(mdLimit);
    const filters = normalizeFilters(specIn.filters ?? {});
    const jobs = ids.map((id) => this.loadJob(id));
    for (const j of jobs) {
      const n = Number(this.sql.exec("SELECT COUNT(*) AS n FROM items WHERE job=?", j.id).one().n);
      if (j.phase === "enumerating" || (n === 0 && j.phase !== "done")) throw new UserError(`Zadanie ${j.id} jeszcze nie wybrało filmów. Poczekaj (continue_collection / get_collection_status).`);
    }
    const unfinished = jobs.filter((j) => j.phase !== "done");
    if (unfinished.length && !specIn.allowPartial) {
      throw new UserError(
        `Zadanie nie jest zakończone (complete=false): ${unfinished.map((j) => j.id).join(", ")}. Dokończ je (continue_collection) albo użyj allow_partial=true, aby wyeksportować to, co jest.`,
      );
    }
    for (const j of unfinished) {
      if (j.running) {
        j.running = false;
        j.stoppedReason = "Wstrzymano na czas eksportu częściowego. continue_collection wznowi pobieranie.";
        this.saveJob(j);
      }
    }
    const spec: SetSpec = { jobIds: ids, allowPartial: !!specIn.allowPartial, sortBy: specIn.sortBy, sortDir: specIn.sortDir, filters, mdPartChars: mdLimit, label: specIn.label ?? null };
    const key = JSON.stringify({ spec, revs: jobs.map((j) => [j.id, j.rev ?? 0, j.phase]) });
    // ten sam zestaw (te same dane i parametry) gotowy albo w budowie: nie budujemy drugi raz
    for (const r of this.sql.exec("SELECT id FROM sets WHERE phase != 'failed' ORDER BY updated DESC LIMIT 50").toArray()) {
      const st = this.load(String(r.id));
      if (st && st.key === key) {
        if (ids.length === 1) this.link(jobs[0], st.id);
        return this.info(st.id);
      }
    }
    const id = "s-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const label =
      spec.label ||
      (jobs.length === 1
        ? `${jobs[0].channel.handle ?? jobs[0].channel.title} (${jobs[0].mode}, ${jobs[0].count})`
        : `zestaw ${jobs.length} zadań: ${[...new Set(jobs.map((j) => j.channel.handle ?? j.channel.title))].join(", ")}`);
    const st: SetState = {
      id, key, created: Date.now(), spec, label, phase: "selecting", jobIdx: 0, rowOff: 0, total: 0, nextPos: 0, csvSeq: 0, jsonSeq: 0,
      md: { limit: mdLimit, parts: [] }, duplicates: 0, notes: [], partial: unfinished.length > 0,
      sources: jobs.map((j) => ({ job_id: j.id, channel: j.channel, mode: j.mode, phase: j.phase, rev: j.rev ?? 0, baseline: j.baseline ?? null })),
    };
    this.save(st);
    if (ids.length === 1) this.link(jobs[0], id);
    return this.info(id);
  }

  private link(job: Job, setId: string): void {
    const fresh = this.loadJob(job.id);
    fresh.export = { setId };
    this.saveJob(fresh);
  }

  info(id: string): any {
    const st = this.load(id);
    if (!st) return null;
    return {
      set_id: st.id, label: st.label, phase: st.phase, partial: st.partial, records: st.total, files: st.files ?? null, error: st.error ?? null,
      job_ids: st.spec.jobIds, filters: st.spec.filters, sort: { by: st.spec.sortBy, dir: st.spec.sortDir },
      duplicates_removed: st.duplicates, notes: st.notes,
      md_parts: st.md.parts.map((p) => ({ part: p.n, records: p.records, chars: p.chars, oversized_record: p.oversized })),
    };
  }

  chunks(id: string, fmt: string): string[] | null {
    const st = this.load(id);
    if (!st || st.phase !== "ready") return null;
    if (!st.files?.[fmt] && fmt !== "status") return null;
    return this.sql.exec("SELECT data FROM exp_chunks WHERE job=? AND fmt=? ORDER BY seq", id, fmt).toArray().map((r) => String(r.data));
  }

  anyBuilding(): boolean {
    return this.sql.exec("SELECT 1 FROM sets WHERE phase IN ('selecting','ordering','building') LIMIT 1").toArray().length > 0;
  }

  /** Jeden krok najstarszego budowanego zestawu. Zwraca true, gdy coś było do zrobienia. */
  async stepAny(): Promise<boolean> {
    const row = this.sql.exec("SELECT id FROM sets WHERE phase IN ('selecting','ordering','building') ORDER BY updated ASC LIMIT 1").toArray()[0];
    if (!row) return false;
    const st = this.load(String(row.id))!;
    try {
      if (st.phase === "selecting") this.selectStep(st);
      else if (st.phase === "ordering") this.orderStep(st);
      else await this.buildStep(st);
    } catch (e) {
      if (!(e instanceof UserError)) console.error("Błąd budowy zestawu", st.id, (e as Error)?.name, (e as Error)?.message);
      st.phase = "failed";
      st.error = e instanceof UserError ? e.message : "Wewnętrzny błąd przy budowie eksportu (szczegóły w logach Workera).";
      this.drop(st.id);
    }
    this.save(st);
    return true;
  }

  // ------------------------------------------------------------------------ wybór
  private selectStep(st: SetState): void {
    const f = st.spec.filters;
    if (st.jobIdx >= st.spec.jobIds.length) {
      st.phase = "ordering";
      return;
    }
    const jobId = st.spec.jobIds[st.jobIdx];
    const job = this.loadJob(jobId);
    const next = () => {
      st.jobIdx++;
      st.rowOff = 0;
    };
    if (f.channel && !channelMatches(job.channel, f.channel)) {
      next();
      return;
    }
    const med = normOk(job.baseline) ? (job.baseline!.median_views as number) : null;
    if ((f.min_median_ratio != null || f.max_median_ratio != null) && med == null) {
      st.notes.push(`Kanał ${job.channel.handle ?? job.channel.title} (zadanie ${job.id}) pominięty w filtrze mediany: brak normy kanału (niepełna historia, za mało rolek albo mediana 0).`);
      next();
      return;
    }
    const where: string[] = ["job=?"];
    const args: unknown[] = [job.id];
    const add = (cond: string, v: unknown) => {
      where.push(cond);
      args.push(v);
    };
    if (f.published_from) add("pub >= ?", f.published_from);
    if (f.published_to) add("pub <= ?", f.published_to);
    if (f.min_duration != null) add("dur >= ?", f.min_duration);
    if (f.max_duration != null) add("dur <= ?", f.max_duration);
    if (f.min_views != null) add("views >= ?", f.min_views);
    if (f.max_views != null) add("views <= ?", f.max_views);
    if (f.min_likes != null) add("likes >= ?", f.min_likes);
    if (f.max_likes != null) add("likes <= ?", f.max_likes);
    if (f.min_median_ratio != null) add("views >= ?", f.min_median_ratio * med!);
    if (f.max_median_ratio != null) add("views <= ?", f.max_median_ratio * med!);
    const needles = (f.text as string[] | undefined)?.map((x) => x.toLocaleLowerCase()) ?? null;
    const inTitle = !!needles && f.text_in !== "transcript";
    const inText = !!needles && f.text_in !== "title";
    const rows = this.sql
      .exec(`SELECT vid, mat, title${inText ? ", transcript" : ""} FROM items WHERE ${where.join(" AND ")} ORDER BY ord LIMIT ? OFFSET ?`, ...args, SELECT_ROWS, st.rowOff)
      .toArray();
    this.storage.transactionSync(() => {
      for (const r of rows) {
        if (needles) {
          const t = inTitle ? String(r.title).toLocaleLowerCase() : "";
          const x = inText && r.transcript != null ? String(r.transcript).toLocaleLowerCase() : "";
          if (!needles.some((n) => (inTitle && t.includes(n)) || (inText && x.includes(n)))) continue;
        }
        const vid = String(r.vid);
        const mat = nul(r.mat);
        const p = mat != null ? this.sql.exec("SELECT views FROM snaps WHERE vid=? AND at <= ? ORDER BY at DESC LIMIT 1", vid, mat - SNAPSHOT_MIN_GAP_MS).toArray()[0] : undefined;
        const exists = this.sql.exec("SELECT mat FROM set_cands WHERE sid=? AND vid=?", st.id, vid).toArray()[0];
        if (exists) st.duplicates++;
        // duplikat (ta sama rolka w kilku zadaniach): zostaje wersja z najnowszym pomiarem statystyk
        this.sql.exec(
          `INSERT INTO set_cands(sid, vid, job, jidx, mat, med, prevv) VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(sid, vid) DO UPDATE SET job=excluded.job, jidx=excluded.jidx, mat=excluded.mat, med=excluded.med, prevv=excluded.prevv
           WHERE COALESCE(excluded.mat, 0) > COALESCE(set_cands.mat, 0)`,
          st.id, vid, job.id, st.jobIdx, mat, med, p ? nul(p.views) : null,
        );
      }
    });
    if (rows.length < SELECT_ROWS) next();
    else st.rowOff += SELECT_ROWS;
  }

  // ---------------------------------------------------------------------- kolejność
  private orderStep(st: SetState): void {
    const dir = st.spec.sortDir === "asc" ? "ASC" : "DESC";
    const expr: Record<SortBy, string> = {
      selection: "c.jidx",
      views: "i.views",
      likes: "i.likes",
      comments_count: "i.ccount",
      published_at: "i.pub",
      duration_seconds: "i.dur",
      views_vs_channel_median: "(CASE WHEN c.med > 0 AND i.views IS NOT NULL THEN i.views * 1.0 / c.med END)",
      views_gain: "(CASE WHEN c.prevv IS NOT NULL AND i.views IS NOT NULL THEN i.views - c.prevv END)",
      channel_views_rank: "i.crank",
    };
    const e = expr[st.spec.sortBy];
    const order = st.spec.sortBy === "selection" ? `c.jidx ${dir}, i.ord ${dir}` : `(${e}) IS NULL, ${e} ${dir}, c.jidx ASC, i.ord ASC`;
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM set_items WHERE sid=?", st.id);
      this.sql.exec(
        `INSERT INTO set_items(sid, pos, job, vid, srank)
         SELECT ?, ROW_NUMBER() OVER (ORDER BY ${order}) - 1, c.job, c.vid,
                CASE WHEN i.views IS NULL THEN NULL ELSE RANK() OVER (ORDER BY COALESCE(i.views, -1) DESC) END
         FROM set_cands c JOIN items i ON i.job = c.job AND i.vid = c.vid WHERE c.sid = ?`,
        st.id, st.id,
      );
      this.sql.exec("DELETE FROM set_cands WHERE sid=?", st.id);
    });
    st.total = Number(this.sql.exec("SELECT COUNT(*) AS n FROM set_items WHERE sid=?", st.id).one().n);
    st.phase = "building";
  }

  // -------------------------------------------------------------------------- pliki
  private putChunk(st: SetState, fmt: string, seq: number, data: string): void {
    this.sql.exec("INSERT INTO exp_chunks(job, fmt, seq, data) VALUES(?,?,?,?)", st.id, fmt, seq, data);
  }

  private mdHeader(st: SetState, n: number): string {
    const L = [`# Paczka danych dla modelu: ${st.label}`, "", `Część ${n}. Zestaw \`${st.id}\`, wygenerowany ${new Date().toISOString()}.`, ""];
    if (n === 1) {
      L.push("Ten plik zawiera wyłącznie dane (bez ocen i interpretacji). Każda rolka ma ID i link; transkrypt jest podany ze znacznikami czasu [m:ss.s], jeśli zostały zapisane (inaczej jest jawny status braku). Wyniki wizji (zdjęcia) są oceną modelu, niezweryfikowaną przez człowieka.", "");
      L.push("## Źródła", "");
      for (const s of st.sources) {
        const b = s.baseline;
        L.push(
          `- ${s.channel.title}${s.channel.handle ? ` (${s.channel.handle})` : ""}, kanał \`${s.channel.channel_id}\`, zadanie \`${s.job_id}\` (tryb ${s.mode}${s.phase !== "done" ? ", NIEZAKOŃCZONE" : ""})` +
            (b ? `; norma kanału: mediana ${b.median_views ?? "brak"}, Shortsów z wyświetleniami: ${b.shorts_with_views}${b.notes?.length ? `; uwagi: ${b.notes.join(" ")}` : ""}` : "; norma kanału: nie liczona"),
        );
      }
      L.push("", "## Parametry zestawu", "");
      L.push(`- Filtry: ${Object.keys(st.spec.filters).length ? JSON.stringify(st.spec.filters) : "brak"}`);
      L.push(`- Sortowanie: ${st.spec.sortBy} ${st.spec.sortDir}`);
      L.push(`- Rolek w zestawie: ${st.total}; usunięte duplikaty (ta sama rolka w kilku zadaniach): ${st.duplicates}`);
      for (const note of st.notes) L.push(`- Uwaga: ${note}`);
      L.push("", "## Definicje", "");
      for (const [k, v] of Object.entries(DEFINITIONS)) L.push(`- \`${k}\`: ${v}`);
      L.push("", "---", "");
    }
    return L.join("\n");
  }

  private mdAdd(st: SetState, section: string, vid: string): void {
    let cur = st.md.parts.at(-1);
    if (!cur || (cur.records > 0 && cur.chars + section.length > st.md.limit)) {
      if (cur) this.mdClose(st, cur);
      const n = (cur?.n ?? 0) + 1;
      const head = this.mdHeader(st, n);
      cur = { n, records: 0, chars: head.length, seq: 0, ids: [], oversized: false };
      st.md.parts.push(cur);
      this.putChunk(st, `md-${n}`, cur.seq++, head);
    }
    this.putChunk(st, `md-${cur.n}`, cur.seq++, section);
    cur.chars += section.length;
    cur.records++;
    cur.ids.push(vid);
    if (section.length > st.md.limit) cur.oversized = true; // pojedyncza rolka większa niż limit części: nie jest cięta
  }

  private mdClose(st: SetState, p: MdPart): void {
    const foot = `\n_Koniec części ${p.n}. Rolki w tej części (ID): ${p.ids.join(", ") || "brak"}._\n`;
    this.putChunk(st, `md-${p.n}`, p.seq++, foot);
    p.chars += foot.length;
  }

  private async buildStep(st: SetState): Promise<void> {
    const rows = this.sql.exec("SELECT pos, job, vid, srank FROM set_items WHERE sid=? AND pos >= ? ORDER BY pos LIMIT ?", st.id, st.nextPos, BATCH_RECORDS).toArray();
    const jobs = new Map<string, Job>();
    const getJob = (id: string) => {
      let j = jobs.get(id);
      if (!j) {
        j = this.loadJob(id);
        jobs.set(id, j);
      }
      return j;
    };
    const setSize = st.total;
    const records: { r: ExportRecord; pos: number }[] = [];
    let chars = 0;
    for (const s of rows) {
      const item = this.sql.exec(`SELECT ${ITEM_COLS} FROM items WHERE job=? AND vid=?`, String(s.job), String(s.vid)).toArray()[0];
      if (!item) throw new UserError(`Rolka ${s.vid} zniknęła z zadania ${s.job} w trakcie eksportu (niespójny stan). Zbuduj eksport ponownie.`);
      const len = item.transcript == null ? 0 : String(item.transcript).length;
      if (records.length && chars + 3 * len > BATCH_CHARS) break;
      records.push({ r: buildRecord(this.sql, item, getJob(String(s.job)), nul(s.srank), setSize), pos: Number(s.pos) });
      chars += 3 * len + (item.cmts == null ? 0 : String(item.cmts).length * 2) + 1500;
    }
    if (records.length) {
      const recs = records.map((x) => x.r);
      const csv = buildCsvBatch(recs, st.csvSeq === 0);
      const js = buildJsonBatch(recs, st.jsonSeq === 0);
      // weryfikacja po zbudowaniu: odczyt z powrotem i porównanie z rekordami źródłowymi
      const parsed = parseCsv(st.csvSeq === 0 ? csv.replace(/^﻿/, "") : csv);
      const body = st.csvSeq === 0 ? parsed.slice(1) : parsed;
      if (st.csvSeq === 0 && parsed[0].join("|") !== COLUMNS.join("|")) throw new UserError("Weryfikacja eksportu: niepoprawny nagłówek CSV.");
      if (body.length !== recs.length) throw new UserError("Weryfikacja eksportu: liczba wierszy CSV różni się od liczby rekordów.");
      const jsParsed = JSON.parse("[" + js.replace(/^\[\n/, "").replace(/^,\n/, "") + "]");
      if (jsParsed.length !== recs.length) throw new UserError("Weryfikacja eksportu: liczba rekordów JSON różni się od źródła.");
      recs.forEach((r, i) => {
        const want = csvCells(r);
        const f = body[i];
        const csvOk = f.length === want.length && f.every((v, k) => v === want[k]);
        const jsonOk = JSON.stringify(jsParsed[i]) === JSON.stringify(jsonObject(r)) && jsParsed[i].transcript === r.transcript;
        if (!csvOk || !jsonOk) throw new UserError(`Weryfikacja eksportu nie powiodła się dla ${r.url} (dane po zapisie różnią się od źródła).`);
      });
      this.putChunk(st, "csv", st.csvSeq++, csv);
      this.putChunk(st, "json", st.jsonSeq++, js);
      for (const { r, pos } of records) {
        const sec = mdRecord(r, pos + 1);
        // Markdown: ID i każdy segment transkryptu muszą być w sekcji (pełny transkrypt, bez skracania)
        const okMd = sec.includes(`\`${r.video_id}\``) && (r.transcript_timed ? r.transcript_timed.every((t) => sec.includes(t.text)) : r.transcript == null || sec.includes(r.transcript));
        if (!okMd) throw new UserError(`Weryfikacja paczki Markdown nie powiodła się dla ${r.url}.`);
        this.mdAdd(st, sec, r.video_id);
      }
      st.nextPos = records[records.length - 1].pos + 1;
    }
    if (st.nextPos < st.total && records.length) return; // kolejny krok w następnym alarmie
    if (st.nextPos < st.total && !records.length) throw new UserError("Eksport nie znalazł oczekiwanych rekordów (niespójny stan).");
    await this.finalize(st);
  }

  private async finalize(st: SetState): Promise<void> {
    if (st.csvSeq === 0) this.putChunk(st, "csv", st.csvSeq++, buildCsvBatch([], true));
    this.putChunk(st, "json", st.jsonSeq++, st.total === 0 ? "[]\n" : "\n]\n");
    if (!st.md.parts.length) {
      const head = this.mdHeader(st, 1);
      st.md.parts.push({ n: 1, records: 0, chars: head.length, seq: 0, ids: [], oversized: false });
      this.putChunk(st, "md-1", st.md.parts[0].seq++, head + "\n(zestaw pusty: żadna rolka nie spełnia filtrów)\n");
    }
    this.mdClose(st, st.md.parts.at(-1)!);
    const files: Record<string, { records: number; bytes: number; sha256: string }> = {};
    const fmts = ["csv", "json", ...st.md.parts.map((p) => `md-${p.n}`)];
    for (const fmt of fmts) {
      const text = this.sql.exec("SELECT data FROM exp_chunks WHERE job=? AND fmt=? ORDER BY seq", st.id, fmt).toArray().map((r) => String(r.data)).join("");
      const bytes = new TextEncoder().encode(text);
      const recs = fmt.startsWith("md-") ? st.md.parts.find((p) => `md-${p.n}` === fmt)!.records : st.total;
      files[fmt] = { records: recs, bytes: bytes.length, sha256: await sha256Hex(bytes) };
    }
    const partOf = new Map<string, number>();
    for (const p of st.md.parts) for (const v of p.ids) partOf.set(v, p.n);
    const counts: Record<string, Record<string, number>> = { transcript_status: {}, comments_status: {}, stats_status: {} };
    const recs: any[] = [];
    for (const s of this.sql.exec("SELECT s.pos, s.job, s.vid, i.url, i.status, i.err, i.chars, i.hash, i.cstat, i.cmts, i.sstat, i.segs IS NOT NULL AS timed, i.sgst, CASE WHEN i.segs IS NULL THEN 0 ELSE json_array_length(i.segs) END AS nsegs FROM set_items s JOIN items i ON i.job=s.job AND i.vid=s.vid WHERE s.sid=? ORDER BY s.pos", st.id).toArray()) {
      const job = this.loadJob(String(s.job));
      const ts = String(s.status) === "error" ? "error_service" : String(s.status);
      const cs = !job.opts?.comments ? (s.cmts != null ? "ok" : "not_requested") : s.cstat == null ? (s.cmts != null ? "stale" : "not_fetched") : String(s.cstat);
      const ss = s.sstat == null ? "ok" : String(s.sstat);
      counts.transcript_status[ts] = (counts.transcript_status[ts] ?? 0) + 1;
      counts.comments_status[cs] = (counts.comments_status[cs] ?? 0) + 1;
      counts.stats_status[ss] = (counts.stats_status[ss] ?? 0) + 1;
      recs.push({
        position: Number(s.pos) + 1, video_id: String(s.vid), url: String(s.url), channel_id: job.channel.channel_id, job_id: String(s.job),
        status: ts, error: s.err == null ? null : String(s.err), transcript_chars: s.chars == null ? null : Number(s.chars),
        transcript_sha256: s.hash == null ? null : String(s.hash), transcript_timed: Number(s.timed) === 1, transcript_timed_segments: Number(s.nsegs ?? 0), transcript_timed_status: timedStatus(ts === "ok" || ts === "empty", Number(s.nsegs ?? 0), s.sgst == null ? null : String(s.sgst)), vision_status: loadVisionForExport(this.sql, String(s.vid)).status, comments_status: cs, stats_status: ss,
        md_part: partOf.get(String(s.vid)) ?? null,
      });
    }
    const statusDoc = {
      set_id: st.id, label: st.label, generated_at: new Date().toISOString(), complete: !st.partial, partial_export: st.partial,
      sources: st.sources, filters: st.spec.filters, sort: st.spec.sortBy === "selection" ? "selection" : `${st.spec.sortBy}_${st.spec.sortDir}`,
      selected: st.total, duplicates_removed: st.duplicates, notes: st.notes, counts, files,
      md_parts: st.md.parts.map((p) => ({ part: p.n, records: p.records, chars: p.chars, oversized_record: p.oversized, first_id: p.ids[0] ?? null, last_id: p.ids.at(-1) ?? null })),
      definitions: DEFINITIONS,
      note: "transcript_chars to długość w jednostkach UTF-16 (JavaScript). Pole transcript w CSV/JSON: null/puste = brak danych, przyczyna w records[].status.",
      records: recs,
    };
    this.putChunk(st, "status", 0, JSON.stringify(statusDoc, null, 1));
    st.files = files;
    st.phase = "ready";
    st.readyAt = Date.now();
  }
}

void sha256Hex;
