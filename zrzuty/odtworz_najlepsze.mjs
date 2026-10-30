// Odtwarza w manifeście NAJLEPSZY zapisany wynik każdego zdjęcia spośród manifestu bieżącego i jego kopii (frames_manifest*.json),
// bez ponownego generowania. Gorszy wynik ostatniej próby trafia do last_attempt. Pliki muszą nadal istnieć na dysku.
// Użycie: node odtworz_najlepsze.mjs <folder_zrzutow>
import fs from "node:fs"; import path from "node:path";
import { ctxScore, contextCategory } from "./kontekst.mjs";
const dir = process.argv[2]; if (!dir) { console.error("Użycie: node odtworz_najlepsze.mjs <folder_zrzutow>"); process.exit(2); }
const exists = (f) => !!f && fs.existsSync(path.join(dir, f));
const curPath = path.join(dir, "frames_manifest.json"); const cur = JSON.parse(fs.readFileSync(curPath, "utf8"));
const backups = fs.readdirSync(dir).filter((f) => /^frames_manifest\..+\.json$/.test(f)).sort();
const cands = backups.map((f) => ({ src: f, man: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
const out = cur.map((e) => {
  const id = `${e.video_id}#${e.image_id}`; let best = e, bestSrc = "bieżący", bs = ctxScore(e, exists);
  for (const c of cands) { const x = c.man.find((m) => m.video_id === e.video_id && m.image_id === e.image_id); if (!x) continue; const s = ctxScore(x, exists); if (s > bs) { best = x; bs = s; bestSrc = c.src; } }
  if (best === e) { console.log(`${id}: bez zmian (${contextCategory(e, exists)})`); return e; }
  console.log(`${id}: przywrócono z ${bestSrc}: ${contextCategory(best, exists)} (ostatnia próba: ${contextCategory(e, exists)}, ${e.status ?? "?"})`);
  return { ...best, restored_from: bestSrc, last_attempt: { attempt_no: e.attempt_no ?? null, status: e.status ?? null, category: contextCategory(e, exists), note: e.note ?? null, adopted: false, why: "gorsza od zapisanego wyniku (przywrócono najlepszy)" } };
});
fs.copyFileSync(curPath, curPath.replace(/\.json$/, `.przed_odtworzeniem_${Date.now()}.json`));
fs.writeFileSync(curPath, JSON.stringify(out, null, 1));
console.log("ZAPISANO manifest z najlepszymi wynikami");
