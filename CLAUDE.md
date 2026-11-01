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
- **Serwer MCP: na produkcji 2.7.1; 2.7.2 (kolejka Gemini nie głodzi zbierania) jest w kodzie i GitHub, ale CZEKA NA WDROŻENIE (`npx wrangler deploy` w terminalu z `NODE_OPTIONS=--use-system-ca`).** Zbieranie (statystyki, transkrypt ze znacznikami czasu, 5 komentarzy, ranking kanału), wizja Gemini całego zadania (`analyze_images` z `job_id`, domyślnie tylko szacunek), eksport CSV/JSON/MD z pełną wizją (`vision_json` w CSV, `vision.run` z oryginalną odpowiedzią Gemini w JSON), `continue_collection` z `fill_timestamps`. Dane na serwerze są trzymane 30 dni: eksport zawsze pobierać na dysk.
- **Wszystko na raz (jedna rolka = jeden folder):** część serwerową (collect, wizja, export) robi Claude w rozmowie, potem lokalnie `zrzuty\zbierz_rolki.ps1 -Manifest "<link>"` daje `wyniki\<Kanał>\<Kanał> - <Tytuł> [<ID>]\` (dane.json/csv/md, zdjecia\, klatki\, zdjecia.md/json) oraz `_zbiorczo\` i `_zrzuty_robocze\`. Szczegóły: `zrzuty/README.md`.
- **Skuteczność zrzutów (Dr. Ethan, 5 rolek, 8 zdjęć):** po poprawkach (kadr „przed” robiony po ostatniej wiadomości, większy budżet ponowień w drugiej rundzie: `--reloads 4 --retry-budget 180 --buffer-wait 30`) 8/8 zdjęć złapanych, audyt wzrokowy: 7 pełnych, 1 częściowy. W wcześniejszych biegach na kilku kanałach YouTube często zrywał odtwarzacz (aerotxt, Dozzek): przy większych partiach liczyć się z ponowieniami.
- **Znane ograniczenia:** (1) kategoria „częściowy” bywa zaniżona, gdy kadr główny już pokazuje wiadomości przed zdjęciem, a osobnego kadru „przed” nie zapisano; (2) Gemini czasem błędnie etykietuje prawdziwe zdjęcie jako awatar (sprawdzać klatki); (3) zrzuty zależą od zachowania YouTube (buforowanie przy dalekich przewinięciach); (4) Node 24 na Windows po cichu nie usuwa folderów ze znakami spoza ASCII przez `fs.rmSync(recursive)`: używać ręcznego usuwania (jak w `rozloz_na_rolki.mjs`).
- Poprawki potoku robić ogólnie (nie pod jeden film) i weryfikować audytem wzrokowym.

## Komendy
- Serwer: `npm install`, `npm test` (vitest), `npm run typecheck`, `npm run dev`, `npm run deploy`. Sekrety: `wrangler secret put <NAZWA>` (lista w `.dev.vars.example`). Nigdy nie commitować `.dev.vars`.
- Potok zrzutów: `cd zrzuty && npm install && npx playwright install chromium`; testy: `node test_kontekst.mjs <eksport_json>`, `node test_rozloz.mjs`, `node test_bramka.mjs`, `node test_naprawy.mjs`.
- Skrypty `.ps1` są pod Windows PowerShell (PC użytkownika: folder `C:\Users\coman\Desktop\yt-mcp\zrzuty`).

## Struktura repo
- `src/`, `test/`, `wrangler.jsonc` — serwer MCP (Cloudflare Workers).
- `scripts/` — PowerShell (Windows): `deploy.ps1`, `redeploy.ps1`, `secrets.ps1` (sekrety wpisujesz ukrytym promptem), `podlacz_gemini.ps1`, `pobierz*.ps1`, `gemini_prompt.txt`. Skrypty były pisane do uruchamiania z głównego folderu projektu (`$PSScriptRoot`) — po przeniesieniu do `scripts/` trzeba je uruchamiać z poprawioną ścieżką albo skopiować do korzenia.
- `zrzuty/` — potok zrzutów (Node + Playwright). `zrzuty/README.md` opisuje uruchamianie (część historyczna); aktualne zasady są w tym pliku. Nowe: `zbierz_rolki.ps1`, `rozloz_na_rolki.mjs` (foldery per rolka).
- Nie ma w repo: `wyniki/` (dane i paczki), `profil_przegladarki_programu/` (ciasteczka), podpisane linki eksportów (`pobierz_wszystko.ps1`), `deploy_log.txt`.
