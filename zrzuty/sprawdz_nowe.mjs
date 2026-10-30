// Przed testem: czy rolki są naprawdę nowe (nie ma ich w żadnym wcześniejszym manifeście zrzutów) i czy mają wynik wizji (bez niego test nie ma sensu).
// Użycie: node sprawdz_nowe.mjs <eksport.json> <folder_wyniki> [<folder_tego_testu>]
import fs from "node:fs"; import path from "node:path";
const [exp, wyn, self] = process.argv.slice(2);
const recs = JSON.parse(fs.readFileSync(exp, "utf8"));
const seen = new Map();
const walk = (d, depth) => { if (depth > 4) return; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name);
  if (f.isDirectory()) { if (self && path.resolve(p) === path.resolve(self)) continue; walk(p, depth + 1); }
  else if (/^frames_manifest.*\.json$/.test(f.name)) { try { for (const e of JSON.parse(fs.readFileSync(p, "utf8"))) if (e.video_id && !seen.has(e.video_id)) seen.set(e.video_id, path.relative(wyn, p)); } catch {} } } };
walk(wyn, 0);
let old = 0, noVision = 0;
for (const r of recs) {
  const v = r.vision; const n = v?.images?.length ?? 0;
  const was = seen.get(r.video_id);
  if (was) old++;
  if (!v || r.vision_status && !/ok|OK|gotowe|done/.test(String(r.vision_status)) && !n) noVision++;
  console.log(`${r.video_id}: ${was ? "BYŁA JUŻ PRZETWARZANA (" + was + ")" : "nowa"} | wizja: ${v ? n + " zdjęć" : "BRAK (" + (r.vision_status ?? "?") + ")"}`);
}
console.log(`ROLEK: ${recs.length}; nowych: ${recs.length - old}; bez wizji: ${noVision}`);
process.exit(old ? 5 : noVision ? 6 : recs.length !== 5 ? 7 : 0);
