# Raport przed wdrożeniem (nic nie zostało wdrożone)

## Koszt
**Hosting: 0 zł** w planie Cloudflare Workers Free (bez karty, bez płatnych zasobów: tylko Worker, Durable Object SQLite i KV).
Płatne w osobnym rozliczeniu są tylko kredyty Supadata (+ darmowa dzienna pula YouTube Data API).

| Ile Shortsów | Supadata (tryb native) | YouTube API (newest) | Żądania Workers/DO* | Zapisy wierszy DO* | Zapisy KV |
|---|---|---|---|---|---|
| 20 | ~20 kredytów | 3 jedn. | ~50 | ~150 | ~10 (logowanie) |
| 100 | ~100 kredytów | 5 jedn. | ~100 | ~700 | ~10 |
| 500 | ~500 kredytów | 21 jedn. | ~400 | ~3 500 | ~10 |
Limity Free: 100 000 żądań/dzień, 100 000 zapisów wierszy DO/dzień, 1 000 zapisów KV/dzień → wykorzystanie poniżej 4 %.
\*Szacunek z projektu; zmierzone w testach: wywołania YouTube/Supadata, zużycie jednostek i kredytów (kolumny 2–3 są pomiarem na atrapach).
`oldest`/`most_viewed` muszą przejrzeć całą historię Shortsów kanału: 1 + 2·⌈H/50⌉ jednostek (H=1000 → 41 jedn.).
Domyślny bezpiecznik Supadata to 300 kredytów/dobę (zmienna `SUPADATA_DAILY_CREDIT_BUDGET`) — 500 Shortsów wymaga podniesienia albo dwóch dni.

## Wyniki testów (lokalnie, workerd, atrapy API) — 45/45 zaliczone, typecheck czysty
- Tryby newest/oldest/most_viewed: kolejność zgodna z modelem, brak duplikatów, brak liczby wyświetleń → `views=null` na końcu.
- 100 Shortsów (w tym transkrypcje 44 000, 25 000 i 9 000 znaków, 2 filmy bez napisów, 1 pusta, 3 niedostępne): CSV i JSON zgodne ze źródłem co do znaku, dokładnie 6 pól, SHA-256 plików i transkrypcji zgodne ze `status.json`.
- Wznawianie: restart DO w połowie (bez ponownego płacenia za gotowe), limit Supadata → zatrzymanie i wznowienie, quotaExceeded YouTube, 401, 429, błąd pojedynczego filmu + `retry_failed`, tryb `auto` (zadania AI), cache, fallback bez playlisty UUSH.
- Żaden krok nie przekracza 50 subżądań (zmierzone maks. 20).
- Integralność eksportu: celowe uszkodzenie danych jest wykrywane, a eksport nie oddaje wadliwych plików.
- Autoryzacja: 401 + resource_metadata, DCR, PKCE S256, token form-urlencoded, refresh, konto spoza listy → 403 bez kodu, obcy redirect_uri odrzucony, usunięcie z listy odcina istniejący token, linki: zły podpis/termin/format/wygasły/nieznane zadanie.
- Sekrety: brak w odpowiedziach i URL-ach; wartości odbite przez zewnętrzne API są maskowane.
- Wykryta i naprawiona w trakcie usterka: komunikaty błędów użytkownika gubiły się na granicy RPC (Claude widziałby „błąd wewnętrzny”).

## NIE sprawdzone (dopóki nie wdrożymy)
- Czas CPU w planie Free (10 ms/żądanie; dla alarmów DO limit niejednoznaczny w dokumentacji) — lokalnie niemierzalny. Rozmiary kroków (`STEP_ITEMS`, paczki eksportu) są regulowane; zmierzę przez `wrangler tail` na 5 prawdziwych Shortsach.
- Prawdziwe odpowiedzi YouTube i Supadata (w tym naliczanie kredytów za 206/AI), prawdziwy czas pobierania.
- Utworzenie KV/DO/subdomeny workers.dev na koncie bez karty; zachowanie Claude.ai przy łączeniu konektora i pobieraniu linków z poziomu rozmowy.

## Ograniczenia
- Nie przeniesiono z wersji Python: `search_videos`, `get_videos`, `list_channel_videos`, `get_transcripts_batch`, `get_transcript_job`, hooki i model `search.list` (nie potrzebne do zadania; mogę dodać).
- Rate limiter w pamięci izolatu jest „best effort”; twardą ochroną kosztów są liczniki w DO.
- Link do eksportu daje dostęp każdemu, kto go posiada, do wygaśnięcia (domyślnie 1 h).
- Dane przechowywane 30 dni (`COLLECT_RETENTION_DAYS`), wszystkie zadania współdzielone przez dozwolone konta.
