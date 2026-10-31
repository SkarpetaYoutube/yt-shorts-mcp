// Rekord eksportu i jego zapis: CSV, JSON i Markdown (paczka dla modelu). Brak danych: CSV puste pole, JSON null,
// Markdown „brak danych” z przyczyną. Nic nie jest zgadywane ani uzupełniane, nie ma tu ocen ani interpretacji.

export interface TimedSegment {
  start_s: number | null; // null = Supadata nie podało czasu dla tego segmentu
  end_s: number | null;
  text: string;
}
export interface TopComment {
  text: string;
  likes: number | null;
  published_at: string;
}
export interface HistoryPoint {
  at: string;
  views: number | null;
  likes: number | null;
  comments_count: number | null;
}

/** Jedno zdjęcie z wyniku wizji. Powiązania to OCENA MODELU (Gemini), nie potwierdzona obserwacja człowieka. */
export interface VisionLink { t: string | null; sender: string | null; text: string; model_basis: string; link_status_pl: string; reason_pl: string | null }
export interface VisionImage {
  id: number | null;
  first_visible: string | null;
  last_visible: string | null;
  appearances: { from: string | null; to: string | null }[];
  sent_by: string | null;
  description_pl: string | null;
  text_in_image: string | null;
  messages_before: { t: string | null; sender: string | null; text: string }[];
  messages_after: { t: string | null; sender: string | null; text: string }[];
  related_messages: VisionLink[];
  uncertainty_pl: string | null;
  verification_pl: string;
}
export interface VisionExport {
  run_id: string;
  model: string | null;
  fps: number;
  api_seconds: number | null;
  analyzed_at: string | null;
  images: VisionImage[];
  messages: { t: string | null; sender: string | null; text: string }[];
  unclear_ranges: { from: string | null; to: string | null; reason_pl: string | null }[];
  notes_pl: string | null;
  frames: { available: false; reason_pl: string };
  limits_pl: string;
}

export const VISION_LIMITS_PL =
  "Opis, czasy i powiązania pochodzą z modelu Gemini i nie były weryfikowane przez człowieka. Czasy są przybliżone: początek zwykle trafia w ok. ±0,5 s, koniec bywa zaniżony o 1–3 s (pomiar ręczny na 8 rolkach). Zdjęcia widoczne krócej niż ok. 1 s mogą nie zostać wykryte (w próbie 8 rolek jedno pominięte). Brak zdjęcia w wyniku nie dowodzi, że go nie było.";
export const FRAMES_UNAVAILABLE_PL =
  "Obrazów (zrzutów klatek) nie ma w eksporcie: serwer widzi film tylko przez publiczny link YouTube i nie ma dozwolonego źródła plików klatek.";

export interface ExportRecord {
  title: string;
  duration_seconds: number;
  transcript: string | null;
  published_at: string;
  url: string;
  views: number | null;
  video_id: string;
  channel_id: string;
  channel_title: string;
  channel_handle: string | null;
  measured_at: string | null;
  likes: number | null;
  comments_count: number | null;
  channel_views_rank: number | null;
  channel_shorts_ranked: number | null;
  top_5_percent_channel: boolean | null;
  above_channel_norm: boolean | null;
  views_vs_channel_median: number | null;
  set_views_rank: number | null;
  set_size: number | null;
  views_prev: number | null;
  views_prev_at: string | null;
  views_gain: number | null;
  views_gain_per_day: number | null;
  views_history: HistoryPoint[];
  transcript_status: string;
  comments_status: string;
  comments_fetched_at: string | null;
  stats_status: string;
  top_comments_relevance: TopComment[] | null;
  transcript_timed: TimedSegment[] | null;
  /** ok | no_transcript | no_segments_in_response | mismatch_not_stored | unknown_not_recorded (z komentarzem w md) */
  transcript_timed_status: string;
  /** ok | not_analyzed | in_progress | failed:<status> */
  vision_status: string;
  vision: VisionExport | null;
}

export const COLUMNS = [
  "title", "duration_seconds", "transcript", "published_at", "url", "views",
  "video_id", "channel_id", "channel_title", "channel_handle", "measured_at",
  "likes", "comments_count",
  "channel_views_rank", "channel_shorts_ranked", "top_5_percent_channel", "above_channel_norm", "views_vs_channel_median",
  "set_views_rank", "set_size",
  "views_prev", "views_prev_at", "views_gain", "views_gain_per_day", "views_history",
  "transcript_status", "comments_status", "comments_fetched_at", "stats_status",
  "top_comments_relevance", "transcript_timed",
  "transcript_timed_status", "vision_status", "vision",
] as const;

const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const n = (v: number | null) => (v == null ? "" : String(v));
const b = (v: boolean | null) => (v == null ? "" : v ? "TAK" : "NIE");

/** Czas jako m:ss.s (np. 1:05.3). */
export function clock(sec: number | null): string {
  if (sec == null) return "?";
  const tenths = Math.round(sec * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

export function timedToText(segs: TimedSegment[] | null): string {
  return segs == null ? "" : segs.map((x) => `[${clock(x.start_s)}] ${x.text}`).join("\n");
}
export function commentsToText(c: TopComment[] | null): string {
  return c == null ? "" : c.map((x, i) => `${i + 1}. (${x.likes == null ? "?" : x.likes} polubień) ${x.text}`).join("\n");
}
export function historyToText(h: HistoryPoint[]): string {
  return h.map((p) => `${p.at}: ${p.views ?? "?"}`).join("; ");
}

export const TIMED_STATUS_PL: Record<string, string> = {
  ok: "zapisane (segmenty ze znacznikami czasu od Supadata)",
  no_transcript: "brak transkryptu, więc brak czasów",
  no_segments_in_response: "brak: Supadata zwróciło sam tekst bez segmentów, czasów nie ma",
  mismatch_not_stored: "brak: segmenty nie złożyły się w dokładnie ten sam tekst, więc ich nie zapisano",
  unknown_not_recorded: "brak segmentów w bazie; przyczyny nie zapisano (rekord powstał przed zapisem przyczyny)",
};
/** Status czasów z tego, co jest w bazie: liczba segmentów i zapisana przyczyna. Bez zgadywania. */
export function timedStatus(hasText: boolean, nsegs: number, sgst: string | null): string {
  if (!hasText) return "no_transcript";
  if (nsegs > 0) return "ok";
  if (sgst === "no_segments_in_response" || sgst === "mismatch_not_stored") return sgst;
  return "unknown_not_recorded";
}

export function visionToText(v: VisionExport | null): string {
  if (!v) return "";
  const L: string[] = [];
  for (const im of v.images) {
    L.push(`Zdjęcie ${im.id ?? "?"} [${im.first_visible ?? "?"}–${im.last_visible ?? "?"}] nadawca: ${im.sent_by ?? "?"}: ${im.description_pl ?? ""}`);
    for (const m of im.related_messages) L.push(`  powiązanie (${m.link_status_pl}): ${m.t ?? "?"} ${m.sender ?? "?"}: ${m.text}`);
  }
  return L.join("\n");
}

/**
 * Ochrona przed wstrzyknięciem formuł (Excel/Arkusze): tekst z zewnątrz (tytuł, transkrypt, komentarze…) zaczynający się od = + - @ albo tabulatora/CR
 * dostaje na początku apostrof. Dotyczy tylko pól tekstowych w CSV; JSON i Markdown zostają bez zmian, liczby i identyfikatory też.
 */
export const csvSafe = (s: string): string => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s);

/** Komórki CSV jednego rekordu (bez cytowania) – wspólne dla budowy i weryfikacji. */
export function csvCells(r: ExportRecord): string[] {
  return [
    csvSafe(r.title), String(r.duration_seconds), csvSafe(r.transcript ?? ""), r.published_at, r.url, n(r.views),
    r.video_id, r.channel_id, csvSafe(r.channel_title), r.channel_handle ?? "", r.measured_at ?? "",
    n(r.likes), n(r.comments_count),
    n(r.channel_views_rank), n(r.channel_shorts_ranked), b(r.top_5_percent_channel), b(r.above_channel_norm), n(r.views_vs_channel_median),
    n(r.set_views_rank), n(r.set_size),
    n(r.views_prev), r.views_prev_at ?? "", n(r.views_gain), n(r.views_gain_per_day), historyToText(r.views_history),
    r.transcript_status, r.comments_status, r.comments_fetched_at ?? "", r.stats_status,
    csvSafe(commentsToText(r.top_comments_relevance)), timedToText(r.transcript_timed),
    r.transcript_timed_status, r.vision_status, csvSafe(visionToText(r.vision)),
  ];
}

/** Obiekt JSON jednego rekordu: klucze w stałej kolejności COLUMNS. */
export function jsonObject(r: ExportRecord): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of COLUMNS) o[k] = r[k];
  return o;
}

/** Pierwsza partia dostaje BOM UTF-8 i nagłówek. Końce wierszy: CRLF (RFC 4180). */
export function buildCsvBatch(records: ExportRecord[], first: boolean): string {
  let out = first ? "﻿" + COLUMNS.join(",") + "\r\n" : "";
  for (const r of records) out += csvCells(r).map(q).join(",") + "\r\n";
  return out;
}

/** Tablica JSON składana z partii: "[\n" + rekordy rozdzielone ",\n"; zamknięcie "\n]\n" dopisuje finalizacja. */
export function buildJsonBatch(records: ExportRecord[], first: boolean): string {
  const body = records.map((r) => JSON.stringify(jsonObject(r), null, 1)).join(",\n");
  return (first ? "[\n" : ",\n") + body;
}

// ------------------------------------------------------------------------------ Markdown

export const TRANSCRIPT_STATUS_PL: Record<string, string> = {
  ok: "pobrany",
  empty: "pusty (napisy bez tekstu)",
  no_captions: "brak transkryptu (film nie ma napisów)",
  error_video: "błąd filmu (niedostępny dla usługi transkrypcji)",
  error_service: "błąd usługi transkrypcji (można ponowić)",
  no_credits: "nie pobrano: wyczerpane kredyty Supadata (można ponowić)",
  pending: "nie pobrano jeszcze",
  pending_ai: "w trakcie generowania",
};
export const COMMENTS_STATUS_PL: Record<string, string> = {
  ok: "pobrane",
  disabled: "wyłączone przez autora",
  unavailable: "niedostępne dla API",
  error: "błąd usługi YouTube (można ponowić)",
  not_fetched: "nie pobrano (np. wyczerpany limit YouTube)",
  stale: "z wcześniejszego pomiaru (odświeżenie nie objęło jeszcze tej rolki)",
  not_requested: "nie zamawiano",
};

const fmtNum = (v: number | null) => (v == null ? "brak danych" : v.toLocaleString("pl-PL").replace(/ /g, " "));
const yesNo = (v: boolean | null) => (v == null ? "brak danych" : v ? "tak" : "nie");

const VISION_STATUS_PL: Record<string, string> = {
  ok: "wynik jest",
  not_analyzed: "rolka nie była analizowana pod kątem zdjęć (to nie znaczy, że zdjęć nie ma)",
  in_progress: "analiza w toku albo w kolejce",
};

function mdVision(r: ExportRecord): string[] {
  const L: string[] = ["### Zdjęcia i wiadomości w rozmowie (odczyt modelu Gemini)", ""];
  const v = r.vision;
  if (!v) {
    L.push(`(brak danych: ${VISION_STATUS_PL[r.vision_status] ?? r.vision_status})`, "");
    return L;
  }
  L.push(`Model: ${v.model ?? "?"}, fps ${v.fps}, przebieg \`${v.run_id}\`, czas wywołania ${v.api_seconds ?? "?"} s. Zdjęć wykrytych przez model: ${v.images.length}.`);
  L.push(`Uwaga: ${v.limits_pl}`);
  L.push(`Obrazy: ${v.frames.reason_pl}`, "");
  for (const im of v.images) {
    L.push(`**Zdjęcie ${im.id ?? "?"}** (wykryte przez model)`);
    L.push(`- Czas (przybliżony): ${im.first_visible ?? "?"} – ${im.last_visible ?? "?"}${im.appearances.length > 1 ? `; pojawienia: ${im.appearances.map((a) => `${a.from ?? "?"}–${a.to ?? "?"}`).join(", ")}` : ""}`);
    L.push(`- Nadawca: ${im.sent_by ?? "brak danych"}`);
    L.push(`- Opis: ${im.description_pl ?? "brak danych"}`);
    if (im.text_in_image) L.push(`- Tekst na zdjęciu: ${im.text_in_image}`);
    const ml = (a: { t: string | null; sender: string | null; text: string }[]) => (a.length ? a.map((m) => `${m.t ?? "?"} ${m.sender ?? "?"}: „${m.text}"`).join(" | ") : "brak");
    L.push(`- Wiadomości przed: ${ml(im.messages_before)}`);
    L.push(`- Wiadomości po: ${ml(im.messages_after)}`);
    if (im.related_messages.length) for (const m of im.related_messages) L.push(`- Powiązana wiadomość: ${m.t ?? "?"} ${m.sender ?? "?"}: „${m.text}" — ${m.link_status_pl}${m.reason_pl ? ` (uzasadnienie modelu: ${m.reason_pl})` : ""}`);
    else L.push("- Powiązana wiadomość: model nie wskazał żadnej");
    if (im.uncertainty_pl) L.push(`- Niepewność wg modelu: ${im.uncertainty_pl}`);
    L.push(`- Weryfikacja: ${im.verification_pl}`);
    L.push("");
  }
  if (!v.images.length) L.push("Model nie wykrył żadnego zdjęcia w rozmowie (to ocena modelu, nie dowód braku zdjęć).", "");
  if (v.unclear_ranges.length) L.push(`Przedziały, w których model słabo widział czat: ${v.unclear_ranges.map((u) => `${u.from ?? "?"}–${u.to ?? "?"} (${u.reason_pl ?? "?"})`).join("; ")}`, "");
  if (v.messages.length) {
    L.push(`Wiadomości odczytane z ekranu (model, ${v.messages.length}):`, "");
    for (const m of v.messages) L.push(`- [${m.t ?? "?"}] ${m.sender ?? "?"}: ${m.text}`);
    L.push("");
  }
  return L;
}

/** Sekcja Markdown jednej rolki. Wszystko przypisane do ID i linku; bez ocen, tylko dane. */
export function mdRecord(r: ExportRecord, pos: number): string {
  const L: string[] = [];
  L.push(`## ${pos}. ${r.title.replace(/\s*\n\s*/g, " ")}`);
  L.push("");
  L.push(`- ID: \`${r.video_id}\` | link: ${r.url}`);
  L.push(`- Kanał: ${r.channel_title}${r.channel_handle ? ` (${r.channel_handle})` : ""}, ID kanału \`${r.channel_id}\``);
  L.push(`- Publikacja: ${r.published_at} | długość: ${r.duration_seconds} s`);
  L.push(`- Pomiar statystyk: ${r.measured_at ?? "brak danych"}${r.stats_status !== "ok" ? ` (status: ${r.stats_status})` : ""}`);
  L.push(`- Wyświetlenia: ${fmtNum(r.views)} | polubienia: ${fmtNum(r.likes)} | komentarze: ${fmtNum(r.comments_count)}`);
  L.push(
    `- Ranking kanału (wśród Shortsów tego kanału): miejsce ${r.channel_views_rank ?? "brak danych"}` +
      `${r.channel_shorts_ranked != null ? ` z ${r.channel_shorts_ranked}` : ""}; TOP 5% kanału: ${yesNo(r.top_5_percent_channel)}; ` +
      `ponad normę kanału: ${yesNo(r.above_channel_norm)}; krotność mediany kanału: ${r.views_vs_channel_median ?? "brak danych"}`,
  );
  L.push(`- Ranking zestawu (wśród rolek w tym pliku): miejsce ${r.set_views_rank ?? "brak danych"}${r.set_size != null ? ` z ${r.set_size}` : ""}`);
  if (r.views_prev != null || r.views_gain != null) {
    L.push(`- Przyrost: ${r.views_gain == null ? "brak danych" : (r.views_gain >= 0 ? "+" : "") + fmtNum(r.views_gain)} od ${r.views_prev_at} (było ${fmtNum(r.views_prev)}), tempo ${r.views_gain_per_day ?? "brak danych"}/dobę`);
  } else L.push("- Przyrost: brak wcześniejszego pomiaru");
  if (r.views_history.length > 1) L.push(`- Historia wyświetleń: ${historyToText(r.views_history)}`);
  L.push(`- Transkrypt: ${TRANSCRIPT_STATUS_PL[r.transcript_status] ?? r.transcript_status} | komentarze: ${COMMENTS_STATUS_PL[r.comments_status] ?? r.comments_status}`);
  L.push("");
  L.push("### Transkrypt ze znacznikami czasu");
  L.push("");
  if (r.transcript_timed && r.transcript_timed.length) L.push(timedToText(r.transcript_timed));
  else if (r.transcript) L.push("(brak znaczników czasu; pełny tekst:)", "", r.transcript);
  else L.push(`(brak transkryptu: ${TRANSCRIPT_STATUS_PL[r.transcript_status] ?? r.transcript_status})`);
  L.push("");
  L.push(`Czasy transkryptu: ${TIMED_STATUS_PL[r.transcript_timed_status] ?? r.transcript_timed_status}`);
  L.push("");
  L.push(...mdVision(r));
  L.push("### Komentarze (do 5, kolejność trafności wg YouTube, nie wg polubień)");
  L.push("");
  if (r.top_comments_relevance && r.top_comments_relevance.length) L.push(commentsToText(r.top_comments_relevance));
  else L.push(`(brak: ${COMMENTS_STATUS_PL[r.comments_status] ?? r.comments_status})`);
  L.push("", "---", "");
  return L.join("\n");
}

/** Parser CSV zgodny z RFC 4180 (cudzysłowy, przecinki i nowe linie w polach). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { f += '"'; i++; } else inQ = false;
      } else f += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\r") { /* zjedz, \n zamknie wiersz */ }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
