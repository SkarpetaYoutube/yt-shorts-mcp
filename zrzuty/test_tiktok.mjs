// Test układu lokalnego TikTok (bez sieci i API): node test_tiktok.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { rozlozTikTok, czas, nazwaFilmu, kartaFilmu, INDEKS_TT } from "./tiktok_rozloz.mjs";
import { parseCsv } from "./rozloz_na_rolki.mjs";

let ok = 0;
const t = (nazwa, fn) => { try { fn(); ok++; console.log("OK   ", nazwa); } catch (e) { console.log("BŁĄD", nazwa, "\n     ", e.message); process.exitCode = 1; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-"));

const rek = (o = {}) => ({
  platform: "tiktok", title: null, description: "[Cała historia] Opis filmu, który jest dość długi i ma #tag oraz „cudzysłów\" i | kreskę", duration_seconds: 125, transcript: "Pierwsze zdanie. Drugie zdanie.",
  published_at: "2026-03-11T22:09:04.000Z", url: "https://www.tiktok.com/@ania/video/7000000000000000001", views: 48400, likes: 1239, comments_count: 36, shares: 84, video_id: "7000000000000000001",
  channel_handle: "@ania", channel_title: "Ania", channel_verified: false, tags: ["a", "b"], measured_at: "2026-11-04T23:08:58.017Z", author_videos_in_sample: 2, author_views_rank_in_sample: 1, views_vs_author_median_in_sample: 1.1, set_views_rank: 1, set_size: 3,
  transcript_status: "ok", transcript_lang: "en", transcript_timed: [{ start_s: 0, end_s: 1.5, text: "Pierwsze zdanie." }, { start_s: 3725, end_s: 3726, text: "Drugie zdanie." }], transcript_timed_status: "ok", stats_status: "ok", stats_note: null, transcript_note: null, ...o,
});

t("czas i nazwa filmu: format g:mm:ss, znacznik [..] z początku opisu znika z nazwy", () => {
  assert.equal(czas(65), "1:05"); assert.equal(czas(3725), "1:02:05"); assert.equal(czas(null), "?");
  assert.match(nazwaFilmu(rek()), /^Opis filmu, który jest dość długi/);
  assert.equal(nazwaFilmu(rek({ description: null, title: null })), "bez opisu");
  assert.equal(nazwaFilmu(rek({ description: "[Tylko znacznik]" })), "bez opisu");
});

t("układ: folder konta, folder filmu, pliki, indeks, do_analizy, baza; dwa konta w jednym eksporcie", () => {
  const out = path.join(tmp, "wyniki");
  const recs = [rek(), rek({ video_id: "7000000000000000002", url: "https://www.tiktok.com/@ania/video/7000000000000000002", published_at: "2026-03-12T10:00:00.000Z", views: 10, description: "Inny film" }),
    rek({ video_id: "7000000000000000009", channel_handle: "@bartek", channel_title: "Bartek", transcript: null, transcript_status: "no_captions", transcript_timed: null, transcript_note: "Brak napisów (HTTP 206).", likes: null, views: null })];
  const r = rozlozTikTok({ records: recs, wyjscie: out, teraz: "2026-11-05T00:00:00.000Z" });
  assert.deepEqual(r.map((x) => [x.konto, x.filmow]).sort(), [["ania", 2], ["bartek", 1]]);
  const ania = path.join(out, "TikTok - ania");
  assert.ok(fs.existsSync(path.join(ania, "_baza", "baza_filmow.json")) && fs.existsSync(path.join(ania, "_zbiorczo", "do_analizy.md")));
  const folders = fs.readdirSync(ania).filter((f) => !f.startsWith("_"));
  assert.equal(folders.length, 2); assert.match(folders[0], /\[7000000000000000002\]$/); // od najnowszego
  for (const f of ["dane.md", "dane.json", "dane.csv", "transkrypt.txt", "transkrypt_czasy.txt"]) assert.ok(fs.existsSync(path.join(ania, folders[0], f)), f);
  const csv = parseCsv(fs.readFileSync(path.join(ania, "_zbiorczo", "indeks_filmow.csv"), "utf8").replace(/^﻿/, ""));
  assert.deepEqual(csv[0], INDEKS_TT); assert.equal(csv.length, 3);
  assert.ok(csv.every((row) => row.length === INDEKS_TT.length));
  const md = fs.readFileSync(path.join(ania, "_zbiorczo", "indeks_filmow.md"), "utf8");
  assert.match(md, /Filmów: \*\*2\*\*/); assert.match(md, /\| 48 400 \| 1 239 \|/);
  const bartek = path.join(out, "TikTok - bartek");
  const bmd = fs.readFileSync(path.join(bartek, "_zbiorczo", "indeks_filmow.md"), "utf8");
  assert.match(bmd, /brak danych/); assert.match(bmd, /no_captions/); // puste statystyki nie psują tabeli ani nie udają zera
  const karta = fs.readFileSync(path.join(bartek, fs.readdirSync(bartek).find((f) => !f.startsWith("_")), "dane.md"), "utf8");
  assert.match(karta, /brak transkryptu: Brak napisów/);
  assert.ok(!/Stosunki do wyświetleń/.test(karta)); // bez wyświetleń nie liczymy stosunków
  const cz = fs.readFileSync(path.join(ania, folders[1], "transkrypt_czasy.txt"), "utf8");
  assert.equal(cz, "[0:00] Pierwsze zdanie.\n[1:02:05] Drugie zdanie.");
  assert.equal(fs.readFileSync(path.join(ania, folders[1], "transkrypt.txt"), "utf8"), "Pierwsze zdanie. Drugie zdanie.");
});

t("karta filmu: statystyki, stosunki obliczone, pozycja w próbie opisana jako próba", () => {
  const k = kartaFilmu(rek(), "folder");
  assert.match(k, /\| 48 400 \| 1 239 \| 36 \| 84 \|/);
  assert.match(k, /polubienia 2,56%, komentarze 0,07%, udostępnienia 0,17%/);
  assert.match(k, /tylko filmy z tego eksportu, nie całe konto/);
  assert.match(k, /\*\*Tagi:\*\* a b/);
});

t("baza: kolejny eksport scala bez duplikatów, historia statystyk rośnie, kopia zapasowa", () => {
  const out = path.join(tmp, "wyniki2");
  rozlozTikTok({ records: [rek()], wyjscie: out, teraz: "2026-11-05T00:00:00.000Z" });
  const r2 = rozlozTikTok({ records: [rek({ views: 60000, likes: 1500, measured_at: "2026-11-12T10:00:00.000Z" })], wyjscie: out, teraz: "2026-11-12T10:05:00.000Z" });
  assert.deepEqual(r2[0].baza, { nowe: 0, odswiezone: 1, razem: 1 });
  const baza = JSON.parse(fs.readFileSync(path.join(out, "TikTok - ania", "_baza", "baza_filmow.json"), "utf8"));
  const f = baza.filmy["7000000000000000001"];
  assert.equal(f.rekord.views, 60000); assert.equal(f.historia.length, 2); assert.deepEqual(f.historia.map((h) => h.views), [48400, 60000]);
  assert.ok(fs.readdirSync(path.join(out, "TikTok - ania", "_baza", "kopie")).length >= 1);
  const csv = parseCsv(fs.readFileSync(path.join(out, "TikTok - ania", "_baza", "baza_filmow.csv"), "utf8").replace(/^﻿/, ""));
  assert.equal(csv.length, 2); assert.equal(csv[1][csv[0].indexOf("przyrost_wyswietlen_od_pierwszego_pomiaru")], "11600");
  // starszy pomiar nie nadpisuje nowszego rekordu
  rozlozTikTok({ records: [rek({ views: 1, measured_at: "2026-10-01T00:00:00.000Z" })], wyjscie: out, teraz: "2026-11-13T00:00:00.000Z" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "TikTok - ania", "_baza", "baza_filmow.json"), "utf8")).filmy["7000000000000000001"].rekord.views, 60000);
});

t("pusty albo zły eksport: czytelny błąd", () => {
  assert.throws(() => rozlozTikTok({ records: [], wyjscie: tmp }), /pusty/);
  assert.throws(() => rozlozTikTok({ records: { a: 1 }, wyjscie: tmp }), /pusty albo ma zły format/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? "\nNIEPOWODZENIE" : `\nWSZYSTKO OK (${ok} testów)`);
