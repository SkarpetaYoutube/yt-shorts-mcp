// Warstwa MCP: niskopoziomowy Server z oficjalnego SDK + bezstanowy transport Streamable HTTP.
import { SERVER_VERSION } from "./constants";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { UE_PREFIX, type Store } from "./store";
import { SubrequestBudget } from "./clients";
import { UserError, type Env, type Props } from "./types";
import { hmacHex, sleep } from "./util";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const jobId = { type: "string", description: "job_id zwrócone przez collect_shorts" };

export const TOOLS = [
  {
    name: "collect_shorts",
    description:
      "Rozpoczyna zbieranie Shortsów z kanału YouTube (1-500) i wraca od razu. Praca toczy się na serwerze w tle, z zapisem postępu. " +
      "Rekord: title, duration_seconds, transcript (pełna, w oryginalnym języku), published_at, url, views, likes, comments_count, " +
      "transkrypcja ze znacznikami czasu, do 5 komentarzy w kolejności trafności YouTube (nie wg polubień), pozycja wśród Shortsów kanału " +
      "(TOP 5%, ponad normę = >= 2 × mediana kanału; liczone z całkowitych wyświetleń, bez uwzględnienia wieku publikacji) i przyrost wyświetleń od poprzedniego pomiaru. " +
      "Domyślnie po wybraniu filmów zadanie zatrzymuje się z szacunkiem kosztów (pole estimate: ile transkrypcji jest już zapisanych, ile kredytów Supadata zużyje) " +
      "i czeka na continue_collection. Następnie wywołuj continue_collection (z wait_seconds), aż complete=true, i dopiero wtedy export_collection.",
    inputSchema: obj(
      {
        channel: { type: "string", description: "@handle, URL kanału, ID kanału (UC...)" },
        mode: { type: "string", enum: ["newest", "oldest", "most_viewed"], default: "newest" },
        count: { type: "integer", minimum: 1, maximum: 500, description: "Ile Shortsów (1-500)" },
        transcript_mode: { type: "string", enum: ["native", "auto"], default: "native", description: "native = tylko istniejące napisy (1 kredyt Supadata/film); auto = także generowanie AI (droższe)" },
        lang: { type: "string", description: "Kod języka transkrypcji; pominięty = język oryginalny" },
        comments: { type: "boolean", default: true, description: "Pobierz do 5 komentarzy na film (kolejność trafności YouTube). Koszt: 1 jednostka YouTube API na film." },
        channel_stats: {
          type: "boolean", default: true,
          description: "Przejrzyj całą historię Shortsów kanału, by policzyć normę kanału (mediana, 95. percentyl, pozycja). Przy newest kosztuje kilka jednostek YouTube więcej.",
        },
        estimate_first: { type: "boolean", default: true, description: "Zatrzymaj się po wyborze filmów i pokaż przewidywane zużycie kredytów (z uwzględnieniem zapisanych transkrypcji)." },
      },
      ["channel", "count"],
    ),
  },
  {
    name: "continue_collection",
    description:
      "Wznawia zadanie (także po szacunku kosztów) i opcjonalnie czeka do wait_seconds (maks. 25) na postęp. Ponawia tylko brakujące elementy: " +
      "filmy niepobrane z powodu wyczerpanych kredytów (no_credits) i niepobrane komentarze; gotowych transkrypcji nie pobiera drugi raz.",
    inputSchema: obj({
      job_id: jobId,
      wait_seconds: { type: "integer", minimum: 0, maximum: 25, default: 20 },
      retry_failed: { type: "boolean", default: false, description: "Ponów też nieudane: error_service, error_video i komentarze ze statusem error" },
      transcript_mode: { type: "string", enum: ["native", "auto"], description: "Zmień tryb; auto ponowi też filmy bez napisów" },
    }, ["job_id"]),
  },
  { name: "get_collection_status", description: "Status zadania: postęp, problemy (brak napisów, błędy), przyczyna zatrzymania.", inputSchema: obj({ job_id: jobId }, ["job_id"]) },
  { name: "list_collections", description: "Lista ostatnich zadań zbierania.", inputSchema: obj({ limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } }) },
  {
    name: "refresh_stats",
    description:
      "Odświeża wyłącznie statystyki (wyświetlenia, polubienia, liczba komentarzy, norma i ranking kanału) i opcjonalnie komentarze zakończonego zadania. " +
      "NIE pobiera transkrypcji (0 kredytów Supadata). Każdy pomiar trafia do historii przyrostów. Potem continue_collection/get_collection_status, następnie export_collection.",
    inputSchema: obj({
      job_id: jobId,
      comments: { type: "boolean", default: true, description: "Pobierz komentarze od nowa (1 jednostka YouTube na film)" },
      channel_stats: { type: "boolean", description: "Przelicz normę i ranking kanału (przegląd całej historii kanału). Domyślnie jak w zadaniu." },
    }, ["job_id"]),
  },
  {
    name: "export_collection",
    description:
      "Buduje paczkę dla modelu z jednego zadania (job_id) albo wspólny zestaw z wielu kanałów (job_ids): CSV, JSON i czytelny Markdown " +
      "(transkrypty ze znacznikami czasu albo jawny status ich braku, metadane, statystyki, komentarze, wyniki analizy zdjęć Gemini jako ocena modelu, jeśli rolkę analizowano; wszystko przypisane do ID i linku rolki; duże zestawy dzielone na części bez cięcia rolki). " +
      "Duplikaty (ta sama rolka w kilku zadaniach) są usuwane. Ranking kanału i ranking zestawu są osobnymi polami. Filtry i sortowanie opcjonalne. " +
      "Zwraca podpisane linki, sumy SHA-256 i link manifest (lista wszystkich plików do pobrania jednym skryptem). Nie zwraca treści w odpowiedzi.",
    inputSchema: obj({
      job_id: jobId,
      read_file: { type: "string", description: "Zamiast budować eksport: odczytaj plik gotowego zestawu (json, csv, status, md-1…) przez to narzędzie; wymaga set_id; dłuższe pliki porcjami (cursor, max_chars)" },
      set_id: { type: "string", description: "Zestaw z poprzedniego eksportu (dla read_file)" },
      cursor: { type: "integer", description: "Pozycja znaku, od której czytać (read_file)" },
      max_chars: { type: "integer", description: "Maks. znaków w jednej odpowiedzi (read_file, domyślnie 60000)" },
      job_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20, description: "Kilka zadań (np. różne kanały) w jednym zestawie" },
      sort_by: {
        type: "string",
        enum: ["selection", "views", "likes", "comments_count", "published_at", "duration_seconds", "views_vs_channel_median", "views_gain", "channel_views_rank"],
        default: "selection",
      },
      sort_dir: { type: "string", enum: ["asc", "desc"], default: "desc", description: "Dla selection domyślnie kolejność wyboru (asc)" },
      sort: { type: "string", enum: ["selection", "views_desc", "views_asc"], description: "Skrót zgodny z poprzednią wersją" },
      filters: obj({
        channel: { type: "string", description: "@handle, ID kanału lub fragment nazwy" },
        published_from: { type: "string", description: "YYYY-MM-DD (UTC)" },
        published_to: { type: "string", description: "YYYY-MM-DD (UTC, włącznie)" },
        min_duration: { type: "number" }, max_duration: { type: "number" },
        min_views: { type: "number" }, max_views: { type: "number" },
        min_likes: { type: "number" }, max_likes: { type: "number" },
        min_median_ratio: { type: "number", description: "Wyświetlenia / mediana kanału, np. 2 = co najmniej 2 × mediana" },
        max_median_ratio: { type: "number" },
        text: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "Fraza albo lista fraz (wystarczy jedna), wielkość liter bez znaczenia" },
        text_in: { type: "string", enum: ["title", "transcript", "both"], default: "both" },
      }),
      md_part_chars: { type: "integer", minimum: 20000, maximum: 1000000, default: 180000, description: "Maks. znaków na część Markdown (rolka nigdy nie jest cięta)" },
      label: { type: "string", description: "Nazwa zestawu w nagłówku paczki" },
      allow_partial: { type: "boolean", default: false, description: "Eksport także niezakończonych zadań (oznaczony jako częściowy)" },
      wait_seconds: { type: "integer", minimum: 0, maximum: 25, default: 20 },
    }),
  },
  {
    name: "read_collection",
    description: "Czyta zapisane rekordy porcjami (max_chars) – tylko gdy trzeba zobaczyć treść w rozmowie. Długie transkrypcje są dzielone, nic nie jest skracane; użyj next_cursor.",
    inputSchema: obj({ job_id: jobId, cursor: { type: "string" }, max_chars: { type: "integer", minimum: 5000, maximum: 80000, default: 30000 } }, ["job_id"]),
  },
  {
    name: "get_transcript",
    description: "Pełna transkrypcja jednego filmu (kawałkami przez offset/limit). Dla wielu filmów używaj collect_shorts.",
    inputSchema: obj({
      video: { type: "string", description: "Link do filmu lub 11-znakowe ID" },
      lang: { type: "string" },
      mode: { type: "string", enum: ["native", "auto"], default: "native" },
      offset: { type: "integer", minimum: 0, default: 0 },
      limit: { type: "integer", minimum: 1000, maximum: 60000, default: 30000 },
      job_id: { type: "string", description: "job_id Supadata, gdy poprzednia odpowiedź była pending" },
    }, ["video"]),
  },
  {
    name: "analyze_images",
    description:
      "Kolejka rozpoznawania zdjęć i wiadomości w rolkach przez Gemini API z publicznych linków YouTube (bez pobierania wideo). " +
      "Jedna rolka (video), wiele (videos, do 200) albo WSZYSTKIE rolki zadania (job_id): wtedy domyślnie tylko szacunek (estimate_only=true: ile wywołań, ile limitu zostało, ile dni, przybliżony czas i tokeny; nic nie jest zlecane), " +
      "a po estimate_only=false rolki z gotowym wynikiem lub już w kolejce są pomijane (skip_done=true). Domyślnie jeden przebieg na rolkę (fps 1). Kolejka ma ograniczoną równoległość, odstępy między startami " +
      "i sama ponawia błędy przejściowe (503, 429, 524, połączenie); każde wywołanie, także ponowienie, liczy się do limitu dziennego. " +
      "retry_batch: ponawia tylko nieudane rolki z podanej partii. Wynik to materiał źródłowy (czasy przybliżone), bez ocen scenariusza i bez plików obrazów. Praca w tle: potem get_image_analysis.",
    inputSchema: obj({
      video: { type: "string", description: "Link do rolki lub 11-znakowe ID" },
      videos: { type: "array", items: { type: "string" }, maxItems: 200, description: "Wiele rolek (linki lub ID)" },
      job_id: { type: "string", description: "Zamiast video/videos: wszystkie rolki tego zadania (job_id z collect_shorts). Domyślnie tylko szacunek." },
      estimate_only: { type: "boolean", default: true, description: "Tylko z job_id: true = pokaż szacunek i nic nie zlecaj; false = zleć analizę rolek bez wyniku" },
      skip_done: { type: "boolean", default: true, description: "Tylko z job_id: pomiń rolki, które mają już udany wynik dla tego fps (false = analizuj ponownie, zużywa limit)" },
      fps: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 4, default: [1], description: "Częstotliwości próbkowania (klatek/s)" },
      model: { type: "string", description: "Model Gemini (domyślnie gemini-3.6-flash)" },
      retry_batch: { type: "string", description: "batch_id: ponów tylko nieudane rolki tej partii" },
      cancel_batch: { type: "string", description: "batch_id (lub lista po przecinku): anuluj oczekujące przebiegi partii; trwające wywołania kończą się normalnie" },
    }),
  },
  {
    name: "get_image_analysis",
    description:
      "Wyniki analyze_images: dla rolki (video) status każdego przebiegu i prób (także rzeczywisty błąd API), model, fps, zużycie, zdjęcia, linki do surowej odpowiedzi (json) i opisu (md); " +
      "dla partii (batch_id) jedna tabela: rolka, status, liczba prób, czas, zużycie, liczba zdjęć, czas całej partii.",
    inputSchema: obj({ video: { type: "string", description: "Link do rolki lub ID" }, batch_id: { type: "string", description: "Partia z analyze_images" } }),
  },
  { name: "resolve_channel", description: "Sprawdza kanał (handle/URL/ID) bez zbierania filmów.", inputSchema: obj({ channel: { type: "string" } }, ["channel"]) },
  { name: "get_usage", description: "Dzisiejsze zużycie limitów API liczone przez ten serwer (YouTube units, kredyty Supadata) i bezpieczniki.", inputSchema: obj({}) },
];

/** Ostatnia linia obrony: wartości sekretów nigdy nie trafią do odpowiedzi, nawet jeśli zewnętrzne API je odbije w błędzie. */
export function redact(env: Env, msg: string): string {
  let out = msg;
  for (const v of [env.YOUTUBE_API_KEY, env.SUPADATA_API_KEY, env.GITHUB_CLIENT_SECRET, env.SIGNING_KEY, env.GEMINI_API_KEY]) if (v && v.length >= 8) out = out.split(v).join("[ukryte]");
  return out;
}

const text = (v: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }], isError });

export async function signExport(env: Env, origin: string, job: string, fmt: string, ttlSeconds?: number): Promise<string> {
  const ttl = ttlSeconds ?? (Number(env.EXPORT_LINK_TTL_SECONDS) || 3600);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = await hmacHex(env.SIGNING_KEY, `${job}|${fmt}|${exp}`);
  return `${origin}/exports/${job}/${fmt}?exp=${exp}&sig=${sig}`;
}

export function createMcpServer(env: Env, origin: string, props: Props | undefined): Server {
  const server = new Server({ name: "yt-shorts-mcp", version: SERVER_VERSION }, { capabilities: { tools: {} } });
  const store = (): DurableObjectStub<Store> => env.STORE.get(env.STORE.idFromName("main"));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const a = (req.params.arguments ?? {}) as Record<string, any>;
    try {
      return text(await dispatch(env, origin, store(), name, a, props));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (e instanceof UserError) return text({ ok: false, error: redact(env, e.message) }, true);
      if (msg.startsWith(UE_PREFIX)) return text({ ok: false, error: redact(env, msg.slice(UE_PREFIX.length)) }, true);
      if (e instanceof SubrequestBudget) return text({ ok: false, error: "Chwilowy limit zapytań serwera. Spróbuj ponownie za chwilę." }, true);
      console.error("Błąd narzędzia", name, (e as Error)?.name);
      return text({ ok: false, error: "Wewnętrzny błąd serwera. Spróbuj ponownie." }, true);
    }
  });
  return server;
}

const str = (v: unknown, field: string, req = true): string | null => {
  if (v == null || v === "") {
    if (req) throw new UserError(`Brak parametru ${field}.`);
    return null;
  }
  if (typeof v !== "string") throw new UserError(`Parametr ${field} musi być tekstem.`);
  return v;
};
const int = (v: unknown, field: string, d: number): number => {
  if (v == null) return d;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new UserError(`Parametr ${field} musi być liczbą.`);
  return Math.trunc(v);
};
const oneOf = <T extends string>(v: unknown, field: string, allowed: readonly T[], d: T): T => {
  if (v == null) return d;
  if (!allowed.includes(v as T)) throw new UserError(`Parametr ${field}: dozwolone ${allowed.join(", ")}.`);
  return v as T;
};

async function waitFor<T>(seconds: number, get: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = Date.now() + Math.max(0, Math.min(seconds, 25)) * 1000;
  let cur = await get();
  while (!done(cur) && Date.now() < end) {
    await sleep(2000);
    cur = await get();
  }
  return cur;
}

export async function dispatch(env: Env, origin: string, st: any, name: string, a: Record<string, any>, _props?: Props): Promise<unknown> {
  switch (name) {
    case "collect_shorts": {
      const r = await st.startJob({
        channel: str(a.channel, "channel")!,
        mode: oneOf(a.mode, "mode", ["newest", "oldest", "most_viewed"] as const, "newest"),
        count: int(a.count, "count", NaN),
        transcriptMode: oneOf(a.transcript_mode, "transcript_mode", ["native", "auto"] as const, "native"),
        lang: str(a.lang, "lang", false),
        comments: a.comments !== false,
        channelStats: a.channel_stats !== false,
        estimateFirst: a.estimate_first !== false,
      });
      return r;
    }
    case "continue_collection": {
      const id = str(a.job_id, "job_id")!;
      const tm = a.transcript_mode == null ? null : oneOf(a.transcript_mode, "transcript_mode", ["native", "auto"] as const, "native");
      await st.resume(id, { retryFailed: a.retry_failed === true, transcriptMode: tm });
      return await waitFor(int(a.wait_seconds, "wait_seconds", 20), () => st.status(id), (s: any) => s.complete || !s.running);
    }
    case "get_collection_status":
      return await st.status(str(a.job_id, "job_id")!);
    case "list_collections":
      return await st.list(int(a.limit, "limit", 10));
    case "read_collection":
      return await st.read(str(a.job_id, "job_id")!, str(a.cursor, "cursor", false), int(a.max_chars, "max_chars", 30000));
    case "get_transcript":
      return await st.singleTranscript({
        ref: str(a.video, "video")!,
        lang: str(a.lang, "lang", false),
        mode: oneOf(a.mode, "mode", ["native", "auto"] as const, "native"),
        offset: int(a.offset, "offset", 0),
        limit: int(a.limit, "limit", 30000),
        jobId: str(a.job_id, "job_id", false),
      });
    case "resolve_channel":
      return await st.resolve(str(a.channel, "channel")!);
    case "get_usage":
      return await st.usage();
    case "analyze_images": {
      // Klient może przesłać listę jako tekst (np. "[1]" albo "ID1,ID2") — akceptujemy oba kształty.
      const asList = (v: unknown): unknown[] | undefined => {
        if (v == null) return undefined;
        if (Array.isArray(v)) return v;
        if (typeof v === "string") {
          const t = v.trim();
          if (t.startsWith("[")) { try { const j = JSON.parse(t); if (Array.isArray(j)) return j; } catch { /* dalej */ } }
          return t.split(/[\s,;]+/).filter(Boolean);
        }
        return [v];
      };
      const fpsRaw = asList(a.fps);
      const fps = fpsRaw == null ? [1] : fpsRaw.map((x: unknown) => { const n = typeof x === "string" ? Number(x) : x; if (typeof n !== "number" || !isFinite(n)) throw new UserError("fps: liczby."); return n; });
      const videosRaw = asList(a.videos);
      const videos = videosRaw?.map((x: unknown) => str(x, "videos")!);
      for (const k of ["estimate_only", "skip_done"]) if (a[k] != null && typeof a[k] !== "boolean") throw new UserError(k + ": true albo false.");
      return await st.startVision({
        video: str(a.video, "video", false) ?? undefined, videos, fps, model: str(a.model, "model", false), retryBatch: str(a.retry_batch, "retry_batch", false), cancelBatch: str(a.cancel_batch, "cancel_batch", false),
        jobId: str(a.job_id, "job_id", false), estimateOnly: a.estimate_only !== false, skipDone: a.skip_done !== false,
      });
    }
    case "get_image_analysis": {
      const batch = str(a.batch_id, "batch_id", false);
      if (batch) return await st.visionBatch(batch);
      const r = await st.visionStatus(str(a.video, "video")!);
      for (const run of r.runs) {
        if (run.status === "pending" || run.status === "running") continue;
        run.links = { raw_json: await signExport(env, origin, run.id, "json"), readable_md: await signExport(env, origin, run.id, "md") };
      }
      return r;
    }
    case "refresh_stats": {
      const id = str(a.job_id, "job_id")!;
      if (a.channel_stats != null && typeof a.channel_stats !== "boolean") throw new UserError("channel_stats: true albo false.");
      return await st.refresh(id, { comments: a.comments !== false, channelStats: a.channel_stats ?? null });
    }
    case "export_collection": {
      // odczyt gotowego pliku eksportu przez to samo narzędzie (linki do plików bywają niedostępne z sesji Claude): set_id + read_file
      if (a.read_file != null) {
        const fmt = String(a.read_file);
        if (!/^(json|csv|status|md-\d{1,3})$/.test(fmt)) throw new UserError("Parametr read_file: dozwolone json, csv, status, md-1, md-2, … (kolejne części paczki Markdown).");
        const setId = str(a.set_id, "set_id");
        const chunks = await st.exportChunks(setId!, fmt);
        if (!chunks) throw new UserError("Nie ma takiego pliku eksportu (zły set_id/read_file albo zestaw wygasł).");
        const all = chunks.join("");
        const cur = a.cursor == null ? 0 : Math.max(0, int(a.cursor, "cursor", 0));
        const max = a.max_chars == null ? 60000 : Math.min(120000, Math.max(5000, int(a.max_chars, "max_chars", 60000)));
        let end = Math.min(all.length, cur + max);
        if (end < all.length) { const c = all.charCodeAt(end - 1); if (c >= 0xd800 && c <= 0xdbff) end--; } // nie rozcinaj pary zastępczej UTF-16
        return { set_id: setId, file: fmt, total_chars: all.length, cursor: cur, next_cursor: end < all.length ? end : null, content: all.slice(cur, end) };
      }
      const ids: string[] = Array.isArray(a.job_ids) ? a.job_ids.map((x: unknown) => str(x, "job_ids")!) : [];
      if (a.job_id != null) ids.unshift(str(a.job_id, "job_id")!);
      if (!ids.length) throw new UserError("Podaj job_id albo job_ids.");
      let sortBy = oneOf(a.sort_by, "sort_by", ["selection", "views", "likes", "comments_count", "published_at", "duration_seconds", "views_vs_channel_median", "views_gain", "channel_views_rank"] as const, "selection");
      let sortDir = oneOf(a.sort_dir, "sort_dir", ["asc", "desc"] as const, sortBy === "selection" ? "asc" : "desc");
      if (a.sort != null) {
        const legacy = oneOf(a.sort, "sort", ["selection", "views_desc", "views_asc"] as const, "selection");
        sortBy = legacy === "selection" ? "selection" : "views";
        sortDir = legacy === "views_asc" ? "asc" : legacy === "views_desc" ? "desc" : "asc";
      }
      if (a.filters != null && (typeof a.filters !== "object" || Array.isArray(a.filters))) throw new UserError("filters musi być obiektem.");
      const created = await st.startSet({
        jobIds: ids, allowPartial: a.allow_partial === true, sortBy, sortDir, filters: a.filters ?? {},
        mdPartChars: a.md_part_chars == null ? null : int(a.md_part_chars, "md_part_chars", 180000), label: str(a.label, "label", false),
      });
      const sid = created.set_id as string;
      const info = await waitFor(int(a.wait_seconds, "wait_seconds", 20), () => st.setInfo(sid), (i: any) => !i || (i.phase !== "selecting" && i.phase !== "ordering" && i.phase !== "building"));
      if (!info) throw new UserError("Eksport nie wystartował.");
      if (info.phase === "failed") return { ok: false, set_id: sid, phase: "failed", error: info.error };
      if (info.phase !== "ready") return { ok: true, set_id: sid, phase: info.phase, next_step: "Eksport w toku. Wywołaj export_collection ponownie z tymi samymi parametrami za kilka sekund." };
      const links: Record<string, string> = {};
      for (const f of [...Object.keys(info.files), "status"]) links[f] = await signExport(env, origin, sid, f);
      const manifest = await signExport(env, origin, sid, "manifest");
      return {
        ok: true,
        phase: "ready",
        set_id: sid,
        label: info.label,
        partial_export: info.partial,
        records: info.records,
        duplicates_removed: info.duplicates_removed,
        notes: info.notes,
        files: info.files,
        md_parts: info.md_parts,
        download_links: links,
        manifest_link: manifest,
        link_valid_seconds: Number(env.EXPORT_LINK_TTL_SECONDS) || 3600,
        download_hint: "Na komputerze: .\\pobierz_zestaw.ps1 -Manifest \"<manifest_link>\" -Nazwa <folder> (pobiera wszystkie pliki i sprawdza SHA-256).",
        verification: "Każdy rekord po zapisie odczytano z powrotem i porównano z bazą (wszystkie pola, pełny tekst transkrypcji i segmenty czasowe; Markdown zawiera ID i każdy segment).",
        note: "csv = UTF-8 z BOM (Excel), json = tablica rekordów, md-N = paczka dla modelu (części), status = raport integralności, statusy braków i definicje pól.",
      };
    }
    default:
      throw new UserError(`Nieznane narzędzie: ${name}`);
  }
}

export async function handleMcp(request: Request, env: Env, origin: string, props: Props | undefined): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json", allow: "POST" } });
  }
  const server = createMcpServer(env, origin, props);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // stan żyje tylko w tym żądaniu
    void server.close().catch(() => undefined);
  }
}
