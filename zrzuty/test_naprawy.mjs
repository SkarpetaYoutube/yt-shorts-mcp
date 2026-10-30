// Testy poprawek na ZAPISANYCH przypadkach z przebiegu test_Dozzek_5 (bez przeglądarki, bez Gemini/Supadata).
// Użycie: node test_naprawy.mjs <test_Dozzek_5_json.json> <frames_manifest.json>
import fs from "node:fs";
import assert from "node:assert";
import { neededMessages, chooseShots, resolveOwners, assignRun, sec } from "./kontekst.mjs";
const recs = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); const man = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const rec = (id) => recs.find((r) => r.video_id === id);
const rows = (a, b, box = [100, 300, 400, 500], step = 0.25) => { const o = []; for (let t = a; t <= b + 1e-6; t += step) o.push({ t: Math.round(t * 100) / 100, ok: true, box }); return o; };

// 1) E2BybkIVj6E#1: wiadomości do ~4,9 s, a zdjęcie widoczne dopiero od 42,75 s => dawniej TypeError, teraz jawny kod
{
  const r = rec("E2BybkIVj6E"); const im = r.vision.images.find((x) => x.id === 1);
  const n = neededMessages(im, r.transcript_timed || []); const tReady = Math.max(...n.map((m) => m.t)) + 0.7;
  const pick = chooseShots({ rows: rows(42.75, 43.02), midT: 42.9, k: 3, tReady, maxT: 83.9 });
  console.log("E2Byb#1 tReady", tReady.toFixed(2), "=>", pick.code, "|", pick.why);
  assert(pick.shots.length === 0 && pick.code === "NIESPOJNE_CZASY", "niespójne czasy dają jawny kod, nie wyjątek");
}
// 2) chooseShots nigdy nie rzuca: brak rzędów, NaN, zdjęcie pojawia się chwilę po wiadomościach
assert.strictEqual(chooseShots({ rows: [], midT: 1, k: 1, tReady: 2 }).code, "BRAK_KLATEK_ZE_ZDJECIEM");
assert.strictEqual(chooseShots({ rows: rows(1, 2), midT: NaN, k: 1, tReady: 2 }).code, "BLEDNE_DANE");
assert.strictEqual(chooseShots({ rows: rows(1, 2), midT: 1.5, k: 1, tReady: NaN }).code, "BLEDNE_DANE");
{ const p = chooseShots({ rows: rows(10, 14), midT: 12, k: 1, tReady: 5 }); assert(p.shots.length === 1 && p.shots[0].t === 10 && p.code === "OK", "wiadomości ≤ 6 s przed zdjęciem: pierwsza pełna klatka"); }
{ const p = chooseShots({ rows: rows(10, 14), midT: 12, k: 1, tReady: 3.9 }); assert(p.code === "NIESPOJNE_CZASY"); }
// 3) przypisanie ciągów: ELOpUxh52JA — ciąg 80–81,27 (okno #2) vs poprawne #3 (zachowane: 79,92)
{
  const e3 = man.find((m) => m.video_id === "ELOpUxh52JA" && m.image_id === 3); const e2img = rec("ELOpUxh52JA").vision.images.find((x) => x.id === 2);
  const kept = { key: "#3(zachowane)", kept: true, model: [sec(e3.model_first), sec(e3.model_last)], cands: [{ from: e3.measured_first_s, to: e3.measured_last_s, n: 99 }] };
  const o = resolveOwners([kept, { key: "#2", model: [sec(e2img.first_visible), sec(e2img.last_visible)], cands: [{ from: 80, to: 81.27, n: 6 }] }], 0.5);
  console.log("ELOpU#2:", JSON.stringify(o.find((x) => x.key === "#2")));
  assert(o.find((x) => x.key === "#2").run === null && o.find((x) => x.key === "#2").lostTo[0] === "#3(zachowane)", "cudzy ciąg nie jest przypisany do #2");
  // rozszerzone okno: jedyny nieprzypisany ciąg w 75–79 s => OK; dwa => NIEJEDNOZNACZNE; tylko cudzy => PRZYPISANE_DO_INNEGO
  const claims = [{ from: e3.measured_first_s, to: e3.measured_last_s, id: "#3" }];
  assert.strictEqual(assignRun([{ from: 76, to: 77.5, n: 6 }, { from: 80, to: 81.27, n: 6 }], claims).status, "OK");
  assert.strictEqual(assignRun([{ from: 71, to: 72, n: 4 }, { from: 76, to: 77.5, n: 6 }], claims).status, "NIEJEDNOZNACZNE");
  assert.strictEqual(assignRun([{ from: 80, to: 81.27, n: 6 }], claims).status, "PRZYPISANE_DO_INNEGO");
  assert.strictEqual(assignRun([], claims).status, "BRAK");
}
// 4) E2BybkIVj6E#1: 2-klatkowy ciąg 42,75–43,02 dotyka ciągu #2 (42,93–44,5) — należy do #2, nie do #1
{
  const e2 = man.find((m) => m.video_id === "E2BybkIVj6E" && m.image_id === 2); const im1 = rec("E2BybkIVj6E").vision.images.find((x) => x.id === 1);
  const kept = { key: "#2(zachowane)", kept: true, model: [sec(e2.model_first), sec(e2.model_last)], cands: [{ from: e2.measured_first_s, to: e2.measured_last_s, n: 99 }] };
  const o = resolveOwners([kept, { key: "#1", model: [sec(im1.first_visible), sec(im1.last_visible)], cands: [{ from: 42.75, to: 43.02, n: 2 }] }], 0.5);
  console.log("E2Byb#1:", JSON.stringify(o.find((x) => x.key === "#1")));
  assert(o.find((x) => x.key === "#1").run === null, "ciąg należy do #2");
  // bez wersji 'zachowane' (pełny przebieg): #2 z własnym ciągiem wygrywa przez pokrycie z oknem modelu
  const o2 = resolveOwners([{ key: "#1", model: [0, 42.5], cands: [{ from: 42.75, to: 43.02, n: 2 }] }, { key: "#2", model: [43, 75.5], cands: [{ from: 42.93, to: 44.5, n: 7 }] }], 0.5);
  assert(o2.find((x) => x.key === "#1").run === null && o2.find((x) => x.key === "#2").run.n === 7);
}
// 5) zwykły przypadek bez konfliktu: wskazówka modelu + własny ciąg => bez zmian; przegrany bierze następnego kandydata
{
  const o = resolveOwners([{ key: "#1", model: [10, 14], cands: [{ from: 10, to: 13, n: 12 }] }, { key: "#2", model: [20, 25], cands: [{ from: 13.2, to: 13.5, n: 2 }, { from: 21, to: 24, n: 12 }] }], 0.5);
  assert(o[0].run.from === 10 && o[1].run.from === 21 && o[1].lostTo[0] === "#1", "drugi kandydat po utracie pierwszego");
}
console.log("TESTY NAPRAWY: OK");
