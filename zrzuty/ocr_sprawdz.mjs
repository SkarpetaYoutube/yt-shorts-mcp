// Automatyczne sprawdzanie klatek: OCR (wbudowany w Windows, offline) + porównanie z wiadomościami, które wizja (Gemini) podała jako przed/po zdjęciu.
// To NIE jest ocena człowieka: sprawdza tylko, czy teksty wiadomości są widoczne na zapisanych klatkach (treści samego zdjęcia OCR nie ocenia).
// Wynik ma osobny status (OCR_*), nie zastępuje audytu wzrokowego (audyt.mjs), tylko pokazuje, co jest do sprawdzenia.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng, binarizujBialyTekst, dodajMargines } from "./png_proste.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Słowa (małe litery, bez interpunkcji i emoji) o długości >= 2. */
export const tokeny = (s, ocr = false) => {
  let t = String(s ?? "").toLocaleLowerCase().normalize("NFKC").replace(/[’‘`´]/g, "'");
  // OCR ustawiony na język polski myli angielskie „t” z „ł” (np. „prove ił”): w tekście z OCR (nie w oczekiwanym) traktujemy ł jako t; ogonki w obu wersjach pomijamy
  if (ocr) t = t.replace(/ł/g, "t");
  t = t.normalize("NFD").replace(/\p{M}/gu, "");
  return t.split(/[^\p{L}\p{N}']+/u).map((x) => x.replace(/^'+|'+$/g, "")).filter((x) => x.length >= 2);
};

function lev1(a, b) { // czy odległość edycyjna <= 1 (typowy błąd OCR: jedna litera)
  if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } if (++diff > 1) return false; if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; } }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Czy wiadomość jest widoczna w tekście OCR: co najmniej 75% jej słów (dla krótkich, do 2 słów, wszystkie) występuje w tekście OCR
 * (dokładnie albo z jedną literą różnicy dla słów >= 5 liter). Wiadomość bez słów (same emoji/znaki) jest „nie do sprawdzenia”.
 */
export function czyWidoczna(wiadomosc, tokenyOcr) {
  const t = tokeny(wiadomosc); if (!t.length) return null;
  const pula = [...tokenyOcr]; let trafione = 0;
  for (const w of t) {
    let i = pula.indexOf(w);
    if (i < 0 && w.length >= 4) i = pula.findIndex((x) => x.length >= 4 && lev1(w, x));
    if (i >= 0) { trafione++; pula.splice(i, 1); }
  }
  return t.length <= 2 ? trafione === t.length : trafione / t.length >= 0.75;
}

/** Ocena jednego zdjęcia: oczekiwane wiadomości (przed i po wg wizji) kontra tekst OCR ze wszystkich jego klatek. */
export function ocenaOcr(oczekiwane, tekstyOcr) {
  const tok = tokeny(tekstyOcr.join(" "), true);
  const widoczne = [], brakuje = [], pominiete = [];
  const seen = new Set();
  for (const m of oczekiwane) {
    const k = String(m.text ?? "").trim(); if (!k || seen.has(k)) continue; seen.add(k);
    const r = czyWidoczna(k, tok);
    (r === null ? pominiete : r ? widoczne : brakuje).push(k);
  }
  const status = !tekstyOcr.length ? "OCR_BRAK_KLATEK" : !widoczne.length && !brakuje.length ? "OCR_BRAK_DANYCH" : brakuje.length ? "OCR_CZESCIOWY" : "OCR_PELNY";
  return { status, widoczne, brakuje, pominiete };
}

/** Uruchamia OCR Windows na liście plików PNG (kopiuje je do prostych nazw: WinRT nie lubi „’”, „[” w ścieżkach). Zwraca mapę plik → { text } albo { error }. */
export function uruchomOcr(pliki) {
  const wynik = new Map();
  if (!pliki.length) return wynik;
  if (process.platform !== "win32") { for (const p of pliki) wynik.set(p, { error: "OCR Windows działa tylko na Windows" }); return wynik; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));
  try {
    // każda klatka w dwóch wersjach: oryginał i „czysty tekst” (biały tekst na dymkach czarny na białym, powiększony 2x); wynik to suma słów z obu
    const mapa = pliki.map((p, i) => { const k = path.join(tmp, `k${String(i).padStart(4, "0")}.png`), b = path.join(tmp, `b${String(i).padStart(4, "0")}.png`); let bin = null; let dec = null; try { dec = decodePng(fs.readFileSync(p)); fs.writeFileSync(k, encodePng(dodajMargines(dec, 40, 0))); } catch { fs.copyFileSync(p, k); } try { fs.writeFileSync(b, encodePng(binarizujBialyTekst(dec ?? decodePng(fs.readFileSync(p))))); bin = b; } catch { /* nieobsługiwany PNG: tylko oryginał */ } return [p, k, bin]; });
    const lista = path.join(tmp, "lista.json"), out = path.join(tmp, "wynik.json");
    fs.writeFileSync(lista, JSON.stringify(mapa.flatMap(([, k, b]) => (b ? [k, b] : [k]))));
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "ocr_klatek.ps1"), "-Lista", lista, "-Wyjscie", out], { encoding: "utf8", timeout: 180000 });
    let parsed = null; try { parsed = JSON.parse(fs.readFileSync(out, "utf8")); } catch { /* brak pliku wyniku */ }
    if (!parsed) { for (const p of pliki) wynik.set(p, { error: `OCR nie zwrócił wyniku (kod ${r.status}): ${String(r.stderr || "").slice(0, 200)}` }); return wynik; }
    if (parsed.error) { for (const p of pliki) wynik.set(p, { error: parsed.error }); return wynik; }
    const lista2 = Array.isArray(parsed) ? parsed : [parsed]; // jeden plik = obiekt zamiast tablicy (ConvertTo-Json)
    const znajdzWynik = (f) => lista2.find((y) => path.resolve(y.file) === path.resolve(f));
    for (const [orig, k, b] of mapa) {
      const x = znajdzWynik(k), y = b ? znajdzWynik(b) : null;
      if (!x || x.error) { wynik.set(orig, { error: x?.error ?? "brak wyniku dla pliku" }); continue; }
      wynik.set(orig, { text: `${x.text ?? ""} ${y && !y.error ? y.text ?? "" : ""}`.trim(), lines: [...(x.lines ?? []), ...(y && !y.error ? y.lines ?? [] : [])], language: x.language });
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return wynik;
}
