// Zapis wyniku kontroli wzrokowej kadrów do manifestu (content_check). Ocena wiąże się z DOKŁADNIE tymi plikami (lista + md5):
// jeśli pliki wpisu są inne niż oceniane, ocena NIE jest przyjmowana i wynik pozostaje niezweryfikowany.
// Użycie: node audyt.mjs <folder_zrzutow> <audyt.json>
// audyt.json: [{ video_id, image_id, result: "PELNY"|"CZESCIOWY"|"BLEDNY", missing: ["tekst brakującej wiadomości", ...], files: [{ file, md5 }], checked_by, checked_at, note }]
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { contextCategory, shotFiles } from "./kontekst.mjs";
const [dir, auditFile] = process.argv.slice(2);
if (!dir || !auditFile) { console.error("Użycie: node audyt.mjs <folder_zrzutow> <audyt.json>"); process.exit(2); }
const manPath = path.join(dir, "frames_manifest.json"); const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
const exists = (f) => !!f && fs.existsSync(path.join(dir, f));
const md5 = (f) => crypto.createHash("md5").update(fs.readFileSync(path.join(dir, f))).digest("hex");
let ok = 0, bad = 0;
for (const a of JSON.parse(fs.readFileSync(auditFile, "utf8"))) {
  const e = man.find((m) => m.video_id === a.video_id && m.image_id === a.image_id); const id = `${a.video_id}#${a.image_id}`;
  if (!e) { console.log(`${id}: brak wpisu w manifeście — pominięto`); bad++; continue; }
  const cur = shotFiles(e, exists).map((s) => s.file).sort(), aud = (a.files || []).map((f) => f.file).sort();
  if (cur.join("|") !== aud.join("|")) { console.log(`${id}: ocenione pliki (${aud.join(", ")}) ≠ pliki wpisu (${cur.join(", ")}) — ocena NIE przyjęta`); bad++; continue; }
  const mis = (a.files || []).filter((f) => !exists(f.file) || md5(f.file) !== f.md5);
  if (mis.length) { console.log(`${id}: plik zmieniony od oceny (${mis.map((f) => f.file).join(", ")}) — ocena NIE przyjęta`); bad++; continue; }
  if (!["PELNY", "CZESCIOWY", "BLEDNY"].includes(a.result)) { console.log(`${id}: nieznany wynik ${a.result}`); bad++; continue; }
  e.content_check = { result: a.result, missing: a.missing || [], files: a.files, checked_by: a.checked_by, checked_at: a.checked_at, note: a.note || null };
  console.log(`${id}: ${a.result}${a.missing?.length ? " (brakuje: " + a.missing.join("; ") + ")" : ""} → ${contextCategory(e, exists)}`); ok++;
}
fs.copyFileSync(manPath, manPath.replace(/\.json$/, `.przed_audytem_${Date.now()}.json`));
fs.writeFileSync(manPath, JSON.stringify(man, null, 1));
console.log(`AUDYT: przyjęto ${ok}, odrzucono ${bad}`);
