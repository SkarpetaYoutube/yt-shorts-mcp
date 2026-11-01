// Test rozkładu eksportu na foldery per rolka (bez przeglądarki, bez API, bez sieci): node test_rozloz.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { bezpiecznaNazwa, nazwaFolderuRolki, parseCsv, sekcjaMd, rozloz, opisZdjec } from "./rozloz_na_rolki.mjs";
import { tokeny, ocenaOcr } from "./ocr_sprawdz.mjs";
import { INDEKS_KOLUMNY, liczbyZdjec, scalBaze, raportPartii } from "./indeks_i_baza.mjs";
import { zlozPionowo, przygotujAudyt } from "./audyt_arkusze.mjs";
import { decodePng, encodePng } from "./png_proste.mjs";

let ok = 0;
const t = (nazwa, fn) => { try { fn(); ok++; console.log("OK   ", nazwa); } catch (e) { console.log("BŁĄD", nazwa, "\n     ", e.message); process.exitCode = 1; } };

// ---- nazwy
t("nazwa folderu: bez emoji i znaków niedozwolonych, ID na końcu, skrócona", () => {
  assert.equal(bezpiecznaNazwa("IT’S JUST BUSINESS BRO 💀"), "IT’S JUST BUSINESS BRO");
  assert.equal(bezpiecznaNazwa('A: "b" <c>? d/e\\f|g*h'), "A b c d e f g h");
  assert.equal(bezpiecznaNazwa("koniec z kropką... "), "koniec z kropką");
  assert.equal(bezpiecznaNazwa("💀💀"), "bez nazwy");
  assert.equal(bezpiecznaNazwa("x".repeat(200)).length, 80);
  assert.equal(nazwaFolderuRolki("Dozzek", "IT’S JUST BUSINESS BRO 💀", "bp7H54Iyfjc"), "Dozzek - IT’S JUST BUSINESS BRO [bp7H54Iyfjc]");
  assert.notEqual(nazwaFolderuRolki("K", "ten sam tytuł", "AAAAAAAAAA1"), nazwaFolderuRolki("K", "ten sam tytuł", "AAAAAAAAAA2")); // ID rozróżnia powtórzone tytuły
});

// ---- dane testowe
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rozloz-"));
const exp = path.join(tmp, "eksport"), zr = path.join(tmp, "zrzuty"), out = path.join(tmp, "wyniki");
fs.mkdirSync(exp, { recursive: true }); fs.mkdirSync(path.join(zr, "frames", "AAAAAAAAAA1"), { recursive: true });
const rec = (i, extra = {}) => ({ title: `Tytuł ${i}`, duration_seconds: 30, transcript: `tekst "z cudzysłowem", przecinek\nnowa linia ${i}`, url: `https://www.youtube.com/shorts/AAAAAAAAAA${i}`, views: 100 * i, video_id: `AAAAAAAAAA${i}`, channel_title: "Kanał: Test?", channel_handle: "@test", vision_status: "not_analyzed", vision: null, ...extra });
const img = (id) => ({ id, first_visible: "0:01.0", last_visible: "0:02.0", description_pl: `opis ${id}`, text_in_image: null, sent_by: "Son", messages_before: [{ t: "0:00.5", sender: "Dad", text: "przed" }], messages_after: [], uncertainty_pl: null });
const recs = [
  rec(1, { title: "Rolka ze zdjęciami 💀: test?", vision_status: "ok", vision: { images: [img(1), img(2)], messages: [] } }), // 1: zrzuty są, 2: zrzutów brak
  rec(2), // brak wizji
  rec(3, { vision_status: "ok", vision: { images: [], messages: [] } }), // wizja bez zdjęć
];
fs.writeFileSync(path.join(exp, "k_json.json"), JSON.stringify(recs, null, 1));
const header = ["title", "video_id", "transcript", "views"];
const q = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
fs.writeFileSync(path.join(exp, "k_csv.csv"), "﻿" + header.join(",") + "\r\n" + recs.map((r) => [r.title, r.video_id, r.transcript, r.views].map(q).join(",")).join("\r\n") + "\r\n");
const sek = (r, n) => `## ${n}. ${r.title}\n\n- ID: \`${r.video_id}\` | link: ${r.url}\n- Wyświetlenia: ${r.views}\n\n---\n`;
fs.writeFileSync(path.join(exp, "k_md-1.md"), "# Paczka\n\n## Źródła\n\n---\n\n" + sek(recs[0], 1) + "\n" + sek(recs[1], 2));
fs.writeFileSync(path.join(exp, "k_md-2.md"), "# Paczka część 2\n\n" + sek(recs[2], 3));
fs.writeFileSync(path.join(exp, "k_status.json"), "{}");
const png = (f) => fs.writeFileSync(path.join(zr, "frames", "AAAAAAAAAA1", f), "PNG:" + f);
png("zdjecie1_wycinek.png"); png("zdjecie1_kontekst1_zdjecie_i_reakcja.png"); png("zdjecie1_kontekst2_przed.png");
fs.writeFileSync(path.join(zr, "frames_manifest.json"), JSON.stringify([{
  video_id: "AAAAAAAAAA1", image_id: 1, status: "KOMPLET", confirmed: true, photo_file: "frames/AAAAAAAAAA1/zdjecie1_wycinek.png", measured_first_s: 1, measured_last_s: 2.5, note: "n",
  context_complete: true, context_confirmed: true, before_complete: true,
  context_shots: [{ order: 1, role: "zdjecie_i_reakcja", file: "frames/AAAAAAAAAA1/zdjecie1_kontekst1_zdjecie_i_reakcja.png", t_s: 2, photo_visible: true }, { order: 2, role: "przed", file: "frames/AAAAAAAAAA1/zdjecie1_kontekst2_przed.png", t_s: 0.5, photo_visible: false }],
}]));

// ---- parsery
t("CSV: parser i sekcja Markdown", () => {
  assert.deepEqual(parseCsv('a,"b ""c""",d\r\n1,"x\ny",3\r\n'), [["a", 'b "c"', "d"], ["1", "x\ny", "3"]]);
  assert.match(sekcjaMd(fs.readFileSync(path.join(exp, "k_md-1.md"), "utf8"), "AAAAAAAAAA2"), /^## 2\. Tytuł 2[\s\S]*Wyświetlenia: 200[\s\S]*---\n$/);
  assert.equal(sekcjaMd("nic", "XXXXXXXXXXX"), null);
});

// ---- rozkład
const r = rozloz({ eksportDir: exp, zrzutyDir: zr, wyjscie: out });
const kanal = path.join(out, "Kanał Test"); // znaki niedozwolone zamienione
const f1 = path.join(kanal, "Kanał Test - Rolka ze zdjęciami test [AAAAAAAAAA1]");
t("foldery: po jednym na rolkę, nazwa kanał + tytuł + ID", () => {
  assert.equal(r.rolek, 3);
  assert.deepEqual(fs.readdirSync(kanal).sort(), ["Kanał Test - Rolka ze zdjęciami test [AAAAAAAAAA1]", "Kanał Test - Tytuł 2 [AAAAAAAAAA2]", "Kanał Test - Tytuł 3 [AAAAAAAAAA3]", "_baza", "_zbiorczo"].sort());
});
t("dane.json / dane.csv / dane.md = dokładnie rekord, wiersz i sekcja tej rolki", () => {
  for (const [i, r0] of recs.entries()) {
    const d = fs.readdirSync(kanal).find((x) => x.endsWith(`[${r0.video_id}]`));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(kanal, d, "dane.json"), "utf8")), r0);
    const csv = parseCsv(fs.readFileSync(path.join(kanal, d, "dane.csv"), "utf8").replace(/^﻿/, ""));
    assert.deepEqual(csv, [header, [r0.title, r0.video_id, r0.transcript, String(r0.views)]]);
    const md = fs.readFileSync(path.join(kanal, d, "dane.md"), "utf8");
    assert.ok(md.includes(`- ID: \`${r0.video_id}\``) && md.startsWith(`## ${i + 1}. `) && !md.includes("AAAAAAAAAA" + (i === 0 ? 2 : 1) + "`"));
  }
});
t("zdjęcia i klatki skopiowane; status każdego zdjęcia jawny (jest / brak zrzutów / brak wizji / bez zdjęć)", () => {
  assert.equal(fs.readFileSync(path.join(f1, "zdjecia", "zdjecie1.png"), "utf8"), "PNG:zdjecie1_wycinek.png");
  assert.deepEqual(fs.readdirSync(path.join(f1, "klatki")).sort(), ["zdjecie1_kontekst1_zdjecie_i_reakcja.png", "zdjecie1_kontekst2_przed.png"]);
  const z = JSON.parse(fs.readFileSync(path.join(f1, "zdjecia.json"), "utf8"));
  assert.equal(z.zdjecia.length, 2);
  assert.equal(z.zdjecia[0].zrzuty.kategoria_kontekstu, "PELNY_NIEZWERYFIKOWANY");
  assert.equal(z.zdjecia[1].zrzuty, null);
  assert.match(z.zdjecia[1].status_pl, /zrzutów dla tego zdjęcia nie wykonano/);
  const md = fs.readFileSync(path.join(f1, "zdjecia.md"), "utf8");
  assert.match(md, /NIESPRAWDZONA|niesprawdzona/);
  assert.match(md, /Status: zrzutów dla tego zdjęcia nie wykonano/);
  const f2 = path.join(kanal, "Kanał Test - Tytuł 2 [AAAAAAAAAA2]"), f3 = path.join(kanal, "Kanał Test - Tytuł 3 [AAAAAAAAAA3]");
  assert.match(fs.readFileSync(path.join(f2, "zdjecia.md"), "utf8"), /Brak danych o zdjęciach: wizja ma status „not_analyzed”/);
  assert.match(fs.readFileSync(path.join(f3, "zdjecia.md"), "utf8"), /Model nie wykrył żadnego zdjęcia/);
  assert.ok(!fs.existsSync(path.join(f2, "zdjecia")) && !fs.existsSync(path.join(f3, "klatki")));
  assert.deepEqual(r.rolki.find((x) => x.video_id === "AAAAAAAAAA1").kategorie, { PELNY_NIEZWERYFIKOWANY: 1, BRAK_ZRZUTU: 1 });
});
t("_zbiorczo: pliki eksportu bez zmian, nazwane od kanału", () => {
  assert.deepEqual(fs.readdirSync(path.join(kanal, "_zbiorczo")).sort(), ["Kanał Test_csv.csv", "Kanał Test_json.json", "Kanał Test_md-1.md", "Kanał Test_md-2.md", "Kanał Test_status.json", "RAPORT_PARTII.md", "indeks_rolek.csv", "indeks_rolek.md"]);
  assert.equal(fs.readFileSync(path.join(kanal, "_zbiorczo", "Kanał Test_json.json"), "utf8"), fs.readFileSync(path.join(exp, "k_json.json"), "utf8"));
});
t("ponowne uruchomienie: odtwarza zdjęcia/klatki od zera, nie zostawia starych plików; --only i brak zrzutów", () => {
  fs.writeFileSync(path.join(f1, "zdjecia", "stary.png"), "x");
  rozloz({ eksportDir: exp, zrzutyDir: zr, wyjscie: out });
  assert.ok(!fs.existsSync(path.join(f1, "zdjecia", "stary.png")));
  const out2 = path.join(tmp, "wyniki2");
  const r2 = rozloz({ eksportDir: exp, zrzutyDir: null, wyjscie: out2, only: ["AAAAAAAAAA1"] });
  assert.equal(r2.rolek, 1);
  assert.deepEqual(r2.rolki[0].kategorie, { BRAK_ZRZUTU: 2 }); // bez zrzutów: każde zdjęcie z wizji ma jawny status braku
  assert.ok(!fs.existsSync(path.join(out2, "Kanał Test", "Kanał Test - Rolka ze zdjęciami test [AAAAAAAAAA1]", "zdjecia")));
});
t("indeks kanału: jeden wiersz na rolkę, statusy zdjęć, ścieżka folderu, zabezpieczenie przed formułami", () => {
  const csv = parseCsv(fs.readFileSync(path.join(kanal, "_zbiorczo", "indeks_rolek.csv"), "utf8").replace(/^﻿/, ""));
  assert.deepEqual(csv[0], INDEKS_KOLUMNY);
  assert.equal(csv.length, 4);
  const c = (row, k) => row[INDEKS_KOLUMNY.indexOf(k)];
  const r1 = csv.find((r) => c(r, "id") === "AAAAAAAAAA1");
  assert.equal(c(r1, "lp"), "1"); assert.equal(c(r1, "zdjec_wg_gemini"), "2"); assert.equal(c(r1, "zdjec_pelnych"), "1"); assert.equal(c(r1, "zdjec_brak"), "1");
  assert.match(c(r1, "status_zdjec"), /1 pełne, 0 częściowe, 1 brak \(z 2\)/);
  assert.equal(c(r1, "folder"), "Kanał Test - Rolka ze zdjęciami test [AAAAAAAAAA1]");
  assert.equal(c(csv.find((r) => c(r, "id") === "AAAAAAAAAA2"), "zdjec_wg_gemini"), "0");
  assert.match(fs.readFileSync(path.join(kanal, "_zbiorczo", "indeks_rolek.md"), "utf8"), /\| 1 \| Rolka ze zdjęciami[^|]*\| 100 \|/);
  assert.deepEqual(liczbyZdjec([]), { pelne: 0, czesciowe: 0, brak: 0, podejrzane: 0, zweryf: 0, ocrOk: 0, ocrBraki: 0, status: "bez zdjęć wg wizji lub brak analizy wizji" });
});
t("baza lokalna: scala eksporty bez duplikatów, zostaje najnowszy rekord, historia wyświetleń rośnie", () => {
  const baza = path.join(kanal, "_baza");
  const j1 = JSON.parse(fs.readFileSync(path.join(baza, "baza_rolek.json"), "utf8"));
  assert.equal(Object.keys(j1.rolki).length, 3);
  // drugi eksport tej samej rolki z nowszym pomiarem + nowa rolka
  const stary = { ...recs[0], measured_at: "2026-11-01T10:00:00Z", views: 100, views_history: [{ at: "2026-11-01T10:00:00Z", views: 100, likes: 1, comments_count: 0 }] };
  const nowy = { ...recs[0], measured_at: "2026-11-05T10:00:00Z", views: 400, views_history: [{ at: "2026-11-01T10:00:00Z", views: 100, likes: 1, comments_count: 0 }, { at: "2026-11-05T10:00:00Z", views: 400, likes: 2, comments_count: 1 }] };
  const dir2 = path.join(tmp, "baza2");
  scalBaze(dir2, "K", [{ rec: stary, opis: [], folder: "f" }], "2026-11-01T12:00:00Z");
  const r = scalBaze(dir2, "K", [{ rec: nowy, opis: [], folder: "f2" }, { rec: recs[1], opis: [], folder: "g" }], "2026-11-05T12:00:00Z");
  assert.equal(r.nowe, 1); assert.equal(r.odswiezone, 1); assert.equal(r.rolek, 2);
  const w = r.baza.rolki["AAAAAAAAAA1"];
  assert.equal(w.rekord.views, 400); assert.equal(w.folder, "f2"); assert.equal(w.pierwszy_zapis, "2026-11-01T12:00:00Z");
  assert.deepEqual(w.historia.map((p) => p.views), [100, 400]); // bez powtórzonego punktu z 1.11
  // starszy eksport po nowszym nie cofa rekordu, ale dopisuje brakujące punkty historii
  scalBaze(dir2, "K", [{ rec: stary, opis: [], folder: "stary" }], "2026-11-06T12:00:00Z");
  const w2 = JSON.parse(fs.readFileSync(path.join(dir2, "baza_rolek.json"), "utf8")).rolki["AAAAAAAAAA1"];
  assert.equal(w2.rekord.views, 400); assert.equal(w2.folder, "f2"); assert.equal(w2.historia.length, 2);
  const csv = parseCsv(fs.readFileSync(path.join(dir2, "baza_rolek.csv"), "utf8").replace(/^﻿/, ""));
  const ix = csv[0].indexOf("przyrost_od_pierwszego_pomiaru");
  assert.equal(csv.find((x) => x[csv[0].indexOf("id")] === "AAAAAAAAAA1")[ix], "300");
});
t("raport partii: liczby zdjęć, rolki z danymi odtwarzacza, lista do ponowienia z komendą; kopie bazy (maks. 5)", () => {
  const raport = fs.readFileSync(path.join(kanal, "_zbiorczo", "RAPORT_PARTII.md"), "utf8");
  assert.match(raport, /# Raport partii: Kanał Test/);
  assert.match(raport, /Rolek: 3; zdjęć wg Gemini: 2/);
  assert.match(raport, /pełne: \*\*1\*\*, częściowe: \*\*0\*\*, brak: \*\*1\*\*/);
  assert.match(raport, /## Do ponowienia lub sprawdzenia[\s\S]*`AAAAAAAAAA1` zdjęcie 2[\s\S]*zrzutów nie wykonano/);
  assert.match(raport, /-Tylko AAAAAAAAAA1/);
  assert.match(raport, /brak danych \(rolka nie była w ostatnim przebiegu zrzutów\)/);
  // wszystko pełne: brak listy ponowień
  const pelny = raportPartii({ kanal: "K", pozycje: [{ rec: recs[1], opis: [{ image_id: 1, zrzuty: { kategoria_kontekstu: "PELNY_ZWERYFIKOWANY" }, status_pl: "ok" }] }], przebieg: { czas_s: 5, odtwarzacz_na_rolke: { AAAAAAAAAA2: { incidents: 2, reloads: 1, exhausted: null } } } });
  assert.match(pelny, /Nic: wszystkie zdjęcia mają pełny kontekst/); assert.match(pelny, /\| 2 \/ 1 \|/);
  const dir = path.join(tmp, "baza_kopie");
  for (let i = 1; i <= 8; i++) scalBaze(dir, "K", [{ rec: recs[0], opis: [], folder: "f" }], `2026-11-0${i}T10:00:00Z`);
  const kopie = fs.readdirSync(path.join(dir, "kopie")).sort();
  assert.equal(kopie.length, 5); assert.ok(kopie[0].includes("2026-11-04") && kopie.at(-1).includes("2026-11-08")); // kopie poprzednich wersji, najstarsze usuwane
});
t("brak potwierdzonego wycinka: w zdjecia\\ trafia klatka ze zdjęciem z jawnym oznaczeniem", () => {
  const zr2 = path.join(tmp, "zrzuty2"); fs.mkdirSync(path.join(zr2, "frames", "AAAAAAAAAA1"), { recursive: true });
  fs.writeFileSync(path.join(zr2, "frames", "AAAAAAAAAA1", "zdjecie1_kontekst1_zdjecie_widoczne.png"), "PNG:klatka");
  fs.writeFileSync(path.join(zr2, "frames_manifest.json"), JSON.stringify([{ video_id: "AAAAAAAAAA1", image_id: 1, status: "KONTEKST_NIEKOMPLETNY", confirmed: false, photo_file: null, context_shots: [{ order: 1, role: "zdjecie_widoczne", file: "frames/AAAAAAAAAA1/zdjecie1_kontekst1_zdjecie_widoczne.png", t_s: 1.5, photo_visible: true }] }]));
  const out3 = path.join(tmp, "wyniki3");
  rozloz({ eksportDir: exp, zrzutyDir: zr2, wyjscie: out3, only: ["AAAAAAAAAA1"] });
  const d = path.join(out3, "Kanał Test", "Kanał Test - Rolka ze zdjęciami test [AAAAAAAAAA1]");
  assert.equal(fs.readFileSync(path.join(d, "zdjecia", "zdjecie1_klatka_ze_zdjeciem.png"), "utf8"), "PNG:klatka");
  assert.match(fs.readFileSync(path.join(d, "zdjecia.md"), "utf8"), /brak wycinka \(program nie potwierdził granic zdjęcia\)/);
  assert.ok(fs.existsSync(path.join(d, "klatki", "zdjecie1_kontekst1_zdjecie_widoczne.png"))); // oryginalna klatka zostaje też w klatki\
});
t("brak pliku JSON eksportu: czytelny błąd", () => {
  assert.throws(() => rozloz({ eksportDir: tmp, wyjscie: out }), /Brak pliku \*_json\.json/);
});
t("OCR (dopasowanie, bez uruchamiania OCR): widoczne, brak, błąd jednej litery, t/ł, wiadomości bez słów", () => {
  assert.deepEqual(tokeny("Prove it!! 💀"), ["prove", "it"]);
  assert.deepEqual(tokeny("prove ił", true), ["prove", "it"]);
  const o = ocenaOcr([{ text: "Prove it" }, { text: "who stabs a chair" }, { text: "💀💀" }, { text: "Prove it" }], ["Prove ił to me"]);
  assert.equal(o.status, "OCR_CZESCIOWY");
  assert.deepEqual(o.widoczne, ["Prove it"]); assert.deepEqual(o.brakuje, ["who stabs a chair"]); assert.deepEqual(o.pominiete, ["💀💀"]);
  assert.equal(ocenaOcr([{ text: "I am telling the truth today" }], ["i am telling the truth todai"]).status, "OCR_PELNY"); // 1 litera różnicy w słowie >= 4 znaki
  assert.equal(ocenaOcr([{ text: "hello there" }], []).status, "OCR_BRAK_KLATEK");
  assert.equal(ocenaOcr([{ text: "🙂" }], ["abc"]).status, "OCR_BRAK_DANYCH");
});
t("indeks i raport: kolumny OCR i sekcja rozbieżności (pełny wg programu, a OCR widzi braki)", () => {
  const opis = [
    { image_id: 1, status_pl: "x", zrzuty: { kategoria_kontekstu: "PELNY_NIEZWERYFIKOWANY" }, ocr: { status: "OCR_CZESCIOWY", brakuje: ["who stabs a chair"], widoczne: [], pominiete: [] } },
    { image_id: 2, status_pl: "x", zrzuty: { kategoria_kontekstu: "PELNY_ZWERYFIKOWANY" }, ocr: { status: "OCR_PELNY", brakuje: [], widoczne: ["a"], pominiete: [] } },
  ];
  const l = liczbyZdjec(opis);
  assert.equal(l.ocrOk, 1); assert.equal(l.ocrBraki, 1);
  const md = raportPartii({ kanal: "K", pozycje: [{ rec: { video_id: "V1", title: "T" }, opis }], teraz: "2026-11-01T00:00:00Z" });
  assert.match(md, /## Rozbieżność: ocena „pełny”, a OCR widzi braki/);
  assert.match(md, /„who stabs a chair”/);
  const bez = raportPartii({ kanal: "K", pozycje: [{ rec: { video_id: "V1", title: "T" }, opis: [opis[1]] }], teraz: "2026-11-01T00:00:00Z" });
  assert.ok(!/Rozbieżność/.test(bez));
});
t("awatar oznaczony przez serwer (likely_avatar) jest pominięty, chyba że ma już wpis zrzutów", () => {
  const rec = { video_id: "V1", vision: { images: [{ id: 1, first_visible: "0:00.6", likely_avatar: true }, { id: 2, first_visible: "0:10.0" }, { id: 3, first_visible: "0:20.0", likely_avatar: true }] } };
  const man = [{ video_id: "V1", image_id: 3, status: "KOMPLET", context_shots: [] }];
  const ids = opisZdjec(rec, man, () => false, () => null).map((z) => z.image_id);
  assert.deepEqual(ids, [2, 3]);
});
t("brak zdjęcia na klatkach bez błędu odtwarzacza = możliwy fałszywy wpis (osobna sekcja, bez ponawiania); błąd odtwarzacza = do ponowienia", () => {
  const rec = { video_id: "V1", title: "T", vision: { images: [{ id: 1, first_visible: "0:00.0", last_visible: "0:13.0", description_pl: "twarz" }, { id: 2, first_visible: "0:20.0", last_visible: "0:25.0", description_pl: "pokój" }] } };
  const man = [
    { video_id: "V1", image_id: 1, status: "NIE_ZNALEZIONO", note: "zdjęcia NIE znaleziono", context_shots: [] },
    { video_id: "V1", image_id: 2, status: "BLAD_FAZY_A", note: "odtwarzacz", context_shots: [] },
  ];
  const opis = opisZdjec(rec, man, () => false, () => null);
  assert.equal(opis[0].podejrzany_wpis, true); assert.equal(opis[1].podejrzany_wpis, false);
  const l = liczbyZdjec(opis);
  assert.equal(l.brak, 2); assert.equal(l.podejrzane, 1); assert.match(l.status, /2 brak \(w tym 1 możliwy fałszywy wpis modelu\)/);
  const md = raportPartii({ kanal: "K", pozycje: [{ rec, opis }], teraz: "2026-11-01T00:00:00Z" });
  assert.match(md, /## Wpis modelu bez zdjęcia na klatkach \(nie ponawiać\)/);
  assert.match(md, /zdjęcie 1 \(T\), czas wg Gemini 0:00\.0–0:13\.0: twarz/);
  assert.match(md, /zdjęcie 2 \(T\)[^\n]*brak zdjęcia na klatkach/); // błąd odtwarzacza zostaje na liście do ponowienia
  const tylko = raportPartii({ kanal: "K", pozycje: [{ rec, opis: [opis[0]] }], teraz: "2026-11-01T00:00:00Z" });
  assert.match(tylko, /Nic do ponowienia/); assert.ok(!/-Tylko/.test(tylko));
});
t("arkusze audytu: klatki jedna pod drugą, szablon z md5, pominięcie już sprawdzonych", () => {
  const px = (w, h, v) => ({ w, h, data: Buffer.alloc(w * h * 4, v) });
  const z = zlozPionowo([px(4, 2, 10), px(6, 3, 20)], 1);
  assert.equal(z.w, 6); assert.equal(z.h, 6); assert.equal(z.data[0], 10); assert.equal(z.data[(3 * 6 + 5) * 4], 20);
  const kd = path.join(tmp, "arkusze_kanal"), rob = path.join(kd, "_zrzuty_robocze"), zb = path.join(kd, "_zbiorczo");
  fs.mkdirSync(path.join(rob, "frames"), { recursive: true }); fs.mkdirSync(zb, { recursive: true });
  for (const n of ["a", "b"]) fs.writeFileSync(path.join(rob, "frames", n + ".png"), encodePng(px(8, 4, 100)));
  const e = (id, files) => ({ video_id: "V1", image_id: id, status: "KOMPLET", context_complete: true, before_complete: true, context_shots: files.map((f, i) => ({ role: i ? "reakcja" : "przed", file: "frames/" + f + ".png", t_s: i + 1, photo_visible: true })) });
  fs.writeFileSync(path.join(rob, "frames_manifest.json"), JSON.stringify([e(1, ["b", "a"]), e(2, ["a"])]));
  fs.writeFileSync(path.join(zb, "x_json.json"), JSON.stringify([{ video_id: "V1", title: "Rolka", vision: { images: [{ id: 1, description_pl: "opis", messages_before: [{ t: "0:01", sender: "A", text: "hej" }], messages_after: [] }] } }]));
  const r = przygotujAudyt(kd, { teraz: "2026-11-01T00:00:00Z" });
  assert.equal(r.arkusze.length, 2); assert.ok(fs.existsSync(path.join(r.folder, "arkusz_V1_1.png")));
  const dec = decodePng(fs.readFileSync(path.join(r.folder, "arkusz_V1_1.png"))); assert.equal(dec.w, 8); assert.equal(dec.h, 4 + 4 + 10);
  const szablon = JSON.parse(fs.readFileSync(path.join(r.folder, "audyt_szablon.json"), "utf8"));
  assert.equal(szablon[0].files.length, 2); assert.match(szablon[0].files[0].md5, /^[0-9a-f]{32}$/); assert.equal(szablon[0].result, "");
  assert.match(fs.readFileSync(path.join(r.folder, "ARKUSZE.md"), "utf8"), /wiadomości przed: 0:01 A: hej/);
  // wpis z ważną oceną wzrokową jest pomijany
  const man = JSON.parse(fs.readFileSync(path.join(rob, "frames_manifest.json"), "utf8"));
  man[1].content_check = { result: "PELNY", missing: [], files: [{ file: "frames/a.png", md5: null }] };
  fs.writeFileSync(path.join(rob, "frames_manifest.json"), JSON.stringify(man));
  const r2 = przygotujAudyt(kd);
  assert.equal(r2.arkusze.length, 1); assert.equal(r2.pominiete[0].powod, "już sprawdzone wzrokowo");
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? "\nNIEPOWODZENIE" : `\nWSZYSTKO OK (${ok} testów)`);
