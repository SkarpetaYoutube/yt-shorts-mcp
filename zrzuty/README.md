# Zrzuty klatek (uruchamiane u Ciebie)

Wymaga: Node.js. Jednorazowo w tym folderze:  npm install   (instaluje playwright; przeglądarką jest Edge lub Chrome, które już masz)

Użycie (PowerShell), po pobraniu eksportu JSON z wynikami wizji:
  node zrzuty.mjs ..\wyniki\dozzek5_v24\dozzek5_v24_json.json ..\wyniki\dozzek5_v24\obrazy --channel msedge
Opcje: --only ID,ID (tylko wybrane rolki), --pause 6 (sekundy przerwy między rolkami), --channel chrome.

Wynik: obrazy\frames\<ID>\img<N>_t<sek>.jpg, frames_manifest.json oraz obrazy.md (opis, powiązania i klatki obok siebie).
Skrypt otwiera rolkę jak zwykły widz, przewija na czasy z eksportu i zapisuje klatkę. Nie pobiera plików wideo, nie omija reklam ani logowania.
Przetestowany tylko na lokalnym wideo; na YouTube jeszcze nie uruchomiony. Wycinek samego zdjęcia nie jest robiony automatycznie (model nie podaje współrzędnych).
Uwaga: automatyczne otwieranie YouTube skryptem może być sprzeczne z jego regulaminem; decyzja o użyciu należy do Ciebie.
