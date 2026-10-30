import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Store } from "./store";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  STORE: DurableObjectNamespace<Store>;
  // sekrety (wrangler secret put)
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SIGNING_KEY: string; // min. 32 znaki: podpisuje linki do eksportów
  YOUTUBE_API_KEY: string;
  SUPADATA_API_KEY: string;
  ALLOWED_GITHUB_USERS: string; // login lub numeryczne ID GitHub, po przecinku
  // opcjonalne zmienne (wrangler vars)
  YT_DAILY_UNIT_BUDGET?: string;
  SUPADATA_DAILY_CREDIT_BUDGET?: string;
  COLLECT_MAX_COUNT?: string;
  COLLECT_MAX_HISTORY?: string;
  COLLECT_RETENTION_DAYS?: string;
  TRANSCRIPT_CACHE_DAYS?: string;
  // Gemini (rozpoznawanie zdjęć w rolkach): klucz jako sekret w Cloudflare; bez klucza funkcja jest wyłączona
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_DAILY_CALLS?: string; // bezpiecznik: maks. wywołań Gemini na dobę UTC, każde ponowienie się liczy (domyślnie 250)
  GEMINI_CONCURRENCY?: string; // równoległe wywołania (domyślnie 2, maks. 4)
  GEMINI_MIN_START_INTERVAL_MS?: string; // najkrótszy odstęp między startami wywołań (domyślnie 10000): zachowawcze tempo własne, nie limit Google
  GEMINI_TPM_LIMIT?: string; // opcjonalnie: limit tokenów/min z panelu AI Studio; bez wartości serwer nie zgaduje i opiera się na odpowiedziach 429
  GEMINI_MAX_ATTEMPTS?: string; // prób na rolkę (domyślnie 4)
  GEMINI_MODEL_LIMITS?: string; // JSON {"model":{"rpm":..,"tpm":..,"rpd":..}} z AI Studio → Rate limit (Twój projekt); egzekwowane także przy ponowieniach
  GEMINI_CANCEL_BATCHES?: string; // batch_id po przecinku: oczekujące przebiegi tych partii są anulowane przy najbliższym alarmie
  GEMINI_RETRY_DELAYS_S?: string; // odstępy przed kolejnymi próbami w sekundach (domyślnie "30,120,300")
  EXPORT_LINK_TTL_SECONDS?: string;
  ALLOWED_REDIRECT_URIS?: string;
  // dostrajanie tempa (testy ustawiają 0)
  YT_DELAY_MS?: string;
  SD_MIN_INTERVAL_MS?: string;
  SD_ITEM_DELAY_MS?: string;
  STEP_ITEMS?: string;
  ALARM_DELAY_MS?: string;
}

export interface Props extends Record<string, unknown> {
  login: string;
  id: string;
}

/** Błąd z komunikatem bezpiecznym dla użytkownika (trafia do Claude). */
export class UserError extends Error {}
/** Przerywa krok zadania, ale zadanie można wznowić (limit, klucz, kredyty). */
export class PauseError extends UserError {}
