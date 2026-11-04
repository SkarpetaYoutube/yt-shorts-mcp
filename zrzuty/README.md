# Zrzuty klatek (uruchamiane na Twoim komputerze)

Dla każdego zdjęcia z czatu w rolce zapisuje PRAWDZIWE klatki z wideo: panel rozmowy z wiadomościami, które zdjęcie tłumaczą, oraz ciasny wycinek samego zdjęcia.
Czasy z Gemini są tylko wskazówką; zdjęcie jest mierzone na klatkach (krok 0,25 s). Aktualne zasady pracy są w `CLAUDE.md` w korzeniu repo.

Wymaga: Node.js i Edge albo Chrome (już masz). Jednorazowo w tym folderze: `npm install`.
Skrypty `.ps1` działają z folderu `zrzuty\`; `pobierz_zestaw.ps1` jest szukany w korzeniu projektu albo w `scripts\`.

## Wszystko na raz: foldery per rolka (zalecane)
```
powershell -ExecutionPolicy Bypass -File .zbierz_rolki.ps1 -Manifest "<link manifest z export_collection>"
```
Część serwerowa (zbieranie, wizja Gemini, eksport) robi Claude w rozmowie i podaje link manifest; skrypt pobiera eksport, robi zrzuty (z drugą rundą dla brakujących) i układa wynik tak:
```
wyniki<Kanał><Kanał> - <Tytuł rolki> [<ID>]    dane.json  dane.csv  dane.md        statystyki, transkrypt z czasami, komentarze, wizja Gemini (tylko ta rolka, bez zmian względem eksportu)
    zdjecia   zdjecie1.png ...        same zdjęcia
    klatki    zdjecie1_kontekst1_...   rozmowa z kontekstem i kadry „przed”
    zdjecia.md  zdjecia.json            status każdego zdjęcia (jest / brak zrzutu i dlaczego; „pełny” bez przeglądu wzrokowego = wg programu)
wyniki<Kanał>_zbiorczo             eksport całego kanału (CSV / JSON / Markdown / status)
wyniki<Kanał>_zrzuty_robocze       surowe zrzuty, manifest i logi; ponowne uruchomienie wznawia
wyniki<Kanał>_zbiorczoindeks_rolek.csv/md  jedna linia na rolkę: statystyki, ranking, status zdjęć, folder
wyniki<Kanał>_bazaaza_rolek.json/csv      lokalna baza kanału: scala kolejne eksporty (bez duplikatów), zachowuje historię wyświetleń
```
Opcje: `-Tylko ID,ID` (wybrane rolki), `-BezZrzutow` (same dane, bez YouTube), `-BezDrugiejRundy`, `-MaxCalosc`, `-MaxRolka`, `-Wynik <folder>`. Kod wyjścia: 0 komplet, 2 część zdjęć bez zrzutu, 4 limit czasu.
Sam rozkład na foldery bez przeglądarki: `node rozloz_na_rolki.mjs <folder_eksportu> <folder_zrzutow|-> <folder_wyjsciowy>`; test: `node test_rozloz.mjs`.

## Najprostsze uruchomienie (5 nowych rolek jednego kanału)
```
powershell -ExecutionPolicy Bypass -File .\test_5_nowych.ps1 -Manifest "<link manifest z export_collection>" -Nazwa "test_<kanal>_5"
```
- Pobiera eksport, odmawia startu, jeśli rolki były już przetwarzane albo nie mają wizji (kody 5/6/7), potem robi zrzuty i składa paczkę.
- **Druga runda:** gdy część zdjęć się nie udała (np. chwilowy błąd odtwarzacza YouTube), skrypt robi jedną ponowną próbę tylko brakujących, ze świeżym budżetem ponowień i z reszty limitu czasu. Wyłączenie: `-BezDrugiejRundy`.
- Kod wyjścia skryptu: 0 komplet, 2 niepełna, 4 limit czasu.
- Limity: `-MaxCalosc 1500` (cała próba, s), `-MaxRolka 300` (jedna rolka, s).

## Bezpośrednio
```
node zrzuty.mjs <eksport.json> <folder_wyjsciowy> [--channel msedge|chrome|chromium] [--only ID,ID] [--pause 6] [--max-total 1500] [--reel-max 300] [--local <folder_z_mp4>]
node zloz_paczke.mjs <eksport.json> <folder_zrzutow> <folder_paczki> [ID,ID]
node audyt.mjs <folder_zrzutow> <audyt.json>
```
Ponowne uruchomienie na tym samym folderze wznawia: dobre wyniki zostają, a gorsza próba nie zastępuje lepszej (`mergeBest`). Poprzedni `diagnostyka.log` i `przebieg.json` dostają sygnaturę czasu (`*.stary-<czas>.*`), nic nie jest nadpisywane.

## Wynik
`frames/<ID>/zdjecie<N>_kontekst<k>_<rola>.png` (role: `zdjecie_i_reakcja`, `zdjecie_widoczne`, `w_trakcie`, `reakcja`, `przed`), `*_wycinek.png`, `frames_manifest.json`, `przebieg.json`, `diagnostyka.log`; paczka: `paczka.md`, `AUDYT_KONTEKSTU.md`, `KONTEKST...`, `frames/`.
Kategorie kontekstu: PELNY_ZWERYFIKOWANY > PELNY_NIEZWERYFIKOWANY > CZESCIOWY_ZWERYFIKOWANY > CZESCIOWY_NIEZWERYFIKOWANY > BRAK. Program nie czyta tekstu na klatkach, więc „pełny” bez audytu wzrokowego znaczy tylko „wg programu”. Ocena z `audyt.mjs` jest związana z plikami (nazwy i md5): zmiana kadru unieważnia ją.

## Kadr „przed” (wiadomości sprzed zdjęcia)
Zdjęcie wjeżdża na kartę rozmowy i wypycha starsze wiadomości, więc kadr ze zdjęciem często ich nie pokazuje. Gdy wizja podała `messages_before`, robiony jest dodatkowy kadr roli `przed`: czas z wizji i wiadomości „przed” (nie z początku zmierzonego ciągu), odrzucany, jeśli zdjęcie już widać albo karta ma inną szerokość (animacja). Jego niepowodzenie nie psuje reszty: ustawia tylko `before_complete=false` (kategoria „częściowy”) i nie zużywa budżetu przeładowań rolki. Pierwsze podejścia (czas od początku ciągu i sondowanie wstecz) zawiodły na żywo; opis w `docs/`.

## Testy logiki (bez przeglądarki, bez API)
```
node test_kontekst.mjs <eksport_z_3vCANkZ_hAU.json>
node test_naprawy.mjs <test_Dozzek_5_json.json> <frames_manifest.json>
node test_bramka.mjs      # wymaga Chromium od Playwrighta: npx playwright install chromium
```

Uwaga: automatyczne otwieranie YouTube skryptem może być sprzeczne z jego regulaminem; decyzja o użyciu należy do Ciebie. Skrypt otwiera rolkę jak zwykły widz, nie pobiera plików wideo, nie omija reklam ani logowania.

## Automatyczna kontrola klatek (OCR)
`zbierz_rolki.ps1` wywołuje `rozloz_na_rolki.mjs ... --ocr`: OCR wbudowany w Windows (offline, `ocr_klatek.ps1`, wstępna obróbka w `png_proste.mjs`, dopasowanie w `ocr_sprawdz.mjs`) sprawdza, czy teksty wiadomości z wizji (przed/po zdjęciu) są widoczne na zapisanych klatkach. Wynik trafia do `zdjecia.md`, kolumn `ocr_zdjec_bez_brakow` / `ocr_zdjec_z_brakami` indeksu i do sekcji „Rozbieżność” w `RAPORT_PARTII.md`, gdy ocena „pełny” nie zgadza się z OCR. To NIE zastępuje audytu wzrokowego: OCR nie ocenia treści zdjęcia i bywa omylny (np. t/ł). Zgodność z ocenami wzrokowymi na 16 zdjęciach: 16/16 po korekcie jednej pomyłki audytu (jClk1CTeL6I#1).

## Mniej ręcznej pracy przy przeglądzie (2026-11-01)
- **Wpis modelu bez zdjęcia na klatkach** (`NIE_ZNALEZIONO` / `PRZYPISANE_DO_INNEGO` bez błędu odtwarzacza): raport i `zdjecia.md` oznaczają go osobno („możliwy fałszywy wpis modelu”, np. awatar), liczą w kolumnie `zdjec_brak_podejrzane_wpisy` i NIE dodają rolki do komendy ponowienia, bo ponawianie tego nie naprawi. Błąd odtwarzacza zostaje na liście do ponowienia.
- **Arkusze audytu** (`audyt_arkusze.mjs <folder_kanalu>`, wywoływane automatycznie przez `zbierz_rolki.ps1`): w `<kanał>\_audyt\` jeden obraz na zdjęcie (klatki kontekstu jedna pod drugą), `ARKUSZE.md` z wiadomościami z wizji obok i `audyt_szablon.json` z gotowymi plikami i sumami md5 (do wypełnienia: `result`, `missing`; potem `node audyt.mjs <kanał>\_zrzuty_robocze <audyt.json>`). Program niczego nie ocenia, tylko skraca przegląd; `--wszystkie` obejmuje też już sprawdzone.

## TikTok: lokalny układ wyników (2026-11-05)
`.\zbierz_tiktok.ps1 -Manifest "<manifest_link z export_tiktok>"` pobiera eksport (SHA-256) i układa go przez `tiktok_rozloz.mjs`:
- `wyniki\TikTok - <konto>\<konto> - <opis> [<ID>]\`: `dane.md` (karta: statystyki, stosunki, tagi, opis, transkrypt), `dane.json`, `dane.csv`, `transkrypt.txt` (czysty tekst), `transkrypt_czasy.txt`.
- `_zbiorczo\`: `indeks_filmow.csv/md` (jedna linia na film, od najnowszego), `do_analizy.md` (wszystkie filmy konta w jednym pliku do wklejenia czatowi), `eksport_serwera\` (oryginalne pliki).
- `_baza\`: `baza_filmow.json/csv` scala kolejne eksporty bez duplikatów, z historią statystyk (przyrost wyświetleń od pierwszego pomiaru) i kopiami zapasowymi.
Test: `node test_tiktok.mjs`.
