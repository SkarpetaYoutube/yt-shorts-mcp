# Raport z audytu paczki yt-mcp-remote

## Co było błędne i co poprawiono
- **YouTube `videos.list`**: kod wysyłał `maxResults` razem z `id`, a Google odrzuca tę kombinację (błąd 400). Usunięto.
- **Klucz YouTube w adresie URL** (ryzyko trafienia do logów i komunikatów błędów): klucz idzie teraz w nagłówku `x-goog-api-key`, tekst wyjątków nie jest pokazywany użytkownikowi.
- **Model limitów (rewizja 2)**: dokumentacja Google z 2026-10-08 (determine_quota_cost) opisuje dla `search.list` osobną pulę 100 wywołań/dobę po 1 jednostce, a starsza tabela 100 jednostek ze wspólnej puli. Nie mogę tego sprawdzić na żywo, więc domyślnie liczymy ostrożnie (100 jednostek wspólnej puli, rezerwacja przed zapytaniem, wymagane 101 wolnych jednostek). Tryb `separate` jest dostępny przez `YT_SEARCH_QUOTA_MODEL`. Nieudane zapytania też kosztują.
- **Wyścig w limicie dziennym**: sprawdzenie i naliczenie były osobnymi krokami, więc równoległe wywołania mogły przekroczyć limit. Zastąpiono atomową rezerwacją przed zapytaniem (`DailyBudget.reserve`, zwrot przy odmowie).
- **Cache wyszukiwania nie działał** (`publishedAfter` zmieniał się co sekundę): zaokrąglono do doby.
- **OAuth GitHub**: domyślnie dozwolone było KAŻDE przekierowanie klienta i zakres `user`. Zawężono przekierowania do `claude.ai` i `claude.com`, zakresy puste. Dodano sprawdzanie listy dozwolonych przy wydawaniu tokenu, przy każdym żądaniu i w warstwie narzędzi.
- **Token bez wygaśnięcia** (tokeny GitHub OAuth App nie wygasają): token serwera ważny 90 dni.
- **Wycieki szczegółów błędów**: `mask_error_details=True` w serwerze złożonym i w obu modułach.
- **Hook**: pojedynczy ogromny segment mógł wypełnić całą odpowiedź (paczka 25 filmów dawała ok. 540 000 znaków, limit Claude ok. 150 000). Hook przycięty do 800 znaków; paczka z 25 długimi filmami ma ok. 110 000 znaków.
- **Przerywanie paczek**: trwałe błędy (zły klucz, 402, 429) zatrzymują paczkę zamiast spalać kredyty; dodano budżety czasu, `pending` i `get_transcript_job` dla zadań asynchronicznych Supadata.
- **Logi**: wyłączono logi dostępu (kody autoryzacji w `/auth/callback`) i logi INFO httpx.
- **Zależności**: dokładne wersje w `requirements.lock`, Python 3.13, `tzdata`.
- **Ograniczanie żądań na IP** (`fly-client-ip`) dla punktów OAuth i `/mcp`.

## Co faktycznie przeszło testy (offline, w czystym venv z requirements.lock)
- `test_oauth_flow.py` (7): discovery (401 + resource_metadata, PRM, DCR, CIMD, PKCE S256), odrzucenie obcych adresów przekierowań, pełny przepływ na atrapie GitHuba (kod jednorazowy, PKCE), CSRF/state/odmowa zgody, obcy użytkownik GitHub nie dostaje tokenu, restart serwera zachowuje sesje, usunięcie z listy działa od razu, lista po numerycznym ID, rate limit + `/health`.
- `test_tools.py` (16): paginacja, koszt 7 jednostek dla 120 shortsów, klucze tylko w nagłówkach, cache, filtr dni, ścieżka zapasowa bez playlisty shortsów, warianty linków kanału, osobna pula search, błędy limitu, przepływ Supadata (hook, 206 brak napisów, 202 zadanie asynchroniczne, 429, budżety, rozmiar odpowiedzi), brak kluczy w logach/odpowiedziach/cache, maskowanie wyjątków, czyszczenie cache, odstęp między zapytaniami.
- Realny start procesu `python server.py` dwa razy z rzędu: `/health` = ok, `/mcp` bez tokenu = 401, metadane OAuth poprawne, brak sekretów w logach startowych.

- Dodane w rewizji 2: search = 100 jednostek (2 strony = 200), odmowa przy 100 wolnych (potrzeba 101) bez ruchu do Google, 99 wolnych blokuje search, ale nie zwykłe zapytanie; tryb `separate`; 32 wątki × 60 rezerwacji = dokładnie 10 przyjętych; 40 równoległych search przy limicie 500 = dokładnie 5 wywołań do Google.
- OAuth porównany z oficjalnym wymaganiami Claude (claude.com/docs/connectors/building/authentication): 401 + resource_metadata, `resource` = adres MCP, pierwszy wpis `authorization_servers`, CIMD (`client_id_metadata_document_supported` + `none`), DCR, PKCE S256, callback `https://claude.ai/api/mcp/auth_callback`. Dozwolony jest też `https://claude.com/api/mcp/auth_callback`. Pętli lokalnej Claude Code celowo nie dopuszczamy (używasz Claude.ai).

## Czego nie da się sprawdzić bez prawdziwego wdrożenia
- Czy Claude.ai faktycznie zaakceptuje konektor (zgodność zbadana z dokumentacją i zachowaniem protokołu, nie z żywym klientem).
- Czy konektor będzie widoczny w istniejących rozmowach Projektu „Youtube”: dokumentacja tego nie opisuje; w razie potrzeby włącz go w rozmowie przez „+” → Connectors.
- Prawdziwy GitHub OAuth (ekran zgody, wymiana kodu), prawdziwe odpowiedzi YouTube i Supadata (atrapy odtwarzają zasady z dokumentacji, nie gwarantują zgodności).
- Build obrazu Dockera i działanie `fly.toml`, wolumenu i health checku na Fly.io (w tym środowisku nie ma działającego demona Docker). Koszty i wymagania Fly podano wg dokumentacji z chwili audytu.
- Playlista `UUSH…` jest nieoficjalna; jest przetestowana tylko zapasowa ścieżka.
- Limit rozmiaru wyniku narzędzia po stronie Claude.ai (przyjęto ok. 150 000 znaków).

## Zalecenia
- Klucz Supadata wklejony wcześniej do rozmowy uznaj za ujawniony: wygeneruj nowy w panelu Supadata i podaj go tylko w `fly secrets set`.

## Rewizja 3: zbieranie Shortsów z pełnymi transkrypcjami (collect.py)
Dodano: newest / oldest / most_viewed, wznawialne zadania na dysku, eksport CSV i JSON (dokładnie 6 pól), `status.json`, czytanie partiami bez obcinania, podpisane linki.
Testy (`test_collect.py`, 11, wszystkie OK na atrapach):
- 100 Shortsów (newest): 100 rekordów w CSV i w JSON, właściwa kolejność i URL-e, każda transkrypcja identyczna ze źródłem, w tym 9 000 i 44 039 znaków (stary limit obcinał przy 6 000); 8 filmów bez napisów i 1 błąd 403 oznaczone w `status.json` (pole null/puste, bez zmyślania); sumy SHA-256 zgodne; żaden film nie pobrany dwa razy.
- Tryby: dokładnie oczekiwane filmy i kolejność dla newest, oldest, most_viewed; prywatne filmy pominięte i zliczone.
- Czytanie partiami (5 000 / 12 000 / 40 000 znaków): kawałki sklejają się w identyczny tekst.
- Wznawianie po 429 i po "restarcie" (czyszczenie pamięci procesu), po limicie kredytów; zadanie AI (202); `retry_failed` i `transcript_mode=auto`; 6 równoległych wywołań bez podwójnego pobierania.
- Linki: poprawny plik; zły podpis, format, zadanie, wygasły i brak podpisu = 403; ścieżka spoza listy odrzucona.
- Brak kluczy w odpowiedziach, logach, plikach zadania i eksporcie; porządkowanie starych zadań.
Koszt w teście (atrapy): 100 newest = 7 jednostek YouTube; 100 most_viewed/oldest przy 230 Shortsach kanału = 11; ok. 100 kredytów Supadata.

Ograniczenia, których testy offline nie obejmują:
- Prawdziwa kolejność i zawartość playlisty `UUSH…` (dla `newest` ufamy, że lista idzie od najnowszych; wynik i tak jest sortowany po dacie z `videos.list`, ale film spoza pobranej strony nie zostanie uwzględniony). Dla oldest/most_viewed czytana jest cała lista (do `COLLECT_MAX_HISTORY`).
- Rzeczywisty czas Supadata na film (zakładane 1-2 s; krok zatrzymuje się po 35 s i wznawia). Długie generowanie AI wraca jako `pending_ai`.
- Czy przeglądarka/Claude.ai pozwoli otworzyć podpisany link (to zwykły link HTTPS do pobrania pliku). Alternatywą jest `read_collection`.
- Playlista kanału może nie zawierać każdego Shorta (np. bardzo stare); `history_complete` mówi tylko, że lista się skończyła.
- Rzeczywiste zużycie kredytów Supadata, zwłaszcza dla `auto`.
