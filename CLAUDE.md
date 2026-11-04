# YouTube Shorts MCP — kontekst dla Claude Code

Język pracy z użytkownikiem: **polski**. Użytkownik chce krótkich, konkretnych raportów, bez kolejnych „jeszcze jednych poprawek" i bez rozszerzania zakresu bez zgody. **Bez płatności** (tylko darmowe plany).

## Co to jest
1. **Zdalny serwer MCP na Cloudflare Workers** (`src/`, `wrangler.jsonc`): YouTube Data API v3 + Supadata (transkrypty) + Gemini (opis zdjęć w rolkach). Logowanie OAuth przez GitHub, Durable Object z SQLite jako baza. Narzędzia: `collect_shorts`, `continue_collection`, `export_collection`, `read_collection`, `analyze_images`, `get_transcript`, `get_usage` itd. (patrz `README.md`).
2. **Lokalny potok zrzutów** (`zrzuty/`, Node + Playwright, uruchamiany na PC użytkownika w Edge z osobnym profilem): dla każdej rolki zapisuje PRAWDZIWE screeny zdjęć z czatu razem z wiadomościami, które je tłumaczą (cały panel rozmowy, bez gameplayu) + ciasny wycinek samego zdjęcia. Czasy z Gemini to tylko wskazówka — zdjęcie jest mierzone na klatkach.
3. `legacy/python-fly/` — pierwsza wersja serwera w Pythonie (Fly.io), zastąpiona przez Workers. Tylko historia.

## Ważne zasady (ustalone z użytkownikiem)
- Program **nie czyta tekstu** na klatkach. Wynik „pełny" z programu = **NIEZWERYFIKOWANY**; „zweryfikowany" dopiero po audycie wzrokowym zapisanym przez `zrzuty/audyt.mjs` (powiązany z plikami i md5).
- Raportuj **rzeczywistą liczbę poprawnych kontekstów** (kategorie), nie liczbę statusów „KOMPLET".
- Kategorie: PELNY_ZWERYFIKOWANY > PELNY_NIEZWERYFIKOWANY > CZESCIOWY_ZWERYFIKOWANY > CZESCIOWY_NIEZWERYFIKOWANY > BRAK. Najlepszy zapisany wynik jest oddzielony od ostatniej próby (`mergeBest`) — nieudane ponowienie nie pogarsza paczki.
- Manifest, raport i `AUDYT_KONTEKSTU.md` są generowane z jednego manifestu (`zloz_paczke.mjs`).
- Twarde limity czasu: `--max-total` (domyślnie 1500 s), `--reel-max` (480 s), `--call-max` (120 s); po limicie proces kończy się kodem 4.
- Między żądaniami do YouTube robić małe odstępy (`--pause`).
- Nie uruchamiać prób na YouTube bez prośby użytkownika.

## Stan na 2026-11-01
- **Serwer MCP: 2.8.0 na produkcji i w GitHub** (`collect_shorts` z `auto_vision`: wizja zlecana sama po zebraniu; 2.7.2: kolejka Gemini nie głodzi zbierania).
- **Wszystko na raz (jedna rolka = jeden folder):** część serwerową (collect, wizja, export) robi Claude w rozmowie, potem lokalnie `zrzuty\zbierz_rolki.ps1 -Manifest "<link>"` daje `wyniki\<Kanał>\<Kanał> - <Tytuł> [<ID>]\` (dane.json/csv/md, zdjecia\, klatki\, zdjecia.md/json) oraz `_zbiorczo\` i `_zrzuty_robocze\`. Szczegóły: `zrzuty/README.md`.
- **Skuteczność zrzutów (Dr. Ethan, 5 rolek, 8 zdjęć):** po poprawkach (kadr „przed” robiony po ostatniej wiadomości, większy budżet ponowień w drugiej rundzie: `--reloads 4 --retry-budget 180 --buffer-wait 30`) 8/8 zdjęć złapanych, audyt wzrokowy: 7 pełnych, 1 częściowy. W wcześniejszych biegach na kilku kanałach YouTube często zrywał odtwarzacz (aerotxt, Dozzek): przy większych partiach liczyć się z ponowieniami.
- **Znane ograniczenia:** (1) kategoria „częściowy” bywa zaniżona, gdy kadr główny już pokazuje wiadomości przed zdjęciem, a osobnego kadru „przed” nie zapisano; (2) Gemini czasem błędnie etykietuje prawdziwe zdjęcie jako awatar (sprawdzać klatki); (3) zrzuty zależą od zachowania YouTube (buforowanie przy dalekich przewinięciach); (4) Node 24 na Windows po cichu nie usuwa folderów ze znakami spoza ASCII przez `fs.rmSync(recursive)`: używać ręcznego usuwania (jak w `rozloz_na_rolki.mjs`).
- **Lokalnie dla kanału:** `_zbiorczo\indeks_rolek.csv/md` (jedna linia na rolkę ze statusem zdjęć) i `_baza\baza_rolek.json/csv` (scala kolejne eksporty, historia wyświetleń; serwer trzyma dane tylko 30 dni). Kadr „reakcja”, który odpadł, ma zapasową, wcześniejszą klatkę (kontekst wtedy oznaczony jako niekompletny do audytu).
- **Odrzucony eksperyment (2026-11-01): „przebieg” zamiast przewinięcia** (odległe chwile osiągane odtwarzaniem 2x). Test na Dozzek mNuZtUpxV2Q (zdjęcie przy 1:20): przebieg 0/3 zdjęć (YouTube zrywał odtwarzacz po dojściu do ~78 s), zwykłe przewinięcie na tej samej rolce w tym samym czasie 2 pełne + 1 brak. Kod cofnięty; nie wracać do tego bez nowego pomysłu.
- **Model wizji (2026-11-01, 8 rolek, 14 zdjęć, kontrola OCR wiadomości z wizji na klatkach):** `gemini-3.5-flash-lite` = ta sama liczba zdjęć co `gemini-3.6-flash` (8/8 rolek), czasy zdjęć w granicach ok. 2 s od pomiaru, wiadomości „pełne” wg OCR 12 vs 11 zdjęć, ale lite podaje mniej wiadomości przed/po (41 vs 47 widocznych); ten sam błąd awatara. Limit lite 500/dobę vs 20: przy bazie 40–50 rolek lite jest praktyczny (`vision_model` w `collect_shorts`/`model` w `analyze_images`); domyślny zostaje 3.6. To mała próba, nie dowód kompletności.
- **2.8.1 (wdrożone 2026-11-01):** prompt z mocniejszym zakazem awatarów + pole `likely_avatar` (flaga, nie usuwanie); `zrzuty.mjs` i `rozloz_na_rolki.mjs` pomijają oznaczone. **Pomiar: prompt NIE pomógł** (flash 3.6 na Dozzek bp7H54Iyfjc nadal wpisał awatar Thomasa jako zdjęcie 1, tym razem 0:00–0:13,5 i bez adnotacji „awatar”), więc flaga go nie złapała (łapie tylko wpisy, w których model sam nazywa awatar). Taki wpis w potoku kończy jako „brak zdjęcia na klatkach” (nie znajdzie karty ze zdjęciem). Nie dokładać kolejnych poprawek promptu pod ten jeden przypadek.
- **Mniej ręcznej pracy (2026-11-01):** brak zdjęcia na klatkach bez błędu odtwarzacza (`NIE_ZNALEZIONO`/`PRZYPISANE_DO_INNEGO`) jest oznaczany jako „możliwy fałszywy wpis modelu” (osobna sekcja raportu, kolumna `zdjec_brak_podejrzane_wpisy`, bez ponawiania); `audyt_arkusze.mjs` (wołany przez `zbierz_rolki.ps1`) robi w `<kanał>\_audyt\` arkusz-obraz na zdjęcie + szablon audytu z md5. To skraca przegląd, ale go nie zastępuje.
- **TikTok (2.9.0, 2026-11-04):** `collect_tiktok` + `export_tiktok` (`src/tiktok.ts`): statystyki i transkrypt pojedynczych filmów przez Supadata `/metadata` i `/transcript`, bez Gemini. **Listy filmów kanału TikTok nie da się pobrać**: Supadata ma ją tylko dla YouTube, a strona TikToka daje captchę i pustą listę (zabezpieczeń nie obchodzimy), więc linki do filmów podaje użytkownik. Pierwsze wywołanie = 1 film jako próbka kosztu. Koszt metadanych w kredytach Supadata NIE jest udokumentowany (liczony wg nagłówka `x-billable-requests`, rezerwacja 1): sprawdzić na próbce. Wdrożenie tylko po zgodzie użytkownika.
- Poprawki potoku robić ogólnie (nie pod jeden film) i weryfikować audytem wzrokowym.

## Komendy
- Serwer: `npm install`, `npm test` (vitest), `npm run typecheck`, `npm run dev`, `npm run deploy`. Sekrety: `wrangler secret put <NAZWA>` (lista w `.dev.vars.example`). Nigdy nie commitować `.dev.vars`.
- Potok zrzutów: `cd zrzuty && npm install && npx playwright install chromium`; testy: `node test_kontekst.mjs <eksport_json>`, `node test_rozloz.mjs`, `node test_bramka.mjs`, `node test_naprawy.mjs`.
- Skrypty `.ps1` są pod Windows PowerShell (PC użytkownika: folder `C:\Users\coman\Desktop\yt-mcp\zrzuty`).

## Struktura repo
- `src/`, `test/`, `wrangler.jsonc` — serwer MCP (Cloudflare Workers).
- `scripts/` — PowerShell (Windows): `deploy.ps1`, `redeploy.ps1`, `secrets.ps1` (sekrety wpisujesz ukrytym promptem), `podlacz_gemini.ps1`, `pobierz*.ps1`, `gemini_prompt.txt`. Skrypty były pisane do uruchamiania z głównego folderu projektu (`$PSScriptRoot`) — po przeniesieniu do `scripts/` trzeba je uruchamiać z poprawioną ścieżką albo skopiować do korzenia.
- `zrzuty/` — potok zrzutów (Node + Playwright). `zrzuty/README.md` opisuje uruchamianie (część historyczna); aktualne zasady są w tym pliku. Nowe: `zbierz_rolki.ps1`, `rozloz_na_rolki.mjs` (foldery per rolka; z `--ocr` dopisuje automatyczną kontrolę tekstu na klatkach: `ocr_sprawdz.mjs`, `ocr_klatek.ps1`, `png_proste.mjs`). OCR pokazuje, co sprawdzić, ale nie zastępuje audytu wzrokowego; zgodność z audytem 16/16 (po korekcie jednej mojej pomyłki: Ethan jClk1CTeL6I#1 to częściowy, nie pełny; Ethan = 6 pełnych, 2 częściowe).
- Nie ma w repo: `wyniki/` (dane i paczki), `profil_przegladarki_programu/` (ciasteczka), podpisane linki eksportów (`pobierz_wszystko.ps1`), `deploy_log.txt`.
