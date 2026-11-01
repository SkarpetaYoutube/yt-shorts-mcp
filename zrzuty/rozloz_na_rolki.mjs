// Rozkłada eksport kanału (CSV / JSON / Markdown z serwera MCP) i zrzuty zdjęć na osobne foldery, po jednym na rolkę:
//   <wyjście>\<Kanał>\<Kanał> - <Tytuł rolki> [<ID>]\
//     dane.json  dane.csv  dane.md      (tylko ta rolka: statystyki, transkrypt z czasami, komentarze, wizja Gemini)
//     zdjecia\   zdjecie1.png ...       (same zdjęcia: wycinki z klatek)
//     klatki\    zdjecie1_kontekst1_... (klatki rozmowy: zdjęcie z wiadomościami i kadry „przed”)
//     zdjecia.md zdjecia.json           (status każdego zdjęcia: co zapisano, czego brakuje i dlaczego)
//   <wyjście>\<Kanał>\_zbiorczo\        (pliki eksportu całego kanału bez zmian)
// Nic nie jest zmyślane ani skracane: dane.* to dokładnie rekord / wiersz / sekcja z eksportu serwera.
// Użycie: node rozloz_na_rolki.mjs <folder_eksportu> <folder_zrzutow | -> <folder_wyjsciowy> [--only ID,ID]
//   folder_eksportu: folder z plikami pobranymi przez pobierz_zestaw.ps1 (*_json.json, *_csv.csv, *_md-N.md, *_status.json)
//   folder_zrzutow: folder, w którym zrzuty.mjs zapisało frames_manifest.json i frames\ ("-" = bez zrzutów)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { contextCategory, CTX_LABEL, shotFiles } from "./kontekst.mjs";
import { wierszIndeksu, zapiszIndeks, scalBaze, raportPartii } from "./indeks_i_baza.mjs";
import { uruchomOcr, ocenaOcr } from "./ocr_sprawdz.mjs";

// ------------------------------------------------------------------------------------------------ nazwy
/** Nazwa bezpieczna dla Windows: bez znaków niedozwolonych w nazwach, bez emoji, bez kropek i spacji na końcu, skrócona. */
export function bezpiecznaNazwa(s, max = 80, zapas = "bez nazwy") {
  let t = String(s ?? "")
    .replace(/[\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > max) t = t.slice(0, max).trim();
  t = t.replace(/[. ]+$/g, "");
  return t || zapas;
}
/** „Kanał - Tytuł rolki [ID]”: ID na końcu, bo tytuły się powtarzają. */
export const nazwaFolderuRolki = (kanal, tytul, id) => `${bezpiecznaNazwa(kanal, 40, "kanal")} - ${bezpiecznaNazwa(tytul, 80, "bez tytulu")} [${id}]`;

// ------------------------------------------------------------------------------------------------ CSV
/** Parser CSV zgodny z RFC 4180 (jak w serwerze). */
export function parseCsv(text) {
  const rows = []; let row = [], f = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else inQ = false; } else f += c; }
    else if (c === '"') inQ = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\r") { /* zjedz */ }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const csvQ = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Nagłówek + jeden wiersz, z BOM i CRLF (jak w eksporcie). */
export const csvJedenWiersz = (header, row) => "﻿" + header.map(csvQ).join(",") + "\r\n" + row.map(csvQ).join(",") + "\r\n";

// ------------------------------------------------------------------------------------------------ Markdown
/** Sekcja jednej rolki z paczki Markdown (od nagłówka „## N. …” do „---”), znaleziona po linii „- ID: `id`”. */
export function sekcjaMd(mdTekst, id) {
  const marker = `- ID: \`${id}\``;
  const at = mdTekst.indexOf(marker);
  if (at < 0) return null;
  const start = mdTekst.lastIndexOf("\n## ", at) + 1;
  const koniec = mdTekst.indexOf("\n---\n", at);
  return mdTekst.slice(start, koniec < 0 ? undefined : koniec + 5).trim() + "\n";
}

/**
 * Usuwa folder plik po pliku. Nie używamy fs.rmSync(recursive): w Node 24 na Windows po cichu nie usuwa folderów, w których ścieżce są polskie znaki
 * (np. „Kanał - zdjęciami”), i zostawiałoby stare pliki. Po usunięciu sprawdzamy, że folderu nie ma.
 */
function usunFolder(p) {
  if (!fs.existsSync(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    if (e.isDirectory()) usunFolder(q); else fs.unlinkSync(q);
  }
  fs.rmdirSync(p);
  if (fs.existsSync(p)) throw new Error("Nie udało się usunąć folderu: " + p);
}

// ------------------------------------------------------------------------------------------------ zdjęcia
/** Nazwa pliku w folderze rolki: bez „_wycinek” i bez „_probaN” (oznaczenie rundy ponowienia zrzutów). */
const czystaNazwa = (p) => path.basename(p).replace(/_wycinek/, "").replace(/_proba\d+/, "");
const clock = (s) => { s = Math.max(0, Number(s) || 0); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
const msgs = (a) => (a?.length ? a.map((m) => `${m.t ?? "?"} ${m.sender ?? "?"}: ${m.text}`).join(" | ") : "brak");

/** Opis zdjęć rolki z wizji (Gemini) i wpisów zrzutów. Brak wpisu zrzutów = jawny status, nie cisza. */
export function opisZdjec(rec, man, exists, md5Of) {
  const wpisy = man.filter((m) => m.video_id === rec.video_id);
  const obrazy = rec.vision?.images ?? [];
  const idy = [...new Set([...obrazy.map((i) => i.id), ...wpisy.map((m) => m.image_id)])].filter((x) => x != null).sort((a, b) => a - b);
  return idy.map((id) => {
    const g = obrazy.find((i) => i.id === id) ?? null;
    const e = wpisy.find((m) => m.image_id === id) ?? null;
    const kategoria = e ? contextCategory(e, exists, md5Of) : null;
    return {
      image_id: id,
      gemini: g ? { first_visible: g.first_visible, last_visible: g.last_visible, description_pl: g.description_pl, text_in_image: g.text_in_image, sent_by: g.sent_by, messages_before: g.messages_before, messages_after: g.messages_after, uncertainty_pl: g.uncertainty_pl } : null,
      zrzuty: e
        ? { status: e.status, kategoria_kontekstu: kategoria, opis_kategorii: CTX_LABEL[kategoria], zmierzony_przedzial_s: [e.measured_first_s ?? null, e.measured_last_s ?? null], wycinek: e.photo_file && exists(e.photo_file) ? e.photo_file : null, klatki: shotFiles(e, exists).map((s) => ({ rola: s.role, plik: s.file, t_s: s.t_s, zdjecie_widoczne: !!s.photo_visible })), uwaga_programu: e.note ?? null, sprawdzenie_wzrokowe: e.content_check ?? null }
        : null,
      status_pl: e ? CTX_LABEL[kategoria] : rec.vision ? "zrzutów dla tego zdjęcia nie wykonano (brak wpisu w manifeście zrzutów)" : "brak analizy wizji i zrzutów",
    };
  });
}

/** Jednozdaniowy opis wyniku OCR dla zdjęcia. */
export function opisOcr(o) {
  if (o.status === "OCR_PELNY") return `wszystkie wiadomości z wizji, które da się sprawdzić (${o.widoczne.length}), są widoczne na klatkach`;
  if (o.status === "OCR_CZESCIOWY") return `NIE widać na klatkach: ${o.brakuje.map((x) => `„${x}”`).join(", ")} (widoczne: ${o.widoczne.length})`;
  if (o.status === "OCR_BRAK_KLATEK") return "brak klatek do sprawdzenia";
  if (o.status === "OCR_BLAD") return `OCR niedostępny (${o.blad ?? "?"})`;
  return "wizja nie podała wiadomości do porównania";
}

function zdjeciaMd(rec, opis, zrzutyWykonane) {
  const L = [`# Zdjęcia w rolce: ${rec.title}`, "", `- ID: \`${rec.video_id}\` | link: ${rec.url}`, `- Status wizji (Gemini): ${rec.vision_status}`];
  if (!zrzutyWykonane) L.push("- Zrzuty klatek: nie wykonano dla tego eksportu.");
  L.push("");
  if (!opis.length) {
    L.push(rec.vision ? "Model nie wykrył żadnego zdjęcia w rozmowie (to ocena modelu, nie dowód braku zdjęć)." : `Brak danych o zdjęciach: wizja ma status „${rec.vision_status}”.`, "");
    return L.join("\n");
  }
  for (const z of opis) {
    L.push(`## Zdjęcie ${z.image_id}`, "");
    if (z.gemini) {
      L.push(`- Czas wg Gemini: ${z.gemini.first_visible ?? "?"}–${z.gemini.last_visible ?? "?"} | nadawca: ${z.gemini.sent_by ?? "?"}`);
      L.push(`- Opis (Gemini, niezweryfikowany): ${z.gemini.description_pl ?? "brak"}`);
      if (z.gemini.text_in_image) L.push(`- Tekst na zdjęciu: ${z.gemini.text_in_image}`);
      L.push(`- Wiadomości przed (Gemini): ${msgs(z.gemini.messages_before)}`, `- Wiadomości po (Gemini): ${msgs(z.gemini.messages_after)}`);
      if (z.gemini.uncertainty_pl) L.push(`- Niepewność wg Gemini: ${z.gemini.uncertainty_pl}`);
    } else L.push("- Gemini nie wykryło tego zdjęcia (wpis pochodzi ze zrzutów).");
    L.push(`- **Status: ${z.status_pl}**`);
    if (z.ocr) L.push(`- Automatyczna kontrola tekstu (OCR): ${opisOcr(z.ocr)} (sprawdza tylko teksty wiadomości z wizji na zapisanych klatkach, nie treść zdjęcia; nie zastępuje przeglądu wzrokowego)`);
    if (z.zrzuty) {
      const r = z.zrzuty;
      L.push(`- Zmierzone na klatkach: ${r.zmierzony_przedzial_s[0] != null ? `${clock(r.zmierzony_przedzial_s[0])}–${clock(r.zmierzony_przedzial_s[1])}` : "brak"} | status zrzutu: ${r.status}`);
      L.push(`- Samo zdjęcie: ${r.wycinek ? `\`zdjecia\\${czystaNazwa(r.wycinek)}\`` : r.klatka_zamiast_wycinka ? `brak wycinka (program nie potwierdził granic zdjęcia); w zdjecia\\ jest klatka rozmowy, na której zdjęcie widać: \`${r.klatka_zamiast_wycinka}\`` : "brak pliku"}`);
      for (const k of r.klatki) L.push(`- Klatka (${k.rola}, ${clock(k.t_s)}): \`klatki\\${czystaNazwa(k.plik)}\``);
      if (r.uwaga_programu) L.push(`- Uwaga programu: ${r.uwaga_programu}`);
      if (r.sprawdzenie_wzrokowe) L.push(`- Sprawdzenie wzrokowe: ${r.sprawdzenie_wzrokowe.result} (${r.sprawdzenie_wzrokowe.checked_by ?? "?"}, ${r.sprawdzenie_wzrokowe.checked_at ?? "?"})${r.sprawdzenie_wzrokowe.note ? ` — ${r.sprawdzenie_wzrokowe.note}` : ""}`);
    }
    L.push("");
  }
  return L.join("\n");
}

// ------------------------------------------------------------------------------------------------ główna funkcja
const znajdz = (dir, re) => fs.readdirSync(dir).filter((f) => re.test(f)).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).map((f) => path.join(dir, f));

/** Zwraca podsumowanie: lista rolek (folder, liczba zdjęć, kategorie). */
export function rozloz({ eksportDir, zrzutyDir = null, wyjscie, only = null, ocr = false }) {
  const jsonFile = znajdz(eksportDir, /_json\.json$|^json\.json$/)[0];
  if (!jsonFile) throw new Error(`Brak pliku *_json.json w ${eksportDir}`);
  const csvFile = znajdz(eksportDir, /_csv\.csv$/)[0] ?? null;
  const mdFiles = znajdz(eksportDir, /_md-\d+\.md$/);
  const statusFile = znajdz(eksportDir, /_status\.json$/)[0] ?? null;
  const recs = JSON.parse(fs.readFileSync(jsonFile, "utf8")).filter((r) => !only || only.includes(r.video_id));
  const csv = csvFile ? parseCsv(fs.readFileSync(csvFile, "utf8").replace(/^﻿/, "")) : null;
  const csvHeader = csv?.[0] ?? null, csvId = csvHeader ? csvHeader.indexOf("video_id") : -1;
  const md = mdFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const man = zrzutyDir && fs.existsSync(path.join(zrzutyDir, "frames_manifest.json")) ? JSON.parse(fs.readFileSync(path.join(zrzutyDir, "frames_manifest.json"), "utf8")) : [];
  const exists = (f) => !!f && !!zrzutyDir && fs.existsSync(path.join(zrzutyDir, f));
  const md5Of = (f) => { try { return crypto.createHash("md5").update(fs.readFileSync(path.join(zrzutyDir, f))).digest("hex"); } catch { return null; } };
  // opis zdjęć wszystkich rolek z góry; opcjonalnie jedno uruchomienie OCR dla wszystkich klatek (kontrola, czy wiadomości z wizji są widoczne na zapisanych klatkach)
  const opisMap = new Map(recs.map((r) => [r.video_id, opisZdjec(r, man, exists, md5Of)]));
  if (ocr && zrzutyDir) {
    const pliki = [...new Set([...opisMap.values()].flatMap((o) => o.flatMap((z) => (z.zrzuty?.klatki ?? []).map((k) => path.join(zrzutyDir, k.plik)))))];
    const wyn = uruchomOcr(pliki);
    for (const o of opisMap.values()) for (const z of o) {
      if (!z.zrzuty?.klatki?.length) continue;
      const wyniki = z.zrzuty.klatki.map((k) => wyn.get(path.join(zrzutyDir, k.plik)));
      const blad = wyniki.find((x) => !x || x.error);
      z.ocr = blad ? { status: "OCR_BLAD", blad: blad?.error ?? "brak wyniku", widoczne: [], brakuje: [], pominiete: [] }
        : ocenaOcr([...(z.gemini?.messages_before ?? []), ...(z.gemini?.messages_after ?? [])], wyniki.map((x) => x.text));
    }
  }
  const wynik = [];
  const pozycje = [];
  const kanaly = new Set();
  for (const rec of recs) {
    const kanalDir = path.join(wyjscie, bezpiecznaNazwa(rec.channel_title || rec.channel_handle, 40, "kanal"));
    kanaly.add(kanalDir);
    const dir = path.join(kanalDir, nazwaFolderuRolki(rec.channel_title || rec.channel_handle, rec.title, rec.video_id));
    fs.mkdirSync(dir, { recursive: true });
    // dane tej rolki: dokładnie rekord JSON, wiersz CSV i sekcja Markdown z eksportu
    fs.writeFileSync(path.join(dir, "dane.json"), JSON.stringify(rec, null, 1));
    const wiersz = csv && csvId >= 0 ? csv.slice(1).find((r) => r[csvId] === rec.video_id) : null;
    if (wiersz) fs.writeFileSync(path.join(dir, "dane.csv"), csvJedenWiersz(csvHeader, wiersz));
    const sekcja = md ? sekcjaMd(md, rec.video_id) : null;
    if (sekcja) fs.writeFileSync(path.join(dir, "dane.md"), sekcja);
    // zdjęcia i klatki: foldery odtwarzane od zera (pochodne zrzutów), reszta plików zostaje
    for (const sub of ["zdjecia", "klatki"]) usunFolder(path.join(dir, sub));
    const opis = opisMap.get(rec.video_id);
    let wycinki = 0, klatki = 0;
    for (const z of opis) {
      if (!z.zrzuty) continue;
      if (z.zrzuty.wycinek) { fs.mkdirSync(path.join(dir, "zdjecia"), { recursive: true }); fs.copyFileSync(path.join(zrzutyDir, z.zrzuty.wycinek), path.join(dir, "zdjecia", czystaNazwa(z.zrzuty.wycinek))); wycinki++; }
      else {
        // brak potwierdzonego wycinka (detektor nie ustalił granic zdjęcia): w zdjecia\ trafia klatka rozmowy, na której zdjęcie widać, z jawnym oznaczeniem w nazwie
        const k = z.zrzuty.klatki.find((x) => x.zdjecie_widoczne);
        if (k) { fs.mkdirSync(path.join(dir, "zdjecia"), { recursive: true }); fs.copyFileSync(path.join(zrzutyDir, k.plik), path.join(dir, "zdjecia", `zdjecie${z.image_id}_klatka_ze_zdjeciem.png`)); z.zrzuty.klatka_zamiast_wycinka = `zdjecia\\zdjecie${z.image_id}_klatka_ze_zdjeciem.png`; }
      }
      for (const k of z.zrzuty.klatki) { fs.mkdirSync(path.join(dir, "klatki"), { recursive: true }); fs.copyFileSync(path.join(zrzutyDir, k.plik), path.join(dir, "klatki", czystaNazwa(k.plik))); klatki++; }
    }
    fs.writeFileSync(path.join(dir, "zdjecia.json"), JSON.stringify({ video_id: rec.video_id, vision_status: rec.vision_status, zrzuty_wykonane: man.some((m) => m.video_id === rec.video_id), zdjecia: opis }, null, 1));
    fs.writeFileSync(path.join(dir, "zdjecia.md"), zdjeciaMd(rec, opis, man.some((m) => m.video_id === rec.video_id)));
    const kategorie = {};
    for (const z of opis) { const k = z.zrzuty?.kategoria_kontekstu ?? "BRAK_ZRZUTU"; kategorie[k] = (kategorie[k] ?? 0) + 1; }
    wynik.push({ video_id: rec.video_id, folder: dir, zdjec: opis.length, wycinki, klatki, kategorie, ma_csv: !!wiersz, ma_md: !!sekcja });
    pozycje.push({ kanalDir, rec, opis, folder: path.relative(kanalDir, dir) });
  }
  // pliki eksportu całego kanału: bez zmian, do _zbiorczo
  for (const kanalDir of kanaly) {
    const zb = path.join(kanalDir, "_zbiorczo");
    fs.mkdirSync(zb, { recursive: true });
    const przedrostek = path.basename(kanalDir);
    for (const f of [jsonFile, csvFile, ...mdFiles, statusFile].filter(Boolean)) {
      const koncowka = /(_csv\.csv|_json\.json|_md-\d+\.md|_status\.json)$/.exec(path.basename(f));
      fs.copyFileSync(f, path.join(zb, koncowka ? przedrostek + koncowka[1] : path.basename(f))); // np. Dozzek_json.json zamiast nazwy folderu tymczasowego
    }
  }
  // indeks kanału (jedna linia na rolkę, z tego eksportu) i lokalna baza główna (scala kolejne eksporty, zachowuje historię wyświetleń)
  const baza = {};
  for (const kanalDir of kanaly) {
    const moje = pozycje.filter((p) => p.kanalDir === kanalDir);
    const nazwa = path.basename(kanalDir);
    zapiszIndeks(path.join(kanalDir, "_zbiorczo"), nazwa, moje.map((p, i) => wierszIndeksu(p.rec, p.opis, i + 1, p.folder)));
    let przebieg = null; try { przebieg = zrzutyDir ? JSON.parse(fs.readFileSync(path.join(zrzutyDir, "przebieg.json"), "utf8")) : null; } catch { /* brak przebiegu: raport bez danych odtwarzacza */ }
    fs.writeFileSync(path.join(kanalDir, "_zbiorczo", "RAPORT_PARTII.md"), raportPartii({ kanal: nazwa, pozycje: moje, przebieg }));
    const b = scalBaze(path.join(kanalDir, "_baza"), nazwa, moje.map((p) => ({ rec: p.rec, opis: p.opis, folder: p.folder })));
    baza[nazwa] = { rolek_w_bazie: b.rolek, nowe: b.nowe, odswiezone: b.odswiezone };
  }
  return { rolek: wynik.length, kanaly: [...kanaly], rolki: wynik, baza };
}

// ------------------------------------------------------------------------------------------------ CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  // pomocnicze dla zbierz_rolki.ps1: nazwa folderu kanału i lista ID rolek, które mają zdjęcia wg wizji
  if (args[0] === "--kanal" || args[0] === "--ids") {
    const jf = znajdz(args[1], /_json\.json$|^json\.json$/)[0];
    if (!jf) { console.error("Brak pliku *_json.json w " + args[1]); process.exit(2); }
    const rows = JSON.parse(fs.readFileSync(jf, "utf8"));
    console.log(args[0] === "--kanal" ? bezpiecznaNazwa(rows[0]?.channel_title || rows[0]?.channel_handle, 40, "kanal") : rows.filter((r) => r.vision?.images?.length).map((r) => r.video_id).join(","));
    process.exit(0);
  }
  const oi = args.indexOf("--only");
  const only = oi >= 0 ? args.splice(oi, 2)[1].split(",") : null;
  const ocrI = args.indexOf("--ocr"); const ocr = ocrI >= 0; if (ocr) args.splice(ocrI, 1);
  const [eksportDir, zrzutyDir, wyjscie] = args;
  if (!eksportDir || !zrzutyDir || !wyjscie) { console.error("Użycie: node rozloz_na_rolki.mjs <folder_eksportu> <folder_zrzutow | -> <folder_wyjsciowy> [--only ID,ID]"); process.exit(2); }
  const r = rozloz({ eksportDir, zrzutyDir: zrzutyDir === "-" ? null : zrzutyDir, wyjscie, only, ocr });
  const sumy = {};
  for (const x of r.rolki) for (const [k, v] of Object.entries(x.kategorie)) sumy[k] = (sumy[k] ?? 0) + v;
  for (const x of r.rolki) console.log(`${x.video_id}: zdjęć ${x.zdjec}, wycinków ${x.wycinki}, klatek ${x.klatki}${x.ma_csv ? "" : " (BRAK wiersza CSV)"}${x.ma_md ? "" : " (BRAK sekcji MD)"} → ${x.folder}`);
  console.log(`ROZŁOŻONO: ${r.rolek} rolek; zdjęcia wg kategorii: ${JSON.stringify(sumy)}`);
  for (const [k, b] of Object.entries(r.baza)) console.log(`BAZA ${k}: ${b.rolek_w_bazie} rolek w bazie lokalnej (nowe ${b.nowe}, odświeżone ${b.odswiezone}); indeks: ${k}\\_zbiorczo\\indeks_rolek.csv`);
  const brakuje = r.rolki.reduce((a, x) => a + Object.entries(x.kategorie).filter(([k]) => k === "BRAK" || k === "BRAK_ZRZUTU").reduce((b, [, v]) => b + v, 0), 0);
  process.exit(brakuje ? 2 : 0);
}
