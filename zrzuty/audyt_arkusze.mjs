// Przygotowanie przeglądu wzrokowego: dla każdego zdjęcia, którego kontekst nie jest jeszcze sprawdzony wzrokowo, składa JEDEN obraz (klatki kontekstu jedna pod drugą,
// w kolejności czasu) + zestawienie z wiadomościami z wizji + szablon audyt.json z gotowymi plikami i sumami md5 (do wypełnienia: result / missing).
// Użycie: node audyt_arkusze.mjs <folder_kanalu> [--wszystkie] [--only id,id]
//   folder_kanalu = wyniki\<Kanał> (z _zrzuty_robocze i _zbiorczo). Wynik: <folder_kanalu>\_audyt\ (arkusz_*.png, ARKUSZE.md, audyt_szablon.json).
// Po wypełnieniu szablonu: node audyt.mjs <folder_kanalu>\_zrzuty_robocze <audyt.json>. Program niczego nie ocenia: to tylko skrócenie pracy przy przeglądzie.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { decodePng, encodePng } from "./png_proste.mjs";
import { contextCategory, shotFiles, CTX_LABEL } from "./kontekst.mjs";

/** Skleja obrazy RGBA pionowo (do lewej, tło szare, odstęp między klatkami). */
export function zlozPionowo(obrazy, odstep = 10) {
  const W = Math.max(...obrazy.map((o) => o.w)), H = obrazy.reduce((a, o) => a + o.h, 0) + odstep * (obrazy.length - 1);
  const data = Buffer.alloc(W * H * 4, 0x60); for (let p = 3; p < data.length; p += 4) data[p] = 255;
  let y = 0;
  for (const o of obrazy) { for (let r = 0; r < o.h; r++) o.data.copy(data, ((y + r) * W) * 4, r * o.w * 4, (r + 1) * o.w * 4); y += o.h + odstep; }
  return { w: W, h: H, data };
}

const msgs = (a) => (a?.length ? a.map((m) => `${m.t ?? "?"} ${m.sender ?? "?"}: ${m.text}`).join(" | ") : "brak");
const md5 = (file) => crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");

/**
 * kanalDir: wyniki\<Kanał>. Zwraca {arkusze, pominiete, folder}. Wpisy już sprawdzone wzrokowo (kategoria *_ZWERYFIKOWANY) są pomijane, chyba że wszystkie=true.
 */
export function przygotujAudyt(kanalDir, { wszystkie = false, only = null, teraz = new Date().toISOString() } = {}) {
  const robocze = path.join(kanalDir, "_zrzuty_robocze"), zbiorczo = path.join(kanalDir, "_zbiorczo");
  const man = JSON.parse(fs.readFileSync(path.join(robocze, "frames_manifest.json"), "utf8"));
  const expFile = fs.readdirSync(zbiorczo).find((f) => f.endsWith("_json.json"));
  const rekordy = expFile ? JSON.parse(fs.readFileSync(path.join(zbiorczo, expFile), "utf8")) : [];
  const exists = (f) => !!f && fs.existsSync(path.join(robocze, f));
  const md5Of = (f) => (exists(f) ? md5(path.join(robocze, f)) : null);
  const out = path.join(kanalDir, "_audyt"); fs.mkdirSync(out, { recursive: true });
  const L = ["# Arkusze do przeglądu wzrokowego", "", "Każdy arkusz to klatki kontekstu zdjęcia jedna pod drugą (od najwcześniejszej). Porównaj z wiadomościami z wizji poniżej: czy WSZYSTKIE są widoczne i czy zdjęcie jest na klatce? Program niczego tu nie ocenia.", ""];
  const szablon = [], arkusze = [], pominiete = [];
  for (const e of man) {
    if (only && !only.includes(e.video_id)) continue;
    const id = `${e.video_id}#${e.image_id}`, kat = contextCategory(e, exists, md5Of);
    const shots = shotFiles(e, exists).slice().sort((a, b) => (a.t_s ?? 0) - (b.t_s ?? 0));
    if (!shots.length) { pominiete.push({ id, powod: "brak klatek" }); continue; }
    if (!wszystkie && kat.endsWith("_ZWERYFIKOWANY")) { pominiete.push({ id, powod: "już sprawdzone wzrokowo" }); continue; }
    const rec = rekordy.find((r) => r.video_id === e.video_id), im = rec?.vision?.images?.find((i) => i.id === e.image_id);
    const plik = `arkusz_${e.video_id}_${e.image_id}.png`;
    fs.writeFileSync(path.join(out, plik), encodePng(zlozPionowo(shots.map((s) => decodePng(fs.readFileSync(path.join(robocze, s.file)))))));
    arkusze.push(plik);
    L.push(`## ${id}${rec?.title ? ` — ${rec.title}` : ""}`, "", `- arkusz: \`${plik}\``, `- ocena programu: ${CTX_LABEL[kat] ?? kat}`,
      `- klatki od góry: ${shots.map((s) => `${s.role} (${(s.t_s ?? 0).toFixed(1)} s)`).join(", ")}`,
      `- wizja (Gemini), opis: ${im?.description_pl ?? "brak"}`, `- wiadomości przed: ${msgs(im?.messages_before)}`, `- wiadomości po: ${msgs(im?.messages_after)}`, "");
    szablon.push({ video_id: e.video_id, image_id: e.image_id, result: "", missing: [], files: shots.map((s) => ({ file: s.file, md5: md5Of(s.file) })), checked_by: "", checked_at: teraz, note: "" });
  }
  if (!arkusze.length) L.push("Brak zdjęć do przeglądu (wszystkie sprawdzone albo bez klatek).", "");
  fs.writeFileSync(path.join(out, "ARKUSZE.md"), L.join("\n"));
  fs.writeFileSync(path.join(out, "audyt_szablon.json"), JSON.stringify(szablon, null, 1));
  return { arkusze, pominiete, folder: out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), dir = args.find((a) => !a.startsWith("--"));
  if (!dir) { console.error("Użycie: node audyt_arkusze.mjs <folder_kanalu> [--wszystkie] [--only id,id]"); process.exit(2); }
  const oi = args.indexOf("--only");
  const r = przygotujAudyt(dir, { wszystkie: args.includes("--wszystkie"), only: oi >= 0 ? args[oi + 1].split(",") : null });
  console.log(`Arkuszy: ${r.arkusze.length}; pominięto: ${r.pominiete.length}. Folder: ${r.folder}`);
}
