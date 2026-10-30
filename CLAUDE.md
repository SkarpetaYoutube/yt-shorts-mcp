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

## Stan na 2026-10-30
Zestaw testowy `test_Dozzek_5` (5 rolek @Dozzektext, 15 zdjęć) po audycie wzrokowym: **10 pełnych zweryfikowanych**, 4 częściowe zweryfikowane (ELOpU#2, kHy#1, E2Byb#1, E2Byb#3), 1 brak (Ymlts#2). Szczegóły: `docs/STAN_2026-10-30.md`.

Zamknięty etap napraw (chooseShots bez awarii, własność przebiegów zdjęć, klasyfikacja błędów odtwarzacza, limity czasu, kategorie kontekstu, audyt) — **nie dokładać kolejnych poprawek pod konkretne filmy**. Jeśli test na 5 nowych rolkach nadal wymaga poprawek pod konkretne filmy, kończymy tę metodę i oceniamy alternatywę.

**Następny krok:** jeden test na 5 NOWYCH rolkach z innego kanału (nie Dozzek, nie KiroText), bez zmian kodu w trakcie:
```
powershell -ExecutionPolicy Bypass -File .\test_5_nowych.ps1 -Manifest "<link eksportu>" -Nazwa "test_<kanal>_5"
```
Maksymalny czas próby ok. 27,5 min (pobranie ≤2 min, zrzuty ≤25 min, ≤5 min na rolkę, +20 s wymuszonego zakończenia). `sprawdz_nowe.mjs` przerywa przed uruchomieniem przeglądarki, gdy rolki były już przetwarzane, brak wizji lub rolek ≠ 5. Limit Gemini (gemini-3.6-flash): 20 wywołań/dobę — najlepiej uruchamiać po resecie.

## Komendy
- Serwer: `npm install`, `npm test` (vitest), `npm run typecheck`, `npm run dev`, `npm run deploy`. Sekrety: `wrangler secret put <NAZWA>` (lista w `.dev.vars.example`). Nigdy nie commitować `.dev.vars`.
- Potok zrzutów: `cd zrzuty && npm install && npx playwright install chromium`; testy: `node test_kontekst.mjs`, `node test_bramka.mjs`, `node test_naprawy.mjs`.
- Skrypty `.ps1` są pod Windows PowerShell (PC użytkownika: folder `C:\Users\coman\Desktop\yt-mcp\zrzuty`).

## Struktura repo
- `src/`, `test/`, `wrangler.jsonc` — serwer MCP (Cloudflare Workers).
- `scripts/` — PowerShell (Windows): `deploy.ps1`, `redeploy.ps1`, `secrets.ps1` (sekrety wpisujesz ukrytym promptem), `podlacz_gemini.ps1`, `pobierz*.ps1`, `gemini_prompt.txt`. Skrypty były pisane do uruchamiania z głównego folderu projektu (`$PSScriptRoot`) — po przeniesieniu do `scripts/` trzeba je uruchamiać z poprawioną ścieżką albo skopiować do korzenia.
- `zrzuty/` — potok zrzutów (Node + Playwright). `zrzuty/README.md` jest częściowo historyczny; aktualne zasady są w tym pliku.
- Nie ma w repo: `wyniki/` (dane i paczki), `profil_przegladarki_programu/` (ciasteczka), podpisane linki eksportów (`pobierz_wszystko.ps1`), `deploy_log.txt`.
