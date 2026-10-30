# YouTube Tools: zdalny MCP dla Claude.ai (statystyki + transkrypcje)

Jeden serwer MCP (Streamable HTTP przez HTTPS) z narzędziami z dwóch modułów:

| Plik | Narzędzia | Źródło danych |
|---|---|---|
| `youtube_mcp.py` | `list_channel_videos`, `get_videos`, `search_videos`, `resolve_channel`, `get_quota_usage` | YouTube Data API v3 |
| `supadata_mcp.py` | `get_transcript`, `get_transcripts_batch`, `get_usage` | Supadata API |
| `collect.py` | `start_collection`, `continue_collection`, `get_collection_status`, `list_collections`, `export_collection`, `read_collection` | zbieranie N Shortsów z PEŁNYMI transkrypcjami, eksport CSV/JSON |
| `server.py` | łączy oba moduły pod adresem `/mcp`, dodaje logowanie i listę dozwolonych użytkowników | |

W Claude.ai dodajesz **jeden konektor** (jeden adres, jedno logowanie), a Claude widzi narzędzia z obu modułów.

## Bezpieczeństwo

- Logowanie OAuth przez GitHub. Claude.ai rejestruje się automatycznie (DCR/CIMD, PKCE S256).
- Dostęp tylko dla loginów lub ID z `ALLOWED_GITHUB_USERS`. Inny użytkownik GitHub widzi pustą listę narzędzi i nie wywoła żadnego.
- Bez tokenu serwer odpowiada `401`. Jedynym otwartym adresem jest `/health` (zwraca `ok`).
- Żadnych sekretów w kodzie, obrazie Dockera ani ZIP-ie. Wszystko z zmiennych środowiskowych (`fly secrets`).
- Sesje OAuth są zaszyfrowane na dysku (klucz z `JWT_SIGNING_KEY`).
- Serwer odmawia startu przy adresie `http://` (poza localhost) i przy kluczu krótszym niż 32 znaki.

## Limity, cache, odporność

- Rozliczanie YouTube: `videos/channels/playlistItems.list` = 1 jednostka; `search.list` = 100 jednostek (tryb `YT_SEARCH_QUOTA_MODEL=shared`, domyślny). Aktualna dokumentacja Google (2026-10-08) opisuje dla search osobną pulę 100 wywołań/dobę; tryb `separate` liczy tak, ale domyślnie liczymy ostrożniej. Rezerwacja jednostek jest atomowa i następuje przed zapytaniem, więc równoległe wywołania nie przekroczą limitu. Reset licznika: północ czasu pacyficznego (założenie: Google nie podaje tego na stronie quota).

- Wspólny odstęp między zapytaniami do każdego API, także przy równoległych wywołaniach (YouTube 0,25 s, Supadata min. 0,3 s, w paczkach 0,8 s).
- Ponawianie przy 429/5xx z `Retry-After`; czytelne błędy (limit YouTube, zły klucz, brak napisów).
- Cache na wolumenie: statystyki 1 h, kanały 24 h, transkrypcje 30 dni.
- Własne dzienne bezpieczniki: YouTube 9000 jednostek (z 10 000), `search.list` liczony ostrożnie jako 100 jednostek ze wspólnej puli (wymaga 101 wolnych przed startem: 100 + pobranie statystyk) i maks. 100 wywołań/dobę, Supadata 300 kredytów. Zmienisz je zmiennymi z `.env.example`.
- Długie wywołania mają budżet czasu (Fly przerywa połączenia po 60 s bezczynności): niedokończone filmy wracają w `not_processed` lub jako `pending` z `job_id`.
- Błąd jednego filmu nie przerywa paczki transkrypcji (max 25 filmów na wywołanie).

## Wdrożenie na Fly.io (ok. 3–4 USD/mies.)

Wymagane: konto Fly.io z kartą, konto GitHub, zainstalowany `flyctl` ([instrukcja](https://fly.io/docs/flyctl/install/)).
Koszt orientacyjny: maszyna shared-cpu-1x 512 MB ok. 3–4 USD/mies. + wolumen 1 GB ok. 0,15 USD/mies. (sprawdź aktualny cennik na fly.io/docs/about/pricing).

1. **Zaloguj się:** `fly auth login`
2. **Nazwa aplikacji:** wymyśl unikalną (np. `yt-tools-twojanazwa`), wpisz ją w `fly.toml` w linii `app = "..."`, potem `fly apps create yt-tools-twojanazwa`
3. **Wolumen na cache i sesje:** `fly volumes create data --region waw --size 1`
4. **GitHub OAuth App** (GitHub → Settings → Developer settings → OAuth Apps → New):
   - Homepage URL: `https://yt-tools-twojanazwa.fly.dev`
   - Authorization callback URL: `https://yt-tools-twojanazwa.fly.dev/auth/callback`
   - Po utworzeniu: skopiuj Client ID i wygeneruj Client secret.
5. **Sekrety.** Własne wartości wpisuj tylko w swoim terminalu, nie wklejaj ich nikomu w czacie.
   Klucz sesji wygeneruj osobno i wklej do polecenia (działa tak samo w PowerShellu, Windows i macOS):

   ```
   python -c "import secrets; print(secrets.token_urlsafe(48))"
   ```

   ```
   fly secrets set PUBLIC_BASE_URL=https://yt-tools-twojanazwa.fly.dev GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... ALLOWED_GITHUB_USERS=twoj-login-lub-numeryczne-ID JWT_SIGNING_KEY=WYGENEROWANY_KLUCZ YOUTUBE_API_KEY=... SUPADATA_API_KEY=...
   ```

   Zalecane: w `ALLOWED_GITHUB_USERS` podaj numeryczne ID (`https://api.github.com/users/TWOJ-LOGIN`, pole `id`). Można podać oba, po przecinku.
6. **Wdróż jedną maszyną:** `fly deploy --ha=false` a potem `fly status`. Jeśli widzisz 2 maszyny: `fly scale count 1 -y`
   (wolumen jest przypisany do jednej maszyny, a dwie osobne kopie miałyby osobne sesje i cache).
7. **Sprawdź:** `curl https://yt-tools-twojanazwa.fly.dev/health` powinno zwrócić `ok`.

Restart lub nowe wdrożenie nie psuje logowania: sesje i cache leżą na wolumenie `/data`, a klucz `JWT_SIGNING_KEY` jest stały.
Token sesji ważny jest 90 dni, potem Claude poprosi o ponowne połączenie konektora (to normalne).

## Zbieranie Shortsów z pełnymi transkrypcjami (CSV/JSON)

Przykład w rozmowie: „Zbierz 100 najnowszych Shortsów kanału @nazwa z pełnymi transkrypcjami i wyeksportuj”.
Claude wykona: `start_collection` → `continue_collection` (powtarza, aż `complete=true`) → `export_collection`.

- `mode`: `newest` (N najnowszych), `oldest` (N najstarszych), `most_viewed` (N z największą liczbą wyświetleń w dostępnej historii; przegląda całą listę Shortsów kanału, ok. 1 jednostka YouTube na 25 filmów).
- `count`: 1-500 (zmiana: `COLLECT_MAX_COUNT`). `transcript_mode`: `native` (istniejące napisy, 1 kredyt Supadata/film) lub `auto` (AI, gdy napisów brak, droższe).
- Stan zadania jest zapisywany na wolumenie (30 dni): po przerwie, limicie API albo restarcie `continue_collection` dokończy pracę bez ponownego pobierania gotowych filmów. Filmy pobrane z Supadata są też w cache.
- **Transkrypcje nie są obcinane ani zmieniane**: pełny tekst segmentów, złączonych pojedynczą spacją. Brak transkrypcji = `null` w JSON / puste w CSV, a przyczyna jest w `status.json` (`no_captions`, `error`, `empty`, `pending_ai`).
- **Eksport** (`export_collection`): `shorts.csv` (UTF-8 z BOM, żeby Excel czytał polskie znaki) i `shorts.json` mają DOKŁADNIE 6 pól w tej kolejności: `title, duration_seconds, transcript, published_at, url, views`. `status.json` ma statusy, błędy, `transcript_chars` i sumy kontrolne SHA-256. Po zapisie serwer czyta pliki z dysku i porównuje z danymi źródłowymi; przy niezgodności zgłasza błąd zamiast oddać plik.
- **Pliki**: `export_collection` zwraca podpisane linki (ważne 24 h, `EXPORT_LINK_TTL_SECONDS`); otwórz je w przeglądarce. Link daje dostęp każdemu, kto go ma — nie udostępniaj. Plik w Claude.ai możesz też czytać bez linku: `read_collection` zwraca rekordy partiami; transkrypcję większą niż partia dzieli na kawałki z `transcript_offset` i flagą `transcript_complete_in_this_item`. Duże zestawy (100+ filmów) to setki tysięcy znaków, więc do analizy poza rozmową wygodniej użyć pliku.
- Jeśli kanał ma mniej Shortsów niż `count`, odpowiedź zawiera jawne `shortfall` (np. 75 z 100). Prywatne/usunięte filmy są pomijane i zliczane w `unavailable_videos`.
- Limit Supadata: domyślnie 300 kredytów dziennie (`SUPADATA_DAILY_CREDIT_BUDGET`). Po osiągnięciu zadanie się zatrzymuje z czytelnym komunikatem; podnieś limit lub wznów następnego dnia.

## Podłączenie w Claude.ai

1. Customize → Connectors → Add custom connector.
2. Nazwa: `YouTube Tools`, adres: `https://yt-tools-twojanazwa.fly.dev/mcp`
3. Uwierzytelnianie: Sign in now. Tożsamość klienta OAuth: „Use Claude's published identity” albo „Register automatically”. Pola klienta zostaw puste.
4. Connect → zaloguj się przez GitHub → zatwierdź dostęp.
5. W rozmowie: przycisk „+” → Connectors → włącz „YouTube Tools”.

## Testy

```
pip install -r requirements.lock
python test_oauth_flow.py   # pełny przepływ OAuth na atrapie GitHuba: discovery, DCR, PKCE, zgoda/CSRF, odmowa obcych, restart
python test_collect.py      # zbieranie 100 Shortsów z transkrypcjami, eksport, wznawianie, linki, partie
python test_tools.py        # narzędzia YouTube i Supadata na atrapach odtwarzających zasady prawdziwych API, wycieki sekretów
```

Testy offline nie dowodzą zgodności z prawdziwym Claude.ai ani z prawdziwymi API Google/Supadata. Zobacz `AUDYT.md`.
Uruchomienie lokalne: skopiuj `.env.example` do `.env`, uzupełnij (`PUBLIC_BASE_URL=http://localhost:8080`), `python server.py`.

## Gdy coś nie działa

- Konektor nie łączy się: otwórz `https://TWOJA-APKA.fly.dev/health` (ma być `ok`), potem `fly logs`. Sprawdź, czy callback w GitHubie to dokładnie `.../auth/callback`.
- Po zalogowaniu brak narzędzi lub odmowa: Twój login/ID nie jest w `ALLOWED_GITHUB_USERS`.
- „Wyczerpany dzienny limit”: YouTube resetuje limit o północy czasu pacyficznego; `get_quota_usage` pokazuje zużycie liczone przez serwer (przybliżone).
- Narzędzia nie ma w istniejącej rozmowie: w tej rozmowie przycisk „+” → Connectors → włącz „YouTube Tools”.

## Uwagi

- Lista shortsów kanału korzysta z playlisty `UUSH…` (nieoficjalny, ale znany sposób). Gdyby przestał działać, serwer przełączy się na filtr po długości (do 3 min).
- Transkrypcje domyślnie tylko z istniejących napisów (`mode=native`, 1 kredyt). `mode=auto` generuje je przez AI (2 kredyty/min), gdy napisów brak.
- Rotacja sekretów: `fly secrets set NAZWA=nowa_wartość` (maszyna restartuje się sama). Zmiana `JWT_SIGNING_KEY` wymaga ponownego połączenia konektora.
