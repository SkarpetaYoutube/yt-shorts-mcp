// Test logiki wyboru klatek kontekstowych na prawdziwych danych (3vCANkZ_hAU: zdjęcia 1 i 4) i na przypadkach syntetycznych.
import fs from "node:fs";
import assert from "node:assert";
import { neededMessages, chooseShots, refineMsgTime } from "./kontekst.mjs";
const f = process.argv[2];
const rec = JSON.parse(fs.readFileSync(f, "utf8")).find((r) => r.video_id === "3vCANkZ_hAU");
const rows = (a, b, step = 0.25, box = [100, 300, 400, 500]) => { const o = []; for (let t = a; t <= b + 1e-6; t += step) o.push({ t: Math.round(t * 100) / 100, ok: true, box }); return o; };
const tReadyOf = (im) => { const n = neededMessages(im, rec.transcript_timed); return { n, tReady: Math.max(...n.map((m) => m.t)) + 0.7 }; };

// zdjęcie 1 (plakat): 3 wiadomości; zdjęcie widoczne 0–4,25 s wg skanu
{
  const im = rec.vision.images.find((x) => x.id === 1); const { n, tReady } = tReadyOf(im);
  console.log("zdj.1 wiadomości:", n.map((m) => `${m.t.toFixed(1)} ${m.text} [${m.basis}]`), "tReady", tReady);
  assert(n.length === 3, "3 wiadomości (I saw the ad…, just wanted…, because he's here…)");
  assert(n.some((m) => /because he's here/.test(m.text) && m.t >= 3.9), "czas ‘because he’s here’ skorygowany transkryptem do ≥3,9 s");
  const a = chooseShots({ rows: rows(0, 5.0), midT: 2, k: 3, tReady });
  console.log("  skan 0–5 →", JSON.stringify(a.shots.map((s) => [s.t, s.role])));
  assert(a.shots.length === 1 && a.shots[0].t >= 4.0 && a.shots[0].role === "zdjecie_i_reakcja", "zdjęcie jeszcze widoczne po reakcji → jeden screen z późnej klatki");
  const b = chooseShots({ rows: rows(0, 3.5), midT: 2, k: 3, tReady });
  console.log("  skan 0–3,5 →", JSON.stringify(b.shots.map((s) => [s.t, s.role])));
  assert(b.shots.length === 2 && b.shots[0].t === 3.5 && b.shots[1].role === "reakcja" && b.shots[1].t > 4.4, "zdjęcie znika przed reakcją → screen zdjęcia + osobny screen reakcji");
}
// zdjęcie 4 (osoba na kanapie): „You got lucky, kid!!!” (1:34.2) i „If I’d taken a little longer…” (1:35.4)
{
  const im = rec.vision.images.find((x) => x.id === 4); const { n, tReady } = tReadyOf(im);
  console.log("zdj.4 wiadomości:", n.map((m) => `${m.t.toFixed(1)} ${m.text} [${m.basis}]`), "tReady", tReady);
  assert(n.length === 2 && n.some((m) => /taken a little longer/.test(m.text)), "obie wiadomości po zdjęciu uwzględnione");
  const a = chooseShots({ rows: rows(93.5, 98), midT: 95, k: 3, tReady });
  console.log("  skan 93,5–98 →", JSON.stringify(a.shots.map((s) => [s.t, s.role])));
  assert(a.shots.length === 1 && a.shots[0].t >= tReady - 0.01, "screen nie wcześniejszy niż pojawienie się obu wiadomości (nie pierwsza ani środkowa klatka)");
  const first = rows(93.5, 98)[0].t; assert(a.shots[0].t !== first && a.shots[0].t !== 95, "nie pierwsza i nie środkowa");
  const c = chooseShots({ rows: rows(93.5, 95.25), midT: 94.5, k: 3, tReady });
  assert(c.shots.length === 2 && c.shots[1].role === "reakcja", "zdjęcie znika przed 2. wiadomością → drugi screen");
}
// zdjęcie ucięte (zjeżdża z karty): zmniejszona wysokość nie liczy się jako „pełne”
{
  const r = rows(10, 12).concat(rows(12.25, 14, 0.25, [100, 300, 400, 260]));
  const s = chooseShots({ rows: r, midT: 11, k: 1, tReady: 13 });
  console.log("ucięte:", JSON.stringify(s.shots.map((x) => [x.t, x.role])));
  assert(s.shots[0].t <= 12.0 && s.shots[0].role === "zdjecie_widoczne" && s.shots[s.shots.length - 1].role === "reakcja");
}
// długi odstęp → 3 screeny w kolejności
{
  const s = chooseShots({ rows: rows(10, 11), midT: 10.5, k: 1, tReady: 16 });
  assert(s.shots.length === 3 && s.shots[0].t < s.shots[1].t && s.shots[1].t < s.shots[2].t, "3 kolejne screeny");
}
// brak zdjęcia w skanie
assert(chooseShots({ rows: [{ t: 1, ok: false, box: null }], midT: 1, k: 1, tReady: 2 }).shots.length === 0);
// dopasowanie transkryptu: brak dopasowania → czas modelu
assert(refineMsgTime({ t: "0:10.0", text: "zzz qqq xxx" }, rec.transcript_timed).t === 10);
console.log("TESTY KONTEKSTU: OK");
