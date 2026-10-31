# YouTube Shorts MCP na Cloudflare Workers (plan Free)

Zdalny serwer MCP (Streamable HTTP) dla zwykłego Claude.ai. Zbiera 1–500 Shortsów z kanału
(`newest` / `oldest` / `most_viewed`), z pełnymi transkrypcjami (Supadata), zapisuje postęp,
wznawia po przerwie i buduje zweryfikowane pliki CSV i JSON.

### Wersja 2.2: paczka dla modelu, zestawy, filtry, odświeżanie, statusy braków

**Eksport (`export_collection`)** z jednego zadania (`job_id`) albo wspólny zestaw z wielu kanałów (`job_ids`, do 20):
- `csv`, `json` oraz paczka **Markdown** dla modelu (`md-1`, `md-2`, …): przy każdej rolce ID, link, kanał, daty,
  statystyki z czasem pomiaru, ranking kanału, ranking zestawu, przyrost i historia, statusy braków, transkrypt ze
  znacznikami czasu `[m:ss.s]` i komentarze. Części mają limit znaków (`md_part_chars`, domyślnie 180 000); rolka nigdy
  nie jest cięta (za duża rolka trafia sama do części z oznaczeniem). Bez ocen i interpretacji – tylko dane.
- **duplikaty** (ta sama rolka w kilku zadaniach) usuwane po ID filmu; zostaje wersja z najnowszym pomiarem.
- **rankingi rozdzielone**: `channel_*` (wśród Shortsów kanału) i `set_views_rank`/`set_size` (wśród rolek w pliku).
- **filtry**: kanał, data publikacji, długość, wyświetlenia, polubienia, krotność mediany kanału, frazy w tytułach
  i/lub transkryptach (lista fraz = dowolna, wielkość liter bez znaczenia). **Sortowanie** po wyświetleniach,
  polubieniach, komentarzach, dacie, długości, krotności mediany, przyroście, randze kanału – rosnąco/malejąco, braki na końcu.
- `manifest`: jeden podpisany link z listą wszystkich plików i sum SHA-256. Na komputerze:
  `.\pobierz_zestaw.ps1 -Manifest "<manifest_link>" -Nazwa <folder>`.

**Odświeżanie (`refresh_stats`)**: tylko statystyki (wyświetlenia, polubienia, liczba komentarzy, norma i ranking
kanału) i opcjonalnie komentarze; transkrypcje nie są pobierane (0 kredytów Supadata). Każdy pomiar trafia do historii.

**Statusy braków**: transkrypt `ok | empty | no_captions | error_video | error_service | no_credits | pending | pending_ai`;
komentarze `ok | disabled | unavailable | error | not_fetched | stale | not_requested`; statystyki `ok | unavailable`.
`continue_collection` ponawia tylko brakujące (`no_credits`, niepobrane komentarze); `retry_failed` także nieudane.

**Szacunek kosztów**: `collect_shorts` (domyślnie `estimate_first=true`) po wyborze filmów zatrzymuje się z polem
`estimate`: ile transkrypcji jest już zapisanych, ile kredytów Supadata zużyje, ile jednostek YouTube pójdzie na komentarze.
`continue_collection` rusza dalej.

### Wersja 2.5: pełna wizja w eksporcie

Wynik wizji każdej rolki trafia do wspólnego eksportu bez utraty szczegółów:
- **JSON**: `vision` (zdjęcia, wiadomości przed/po, powiązania, niepewność, wiadomości z ekranu) oraz `vision.run`: model zażądany i faktyczny,
  próba, HTTP, `finish_reason`, zużycie tokenów, parametry, `video_duration_s`, `no_images_found` i **oryginalna odpowiedź Gemini API bez zmian**
  (`raw_response`, klucz zamaskowany) z `raw_response_sha256` i długością. Odpowiedź dłuższa niż 400 000 znaków nie jest dołączana
  (`raw_response_status: omitted_too_large`); jest w bazie serwera i w `get_image_analysis`.
- **CSV**: na końcu dwie nowe kolumny `vision_json` (cała znormalizowana wizja, bez oryginalnej odpowiedzi API) i `vision_json_chars`;
  kolumna `vision` zawiera teraz też wiadomości przed/po, tekst na zdjęciu i niepewność. Excel i Arkusze obcinają komórki dłuższe niż 32 767 znaków – pełne dane są zawsze w JSON.
- **Markdown**: linia z modelem, próbą, `finish_reason`, tokenami i SHA-256 oryginalnej odpowiedzi (sam tekst odpowiedzi tylko w JSON).
- `status.json`: `counts.vision_status` (ile rolek `ok` / `not_analyzed` / `in_progress` / `failed:*`).

### Rozpoznawanie zdjęć w rolkach (Gemini, próbnie)

`analyze_images` wysyła publiczny link rolki do Gemini API (`generateContent`, `fileData.fileUri` + `videoMetadata.fps`,
domyślnie jeden przebieg 1 klatka/s, model `gemini-3.6-flash`; `fps` i `model` można podać) i zapisuje: model i wersję, parametry, czas, status HTTP,
surową odpowiedź albo rzeczywisty błąd, zużycie tokenów i wynik (wiadomości z ekranu, zdjęcia z czasem, opisem, wiadomościami
przed/po, powiązaniami „wprost”/„PRZYPUSZCZENIE”, niepewnościami). `get_image_analysis` pokazuje wyniki, porównanie przebiegów
(co wykryto w obu, a co tylko w jednym) i linki do surowego JSON i czytelnego opisu. Gemini zwraca tylko tekst – **plików
obrazów z linku nie ma** (obrazy wyłącznie z lokalnego MP4). Wymaga sekretu `GEMINI_API_KEY` (darmowy klucz z Google AI Studio,
bez włączania płatności); bezpiecznik `GEMINI_DAILY_CALLS` (domyślnie 20 zapytań/dobę). Klucz nie trafia do zapisów.

### Pola rekordu
Pierwsze sześć jak w wersji 1: `title, duration_seconds, transcript, published_at, url, views`. Dalej:
`video_id, channel_id, channel_title, channel_handle, measured_at, likes, comments_count, channel_views_rank,
channel_shorts_ranked, top_5_percent_channel, above_channel_norm, views_vs_channel_median, set_views_rank, set_size,
views_prev, views_prev_at, views_gain, views_gain_per_day, views_history, transcript_status, comments_status,
comments_fetched_at, stats_status, top_comments_relevance, transcript_timed`. Definicje są w `status.json` i w pierwszej
części paczki Markdown.

- `top_comments_relevance`: do 5 komentarzy w kolejności **trafności wg YouTube** (`order=relevance`), nie wg polubień.
- Norma: ponad normę = wyświetlenia ≥ 2 × mediana Shortsów kanału (co najmniej 5 rolek, mediana > 0); TOP 5% = miejsce
  w pierwszych 5% kanału (co najmniej 20 rolek). **Rankingi i norma liczone są z całkowitych wyświetleń i nie uwzględniają
  wieku publikacji.** Przy niepełnej historii kanału pola kanałowe są `null`.

Przechowywanie: zgodnie z zasadami YouTube API Services (III.E.4) statystyki i dane z YouTube API są trzymane najwyżej
30 dni od ostatniego pomiaru (historia przyrostów obejmuje więc ostatnie 30 dni); zadanie odświeżone przez `refresh_stats`
liczy się od odświeżenia.

Trwałość: dane leżą w SQLite Durable Object; wdrożenie nowego kodu i restart ich nie usuwają (migracje schematu tylko dodają
tabele/kolumny). Pobrane transkrypcje są trzymane `TRANSCRIPT_CACHE_DAYS` dni (domyślnie 365), więc ponowne pobranie nic nie kosztuje.

## Architektura (tylko to, co potrzebne)
| Element | Rola |
|---|---|
| Worker (TypeScript) | MCP (`/mcp`), OAuth, pobieranie plików z podpisanych linków |
| `@cloudflare/workers-oauth-provider` | serwer OAuth 2.1 (PKCE S256, rejestracja klienta, CIMD, rotacja refresh tokenów) |
| KV `OAUTH_KV` | wyłącznie dane biblioteki OAuth (klienci, granty, tokeny) |
| Durable Object `Store` (SQLite) | zadania, transkrypcje, cache, dzienne liczniki limitów, pliki eksportu |
| Alarmy DO | praca w tle małymi krokami (każdy ≤ ~20 subżądań, plan Free pozwala na 50) |
| GitHub OAuth | logowanie; dostęp ma tylko konto z `ALLOWED_GITHUB_USERS` |

Nie używamy R2 (wymaga karty), D1, Queues ani płatnych funkcji. Eksporty żyją w SQLite DO i są wydawane przez Worker.

## Bezpieczeństwo
- `/mcp` bez ważnego tokenu → 401 z `resource_metadata`. Token wiąże konto GitHub; **lista dozwolonych jest sprawdzana przy każdym żądaniu** (usunięcie z listy odcina dostęp od razu).
- Zgoda użytkownika (ekran zgody + ciasteczko wiążące), dozwolony wyłącznie callback Claude (`https://claude.ai/api/mcp/auth_callback`, opcjonalnie `ALLOWED_REDIRECT_URIS`).
- Sekrety tylko w Cloudflare Secrets; klucze YouTube/Supadata wysyłane nagłówkami, nigdy w URL; odpowiedzi narzędzi maskują wartości sekretów.
- Linki do pobrania: HMAC-SHA256 (`SIGNING_KEY`) związany z zadaniem, formatem i terminem (domyślnie 1 h), porównanie w stałym czasie.
- Limity: bezpiecznik dzienny YouTube (9000 jednostek) i Supadata (300 kredytów) rezerwowany atomowo **przed** każdym zapytaniem; ogranicznik tempa dla `/mcp`, `/token`, `/register`, pobrań.

## Wdrożenie (po zgodzie właściciela)
1. `npm install`
2. `npx wrangler login` (konto Cloudflare, plan Free)
3. `npx wrangler kv namespace create OAUTH_KV` → wpisz `id` w `wrangler.jsonc`
4. Aplikacja GitHub OAuth: callback `https://<nazwa>.<subdomena>.workers.dev/callback`
5. Sekrety: `wrangler secret put` dla `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SIGNING_KEY` (≥32 losowe znaki), `YOUTUBE_API_KEY`, `SUPADATA_API_KEY`, `ALLOWED_GITHUB_USERS`
6. `npx wrangler deploy`
7. Claude.ai → Ustawienia → Konektory → Dodaj własny konektor → `https://<worker>/mcp`; potem włącz w projekcie „Youtube”.

## Narzędzia MCP
`collect_shorts`, `continue_collection`, `refresh_stats`, `get_collection_status`, `list_collections`, `export_collection`, `read_collection`, `get_transcript`, `analyze_images`, `get_image_analysis`, `resolve_channel`, `get_usage`.

## Testy
`npm test` (86 testów w środowisku workerd, atrapy YouTube/Supadata/GitHub) oraz `npm run typecheck`.
Czas CPU i zachowanie usług rzeczywistych **nie** są mierzone lokalnie — patrz RAPORT.md.
