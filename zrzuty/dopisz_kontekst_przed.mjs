// Dopisuje do paczki plik KONTEKST_PRZED_ZDJECIEM_NIEZWERYFIKOWANY.md: wiadomości sprzed każdego zdjęcia według Gemini (messages_before), jako TEKST.
// Dlaczego: plan kadrów (neededMessages) bierze tylko wiadomości po zdjęciu i powiązane, więc wiadomość, na którą zdjęcie odpowiada, bywa poza kadrem.
// Tekst pochodzi z modelu Gemini (nie z klatek, czasy przybliżone) i jest NIEZWERYFIKOWANY; nie zmienia kategorii kontekstu w manifeście.
// Użycie: node dopisz_kontekst_przed.mjs <eksport.json> <folder_zrzutow> <folder_paczki>
import fs from "node:fs"; import path from "node:path";
import { contextCategory, CTX_LABEL } from "./kontekst.mjs";
const [expFile, framesDir, outDir] = process.argv.slice(2);
if (!expFile || !framesDir || !outDir) { console.error("Użycie: node dopisz_kontekst_przed.mjs <eksport.json> <folder_zrzutow> <folder_paczki>"); process.exit(2); }
const recs = JSON.parse(fs.readFileSync(expFile, "utf8"));
const man = JSON.parse(fs.readFileSync(path.join(framesDir, "frames_manifest.json"), "utf8"));
const exists = (f) => !!f && fs.existsSync(path.join(framesDir, f));
const L = ["# Wiadomości przed zdjęciem — wg Gemini, NIEZWERYFIKOWANE", "",
  "To tekst odczytany przez model Gemini z wideo (czasy przybliżone, możliwe błędy). Nie pochodzi z klatek i nie zastępuje kadrów w `frames/`.",
  "Kategoria kontekstu poniżej pochodzi z manifestu (kadry sprawdzone wzrokowo, jeśli jest audyt); ten plik jej nie zmienia.", ""];
let n = 0, bezPrzed = 0;
for (const r of recs) {
  const ims = r.vision?.images || []; if (!ims.length) continue;
  L.push(`## ${r.title || r.video_id} (\`${r.video_id}\`, model wizji: ${r.vision.model || "?"})`, "");
  for (const im of ims) {
    const e = man.find((m) => m.video_id === r.video_id && m.image_id === im.id);
    const kat = e ? CTX_LABEL[contextCategory(e, exists)] || contextCategory(e, exists) : "brak wpisu w manifeście";
    const mis = e?.content_check?.missing?.length ? e.content_check.missing.map((x) => `„${x}"`).join("; ") : null;
    L.push(`### Zdjęcie ${im.id} (${im.first_visible}–${im.last_visible}) — ${kat}${mis ? `; brakuje w kadrze: ${mis}` : ""}`);
    const before = im.messages_before || [];
    if (!before.length) { L.push("- (Gemini nie podał wiadomości przed zdjęciem)", ""); bezPrzed++; continue; }
    for (const m of before) L.push(`- [${m.t}] ${m.sender || "?"}: ${String(m.text).replace(/\s*\n\s*/g, " / ")}`);
    L.push(""); n++;
  }
}
fs.writeFileSync(path.join(outDir, "KONTEKST_PRZED_ZDJECIEM_NIEZWERYFIKOWANY.md"), L.join("\n"));
console.log(`Zapisano: zdjęć z wiadomościami przed: ${n}, bez: ${bezPrzed}`);
