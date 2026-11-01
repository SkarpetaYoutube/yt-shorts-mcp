// Rozpoznawanie zdjęć i wiadomości w rolce przez Gemini API (publiczny link YouTube, bez pobierania wideo).
// Tylko materiał źródłowy: bez ocen scenariusza. Powiązania interpretacyjne model oznacza jako "assumption".
// Zapisujemy: model, parametry, czas, status HTTP, surową odpowiedź (albo rzeczywisty błąd), zużycie i wynik. Nigdy klucza.
import { UserError } from "./types";

export const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DEFAULT_MODEL = "gemini-3.6-flash";

export const VISION_PROMPT = `You are a careful annotator producing SOURCE MATERIAL for another model. Do NOT evaluate, rate or comment on the quality of the script, story, humor or editing. Only report what is visible/audible, and clearly mark anything that is an inference.

The video is a YouTube Short in "fake text message" style: a chat conversation is shown on screen, often read aloud by voices.

TASK
1. Transcribe every chat message that appears on screen, in order of appearance, verbatim in its original language (do not translate, do not fix spelling). For each message give: first time it becomes visible (M:SS.s, best estimate to 0.1 s), sender as shown (name shown on screen, or "left bubble"/"right bubble" if no name), and the exact text.
2. Find EVERY photo/image that is part of the conversation (images sent as messages, images in bubbles, attachments, screenshots, memes, stickers that are pictures). Do NOT count: profile avatars (the small round or square profile picture of a contact, shown in the chat header or next to a name or a bubble), emoji inside text, the app UI, the background gameplay/video behind the chat. A profile avatar is NEVER an image of the conversation, even if it shows a clear face or lasts only a moment: do not list it as an image and do not describe it. Only if you cannot tell an avatar from a sent photo, include it and mark it uncertain.
   For each image give:
   - first_visible (M:SS.s) and last_visible (M:SS.s), best estimate to 0.1 s;
   - sent_by (as in point 1);
   - description_pl: a concrete, literal description IN POLISH of what is visible in the image (people, objects, text inside the image, setting, colors). No judgments;
   - text_in_image: any readable text inside the image, verbatim, or null;
   - messages_before: up to 3 messages immediately before the image (time, sender, text);
   - messages_after: up to 3 messages immediately after the image (time, sender, text);
   - related_messages: messages that refer to the image. For each: the message (time, sender, text), and "basis": either "explicit" (the message itself clearly names or points to the image, e.g. "look at this", a caption attached to the image) or "assumption" (your inference). Write the reason in Polish in "reason_pl";
   - uncertainty_pl: in Polish, anything uncertain or missing (blurry, partly covered, visible too briefly, cropped, cannot read text, possibly missed duplicates).
3. If the same image appears several times, list it once with all appearance intervals in "appearances".
4. Report frames/time ranges where you could not see the chat clearly ("unclear_ranges").

OUTPUT: valid JSON only, no markdown fences, with this shape:
{
 "video_duration_s": number|null,
 "messages": [{"t": "M:SS.s", "sender": string, "text": string}],
 "images": [{
   "id": 1, "first_visible": "M:SS.s", "last_visible": "M:SS.s",
   "appearances": [{"from": "M:SS.s", "to": "M:SS.s"}],
   "sent_by": string, "description_pl": string, "text_in_image": string|null,
   "messages_before": [{"t": "M:SS.s", "sender": string, "text": string}],
   "messages_after": [{"t": "M:SS.s", "sender": string, "text": string}],
   "related_messages": [{"t": "M:SS.s", "sender": string, "text": string, "basis": "explicit"|"assumption", "reason_pl": string}],
   "uncertainty_pl": string|null
 }],
 "no_images_found": boolean,
 "unclear_ranges": [{"from": "M:SS.s", "to": "M:SS.s", "reason_pl": string}],
 "notes_pl": string|null
}`;

export type VisStatus = "pending" | "running" | "ok" | "invalid_output" | "error" | "not_configured" | "cancelled";

export interface VisRecord {
  id: string;
  video_id: string;
  video_url: string;
  fps: number;
  model_requested: string;
  status: VisStatus;
  http_status: number | null;
  seconds: number | null;
  model_version: string | null;
  finish_reason: string | null;
  usage: any;
  /** surowa odpowiedź API (tekst) albo treść rzeczywistego błędu; nie zawiera klucza */
  raw: string | null;
  parsed: any;
  parse_error: string | null;
  error: string | null;
  params: Record<string, unknown>;
  created: number;
  done_at: number | null;
  // kolejka (rekordy sprzed kolejki nie mają tych pól)
  batch_id?: string | null;
  /** numer próby dla tej rolki i fps (1 = pierwsza); każda próba to osobne wywołanie liczone do limitu dziennego */
  attempt?: number;
  max_attempts?: number;
  /** nie wcześniej niż (ms od epoki): odstęp przed ponowieniem */
  next_at?: number;
  started_at?: number | null;
  retry_of?: string | null;
  retry_scheduled?: string | null;
  /** wskazówka z odpowiedzi API (Retry-After / RetryInfo), ms */
  retry_after_ms?: number | null;
  /** z treści błędu Google (QuotaFailure): jaki limit przekroczono; scope: day/minute/unknown (tylko to, co wynika z treści) */
  quota?: { ids: string[]; scope: "day" | "minute" | "unknown" } | null;
}

/** Wyciąga z treści błędu 429 nazwy przekroczonych limitów; zakres („na dobę”/„na minutę”) tylko jeśli wynika z nazwy limitu. */
export function quotaInfo(body: any): { ids: string[]; scope: "day" | "minute" | "unknown" } | null {
  const ids: string[] = [];
  for (const d of body?.error?.details ?? []) {
    for (const v of d?.violations ?? []) {
      for (const k of [v?.quotaId, v?.quotaMetric]) if (typeof k === "string" && k && !ids.includes(k)) ids.push(k);
    }
  }
  if (!ids.length) return null;
  const all = ids.join(" ");
  const scope = /PerDay|per_day|daily/i.test(all) ? "day" : /PerMinute|per_minute/i.test(all) ? "minute" : "unknown";
  return { ids, scope };
}

/** Błędy przejściowe, które warto ponowić; 400/401/403/404 (zły klucz, model, parametr) nie są ponawiane. */
export function isRetryable(rec: Pick<VisRecord, "status" | "http_status">): boolean {
  if (rec.status === "invalid_output") return true;
  if (rec.status !== "error") return false;
  if (rec.http_status == null) return true; // błąd połączenia / timeout po naszej stronie
  return [408, 429, 500, 502, 503, 504, 524].includes(rec.http_status);
}

/** "23s" / "1.5s" z google.rpc.RetryInfo → ms (null, gdy brak). */
export function retryDelayMs(body: any, headerValue: string | null): number | null {
  const h = headerValue != null ? Number(headerValue) : NaN;
  if (Number.isFinite(h) && h >= 0) return Math.round(h * 1000);
  for (const d of body?.error?.details ?? []) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d?.retryDelay ?? ""));
    if (m) return Math.round(Number(m[1]) * 1000);
  }
  return null;
}

export function videoIdFrom(ref: string): string {
  const m = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/.exec(ref) ?? (/^[A-Za-z0-9_-]{11}$/.test(ref.trim()) ? [ref, ref.trim()] : null);
  if (!m) throw new UserError("Podaj link do filmu YouTube lub 11-znakowe ID.");
  return m[1];
}

export function geminiBody(videoUrl: string, fps: number): unknown {
  return {
    contents: [{ parts: [{ fileData: { fileUri: videoUrl }, videoMetadata: { fps } }, { text: VISION_PROMPT }] }],
    generationConfig: { responseMimeType: "application/json" },
  };
}

/** Wykonuje jedno zapytanie i wypełnia rekord. Błędy API zapisuje dosłownie (bez klucza) – próba nie jest wtedy „udana”. */
export async function runGemini(rec: VisRecord, apiKey: string, doFetch: (u: string, i: RequestInit) => Promise<Response>, timeoutMs = 300_000): Promise<void> {
  const url = `${GEMINI_API}/models/${encodeURIComponent(rec.model_requested)}:generateContent`;
  const started = Date.now();
  let resp: Response;
  try {
    resp = await doFetch(url, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(geminiBody(rec.video_url, rec.fps)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    rec.status = "error";
    rec.error = `Błąd połączenia z Gemini API (${(e as Error)?.name}: ${String((e as Error)?.message ?? "").slice(0, 300)})`;
    rec.seconds = Math.round((Date.now() - started) / 100) / 10;
    rec.done_at = Date.now();
    return;
  }
  const raw = await resp.text().catch(() => "");
  rec.http_status = resp.status;
  const retryHeader = resp.headers.get("retry-after");
  rec.seconds = Math.round((Date.now() - started) / 100) / 10;
  rec.raw = raw.split(apiKey).join("[ukryte]").slice(0, 1_000_000);
  rec.done_at = Date.now();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* odpowiedź nie-JSON */
  }
  if (resp.status !== 200) {
    rec.status = "error";
    // pełna treść błędu (bez klucza): komunikat + szczegóły; ta sama treść jest też w raw
    rec.error = `HTTP ${resp.status}${retryHeader != null ? ` (nagłówek Retry-After: ${retryHeader})` : ""}: ${raw.split(apiKey).join("[ukryte]").slice(0, 4000)}`;
    rec.retry_after_ms = retryDelayMs(body, retryHeader);
    rec.quota = quotaInfo(body);
    return;
  }
  rec.usage = body?.usageMetadata ?? null;
  rec.model_version = body?.modelVersion ?? null;
  const cand = body?.candidates?.[0];
  rec.finish_reason = cand?.finishReason ?? null;
  const text = (cand?.content?.parts ?? []).map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
  if (!text) {
    rec.status = "invalid_output";
    rec.error = `Brak tekstu w odpowiedzi (finishReason: ${rec.finish_reason ?? "brak"}; promptFeedback: ${JSON.stringify(body?.promptFeedback ?? null).slice(0, 300)})`;
    return;
  }
  try {
    rec.parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    rec.status = Array.isArray(rec.parsed?.images) && Array.isArray(rec.parsed?.messages) ? "ok" : "invalid_output";
    if (rec.status !== "ok") rec.error = "Odpowiedź nie ma wymaganych pól images/messages."; else flagAvatars(rec.parsed);
  } catch (e) {
    rec.status = "invalid_output";
    rec.parse_error = String((e as Error).message).slice(0, 300);
    rec.error = "Odpowiedź modelu nie jest poprawnym JSON (zapisana w raw).";
  }
}

// Model czasem wpisuje awatar z nagłówka czatu jako zdjęcie, choć prompt tego zabrania, i sam to zaznacza w opisie lub niepewności (np. „Avatar w nagłówku czatu”).
// Wzorzec jest wąski (awatar/zdjęcie profilowe + nagłówek/czat/kontakt w jednym zdaniu): zwykłe zdjęcie przedstawiające czyjś profil nie jest oznaczane.
const AVATAR_RE = /(?:avatar|awatar|zdj[ęe]cie profilowe|profile (?:picture|photo|pic))[^.]{0,80}(?:nag[łl][óo]wk|header|czat|kontakt)|(?:nag[łl][óo]wk|header)[^.]{0,60}(?:avatar|awatar|zdj[ęe]cie profilowe|profile (?:picture|photo|pic))/i;

const AVATAR_START_RE = /^\s*(?:zdj[ęe]cie profilowe|awatar|avatar)\b/i;

/** Oznacza (nie usuwa) zdjęcia, które model sam opisał jako awatar z nagłówka czatu: im.likely_avatar = true. Zwraca liczbę oznaczonych. */
export function flagAvatars(parsed: any): number {
  let n = 0;
  for (const im of Array.isArray(parsed?.images) ? parsed.images : []) {
    // model lite opisuje awatar wprost („Zdjęcie profilowe lub wideo…”) bez wzmianki o nagłówku: opis zaczynający się od awatara/zdjęcia profilowego też oznaczamy
    if (im && typeof im === "object" && (AVATAR_RE.test(String(im.uncertainty_pl ?? "")) || AVATAR_RE.test(String(im.description_pl ?? "")) || AVATAR_START_RE.test(String(im.description_pl ?? "")))) { im.likely_avatar = true; n++; }
  }
  return n;
}

/** "M:SS.s" → sekundy (null, gdy nie da się odczytać). */
export function tsec(t: unknown): number | null {
  if (typeof t === "number") return t;
  if (typeof t !== "string") return null;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t.trim());
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

const norm = (s: unknown) => String(s ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Porównanie dwóch przebiegów (np. 1 i 5 fps): które zdjęcia i wiadomości wykryto w obu, a które tylko w jednym.
 * Mechaniczne dopasowanie: zdjęcia po czasie pierwszego pojawienia się (±tol s), wiadomości po znormalizowanym tekście.
 * To nie jest dowód skuteczności – brak w obu przebiegach nie jest wykrywany bez ręcznie sprawdzonego wzorca.
 */
export function compareRuns(a: any, b: any, tol = 1.5) {
  const ia: any[] = a?.images ?? [], ib: any[] = b?.images ?? [];
  const used = new Set<number>();
  const both: any[] = [], onlyA: any[] = [];
  for (const x of ia) {
    const tx = tsec(x.first_visible);
    let best = -1, bd = Infinity;
    ib.forEach((y, j) => {
      if (used.has(j)) return;
      const ty = tsec(y.first_visible);
      if (tx == null || ty == null) return;
      const d = Math.abs(tx - ty);
      if (d <= tol && d < bd) { bd = d; best = j; }
    });
    if (best >= 0) {
      used.add(best);
      both.push({ a: { t: x.first_visible, description_pl: x.description_pl }, b: { t: ib[best].first_visible, description_pl: ib[best].description_pl } });
    } else onlyA.push({ t: x.first_visible, description_pl: x.description_pl });
  }
  const onlyB = ib.filter((_, j) => !used.has(j)).map((y) => ({ t: y.first_visible, description_pl: y.description_pl }));
  const ma = new Map((a?.messages ?? []).map((m: any) => [norm(m.text), m]));
  const mb = new Map((b?.messages ?? []).map((m: any) => [norm(m.text), m]));
  const mOnlyA = [...ma.entries()].filter(([k]) => k && !mb.has(k)).map(([, m]: any) => ({ t: m.t, sender: m.sender, text: m.text }));
  const mOnlyB = [...mb.entries()].filter(([k]) => k && !ma.has(k)).map(([, m]: any) => ({ t: m.t, sender: m.sender, text: m.text }));
  return {
    method: `zdjęcia dopasowane po czasie pierwszego pojawienia się (±${tol} s), wiadomości po tekście (bez wielkości liter i interpunkcji)`,
    images: { a_count: ia.length, b_count: ib.length, in_both: both, only_in_a: onlyA, only_in_b: onlyB },
    messages: { a_count: ma.size, b_count: mb.size, only_in_a: mOnlyA, only_in_b: mOnlyB },
    caveat: "Porównanie pokazuje różnice między przebiegami, nie skuteczność. Zdjęcia pominięte w obu przebiegach wykaże dopiero ręcznie sprawdzony zestaw.",
  };
}

/** Czytelny opis jednego przebiegu (Markdown). Powiązania typu assumption oznaczone jako przypuszczenia. */
export function visToMarkdown(rec: VisRecord): string {
  const L: string[] = [];
  L.push(`# Zdjęcia w rozmowie: ${rec.video_url}`, "");
  L.push(`- ID rolki: \`${rec.video_id}\` | model: ${rec.model_requested}${rec.model_version ? ` (${rec.model_version})` : ""} | fps: ${rec.fps}`);
  L.push(`- Status: ${rec.status}${rec.http_status != null ? ` (HTTP ${rec.http_status})` : ""}; czas zapytania: ${rec.seconds ?? "?"} s`);
  if (rec.error) L.push(`- Błąd: ${rec.error}`);
  L.push("- Materiał źródłowy wygenerowany przez model (Gemini), bez ocen scenariusza. Czasy są szacunkami modelu.", "");
  const p = rec.parsed;
  if (!p) return L.join("\n") + "\n(brak wyniku do pokazania: obraz nie został przeanalizowany)\n";
  const msg = (m: any) => `[${m.t ?? "?"}] ${m.sender ?? "?"}: ${m.text ?? ""}`;
  if (!p.images?.length) L.push(p.no_images_found ? "**Nie wykryto zdjęć w rozmowie** (obraz przeanalizowany)." : "Brak zdjęć na liście.", "");
  for (const im of p.images ?? []) {
    L.push(`## Zdjęcie ${im.id ?? "?"}: ${im.first_visible ?? "?"}–${im.last_visible ?? "?"}`, "");
    if (Array.isArray(im.appearances) && im.appearances.length > 1) L.push(`- Wystąpienia: ${im.appearances.map((a: any) => `${a.from}–${a.to}`).join(", ")}`);
    L.push(`- Wysłał(a): ${im.sent_by ?? "?"}`);
    L.push(`- Widoczna treść: ${im.description_pl ?? "?"}`);
    if (im.text_in_image) L.push(`- Tekst na zdjęciu: ${im.text_in_image}`);
    L.push(`- Wiadomości przed: ${(im.messages_before ?? []).map(msg).join(" | ") || "brak"}`);
    L.push(`- Wiadomości po: ${(im.messages_after ?? []).map(msg).join(" | ") || "brak"}`);
    for (const r of im.related_messages ?? []) {
      const kind = r.basis === "explicit" ? "wprost (z ekranu)" : "PRZYPUSZCZENIE";
      L.push(`- Odnosi się do zdjęcia – ${kind}: ${msg(r)}${r.reason_pl ? ` (uzasadnienie: ${r.reason_pl})` : ""}`);
    }
    L.push(`- Niepewność / brakujący kontekst: ${im.uncertainty_pl ?? "nie zgłoszono"}`, "");
  }
  if (p.unclear_ranges?.length) L.push("## Fragmenty niewyraźne", "", ...p.unclear_ranges.map((u: any) => `- ${u.from}–${u.to}: ${u.reason_pl ?? ""}`), "");
  L.push("## Wiadomości odczytane z ekranu", "", ...(p.messages ?? []).map(msg), "");
  if (p.notes_pl) L.push(`Uwagi modelu: ${p.notes_pl}`, "");
  return L.join("\n");
}
