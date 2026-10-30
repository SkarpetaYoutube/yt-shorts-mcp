# YouTube Shorts MCP — postęp i ustalenia (aktualizowane)
Cel: podaję rolki/kanał → paczka dla modelu: metadane, statystyki, komentarze, transkrypty z czasami, PRAWDZIWE screeny zdjęć z rozmów (screen rozmowy + wycinek zdjęcia) powiązane z wiadomościami. Opisy Gemini = dodatek.
Ograniczenia: Gemini tylko darmowy (250 wywołań/dzień wewn.), Supadata 300, bez płatności, bez kasowania danych, klucze nie są zapisywane.

## Stan (2026-10-26)
- Serwer 2.4.0 wdrożony: wizja + czasy transkryptu w eksporcie. 2.4.1 (gotowe, czeka na wdrożenie): `export_collection` z `read_file`+`set_id` — odczyt plików eksportu przez MCP (linki są blokowane z sesji Claude).
- Źródło klatek: (a) YouTube w przeglądarce użytkownika (odtwarzacz + canvas; przetestowane w panelu przeglądarki Claude), (b) lokalne MP4 w folderze (`--local`). Kontener Claude, VM i panel NIE mają dostępu do domeny workera ani do pobierania wideo z YouTube.
- Skrypty (folder `zrzuty/`): `zrzuty.mjs` (okno wokół czasu modelu, krok 0,25 s, pomiar rzeczywistego czasu, screen rozmowy + wycinek, flagi confirmed/overlaps_model_interval), `inpage.js` (detekcja ramki zdjęcia), `zloz_paczke.mjs` (jeden folder: paczka.md z obrazami, dane.json, frames/). Test lokalny na syntetycznym wideo: OK (wycinek znaleziony, zdjęcie poza oknem → NIEPOTWIERDZONE).
- Ręcznie nie da się uruchamiać poleceń w terminalu użytkownika (computer-use: terminal tylko klik) → wdrożenie i uruchomienie skryptów wykonuje użytkownik jedną komendą.
## Ustalenia pomiarowe
- 5 rolek: 72 s, 5/5 ok, 9 zdjęć znalezionych przez model, 10 istnieje (1 pominięte: pies w 2NVi2b5RmiY ~44,7–45,3 s), 0 fałszywych. Czasy modelu bywają za krótkie o 1–2 s (np. biurko 0–1,0 vs 0–3,75).
- 3 rolki: 28 s, 3/3.
- Pełne skanowanie klatek heurystyką = zbyt wiele fałszywych trafień (tylko generator kandydatów). Kompletność detekcji ≠ poprawność screenów.
## Odłożone (na prośbę użytkownika)
- Poprawa wykrywania zdjęć <1 s (pomysły: fps 3–4, drugie przejście na podejrzanych lukach, pomiar fps 2/3/4 na 2NVi2b5RmiY i EeZ2GB7WqSk).

## 2026-10-26 23:40 — pierwszy bieg na PC (3vCANkZ_hAU)
- Wynik: 0 obrazów; wszystkie 4: „Target page, context or browser has been closed" (po 13 s, strona otwarła się). Przyczyny nie ustalono (brak logu zdarzeń).
- Poprawki: zrzuty.mjs — świeża przeglądarka na rolkę, zdarzenia close/crash/disconnected/pageerror/nawigacje do `zrzuty\diagnostyka.log`, automatyczny fallback msedge→chrome→chromium, kod wyjścia 1 przy 0 obrazów. zloz_paczke.mjs — filtr rolek wg -Tylko/manifestu, przy 0 obrazów NIEPOWODZENIE.txt + nagłówek + kod 1. zrob_paczke.ps1 — używa już pobranego JSON, bez -Manifest.
- Test: assembler na prawdziwym eksporcie (60 segmentów czasu, 4 zdjęcia) + zapasowe zrzuty z panelu → 8 obrazów, paczka OK; przypadek 0 obrazów → NIEPOWODZENIE (exit 1).

## 2026-10-26 23:50 — drugi bieg na PC
- Edge działa, wideo gra, zdjęcie 1 OK (zmierzone 1,75–5 s; model 0–4). Przyczyna braków 2–4: YouTube przeładował stronę (nawigacja na ten sam URL) w trakcie pracy → „Execution context was destroyed", a potem brak wstrzykniętej biblioteki (`window.__fr` undefined). To NIE blokada YouTube ani zamknięcie przeglądarki przez użytkownika.
- Poprawki: odporność na przeładowanie (wykrycie braku biblioteki → ponowne przygotowanie strony → ponowienie zdjęcia, do 3 prób); wznawianie (zdjęcia już poprawne z obu plikami są zachowane, ponawiane tylko brakujące); status: KOMPLET / NIEPEŁNA (exit 2, NIEPELNA.txt, nagłówek) / NIEPOWODZENIE (0 obrazów, exit 1); PowerShell wypisuje WYNIK: KOMPLET|NIEPELNA|NIEPOWODZENIE i kończy kodem 1 dla niepełnej.
- Test lokalny z wymuszonym przeładowaniem strony i wznowieniem: OK.

## 2026-10-26 23:55 — jakość obrazów (trzeci bieg)
- Bieg 3: zdjęcia 1,2 OK (JPG 360x640), 3: getImageData width 0, 4: okno „92.5–NaN" — przyczyna wspólna: wideo przeładowane/niegotowe (duration NaN, videoWidth 0) po nawigacji YouTube.
- Jakość: na stronie filmu `movie_player.getAvailableQualityLevels()` = hd2160…small; `setPlaybackQualityRange('hd2160')` zmieniło źródło na 2160x3840 (sprawdzone w panelu). Skrypt: faza A (wykrycie+czas na domyślnej jakości), faza B (wybór hd1080 → hd1440 → hd2160 → hd720, czekanie na faktyczną zmianę videoWidth/Height, zapis PNG natywnie, pełna klatka + wycinek). Rozdzielczości w manifeście (source_resolution, photo_resolution, quality_note; przy ≤ niskiej jakości: OGRANICZENIE JAKOŚCI).
- Gotowość: seek/pngAt/refine czekają na readyState>=2, videoWidth>0, skończone duration; zerowy obszar → błąd NOT_READY → ponowne przygotowanie strony i ponowienie. Zdjęcie poza przedziałem modelu nie jest zapisywane (NIEPOTWIERDZONE). Przyczyny odrzuceń klatek zapisywane w note (diag).
- Stare pliki JPG zostają; wpis ma previous_files. Test lokalny 1080x1920 (wycinek 600x720 natywnie).

## 2026-10-27 00:15 — analiza biegu 4 (1080x1920)
- Zdjęcia 1,2: PNG 1080x1920, wycinki 306x450 i 414x450; treść sprawdzona wzrokiem (plakat „Samson", 02380 893939; buldog w kojcu). Zachowane (resume).
- Zdjęcia 3,4 — przyczyna: po `v.currentTime = ~60 s` wideo zawisa w readyState=1, playerState=2 (pauza), bez doładowania bufora; po kilku próbach YouTube pokazuje „Coś poszło nie tak" (webdriver=true). Skrypt sam zamyka przeglądarkę na końcu (finally); „page close" to nie awaria. Zdjęcia 1,2 (blisko początku) działają.
- Poprawka: seek przez `movie_player.seekTo` (+ playVideo jako wymuszenie bufora), przeładowanie strony z `&t=<sekundy>` (start blisko szukanego czasu), jakość stosowana po przeładowaniu. Ponowienie dotyczy tylko brakujących zdjęć.
- Uwaga: pusty plik zdjecie4_rozmowa.jpg (0 B) z wcześniejszego biegu zostaje (nie kasuję danych).

## 2026-10-27 00:30 — bieg 5: „KOMPLET", ale zdjęcie 4 miało zły wycinek
- Kontrola wzrokowa 8 obrazów: pary 1–3 poprawne; wycinek 4 = 864x858 ciemna klatka z innego momentu (ekran i wycinek robione osobnymi przewinięciami). Status KOMPLET był fałszywy → dodano walidację treści.
- W logu: autoplay przeniósł stronę na inny film (SBDf6HH0pJM, 90 s) i ustawiono na nim jakość; zapisy wykonano dopiero po powrocie, ale to było ryzyko.
- Poprawki: zabezpieczenie ID filmu (URL, player.getVideoData, długość ±3 s) przed każdym przewinięciem/zapisem; wyłączenie autoodtwarzania; blokada nawigacji do innego /watch?v= (page.route + pushState); capture() = jedno przewinięcie, ekran i wycinek z TEGO SAMEGO momentu, walidacja (wycinek ≤60% karty, ≤60% czerni); stare pliki nie są nadpisywane (.stary-<czas>.png); sukces wymaga verified.
- Manifest: 1–3 verified (kontrola wzrokowa), 4 cofnięte do niepotwierdzonego, zły wycinek przeniesiony (nie skasowany).

## Zamknięcie etapu (kontrola paczki 3 rolek)
- Paczka: wyniki\paczka_3vCANkZ_hAU\paczka\ — 24 obrazy PNG (12 par rozmowa+wycinek), wszystkie obejrzane i przypisane poprawnie; 24/24 odnośników w paczka.md działa; transkrypty z czasami: 60/57/61 segmentów.
- Dla modelu: paczka.md + cały folder frames\ (PNG) [+ dane.json]. Sam paczka.md ma tylko ścieżki względne.
- Poprawka: zloz_paczke.mjs przenosi stare pliki statusu do _stare_statusy\ (nic nie kasuje).
- Nie uruchomiono: testu 10 rolek, nowych wywołań Gemini/Supadata.
- Pomiar 5 rolek @KiroText: skrypt zrzuty\pomiar_5rolek.ps1 (osobne czasy faz); dane: job c-6d00d65f63a849a09f8bee0b, eksport s-2909e0c8fc9a4d27ac6a5687

## Zmiany 27.10 (przed testem wydajnosci)
- Przegladarka: JEDEN trwaly profil programu (profil_przegladarki_programu\<kanal>), jedna karta na cala partie, odtworzenie z tego samego profilu po awarii. NIE uzywa profilu osobistego. Bramka zgody (bramka.mjs): auto "Reject all"/"Odrzuc wszystko" (PL/EN, ramki, przekierowanie consent.*), CAPTCHA/logowanie/nietypowy ruch -> status WYMAGA_CZLOWIEKA, rolka pominieta, po 2 kolejnych blokadach reszta pominieta. Licznik interwencji w przebieg.json (cel: 0).
- Klatki kontekstowe (kontekst.mjs + inpage.contextScan/shotAt): wiadomosci potrzebne = messages_after (do last_visible+1,5 s) + related_messages, czas korygowany transkryptem (ogon wiadomosci); screen = najpozniejsza PELNA klatka ze zdjeciem (nieuciete) nie dalej niz t_ready+2,5 s; gdy zdjecie znika przed reakcja: screen zdjecia + (srodek) + osobny screen reakcji; kadr = karta rozmowy (bez tla gry); ciasny wycinek zdjecia zachowany. Bez nowych wywolan Gemini. Manifest: context_shots[], messages_needed, t_ready_s, context_complete.
- Testy lokalne: test_kontekst.mjs (dane 3vCANkZ_hAU zdj.1 i 4 + syntetyczne), test_bramka.mjs (EN/PL, cookies po restarcie, CAPTCHA), syntetyczny film end-to-end (KOMPLET). NIE sprawdzone na zywym YouTube/Edge.

## ZNANY BŁĄD (2026-10-27) — dobór kontekstu pomijał przedział między zdjęciem a reakcją
Rolka cN_DmOQ6PT4, zdjęcie 1: plan wybierał klatkę ze zdjęciem (0,3 s) i reakcję od 4,1 s, ale wiadomość „you wish” (ok. 3,0 s) jest widoczna razem z laptopem w przedziale 3,0–3,8 s, którego nie sprawdzano (po 3,85 s karty już nie ma).
Wzorzec oczekiwanego kadru (od użytkownika, tylko do porównania): cały panel rozmowy — laptop, nadawca „Dad ❤️” i trzy wiadomości łącznie z „you wish”, bez gameplayu.
Poprawka w programie: krok 1 sondowanie od chwili po ostatniej potrzebnej wiadomości (tReady, potem wcześniej co 0,3 s) — jeśli zdjęcie nadal widoczne w tym samym rozmiarze, jedna klatka zdjęcie+wiadomości; krok 2 dotychczasowa logika (klatka ze zdjęciem + osobna reakcja). Ręczne `--probe` zostaje tylko jako awaryjne, oznaczone `selection: RECZNY_AWARYJNY`.
Status: poprawka przetestowana lokalnie; weryfikacja na cN_DmOQ6PT4#1 w toku.
