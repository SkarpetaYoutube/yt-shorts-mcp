// Test logiki wyboru klatek kontekstowych na prawdziwych danych (3vCANkZ_hAU: zdjęcia 1 i 4) i na przypadkach syntetycznych.
import fs from "node:fs";
import assert from "node:assert";
import { neededMessages, neededBefore, chooseBeforeShot, chooseShots, refineMsgTime } from "./kontekst.mjs";
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
// wiadomości sprzed zdjęcia i kadr „przed” (przypadek IQJ3ePQ7lkE#2 z wizji Gemini: odpowiedź „I'm literally a 10/10” na „she's way hotter than you”)
{
  const im = { first_visible: "0:27.1", last_visible: "0:29.4", messages_before: [{ t: "0:26.3", sender: "right bubble", text: "EXCUSE ME???" }, { t: "0:25.3", sender: "left bubble", text: "she's way hotter than you" }, { t: "0:25.3", sender: "left bubble", text: "she's way hotter than you" }] };
  const b = neededBefore(im, []);
  console.log("wiadomości przed:", b.map((m) => `${m.t.toFixed(1)} ${m.text}`));
  assert(b.length === 2 && b[0].t === 25.3 && b[1].t === 26.3, "posortowane po czasie, bez duplikatów");
  const p = chooseBeforeShot({ firstVisible: 27.1, p0: 27.6, before: b });
  console.log("kadr przed:", JSON.stringify(p.shot), "alts", JSON.stringify(p.alts), "tight", p.tight);
  assert(p.code === "OK" && p.shot.role === "przed" && p.shot.t === 26.7 && p.shot.needPhoto === false && p.tight === false && p.alts.length === 0, "czas z wizji: początek − 0,6 = 26,5, ale nie wcześniej niż ostatnia wiadomość + 0,4 = 26,7; bez wymogu zdjęcia");
  assert(neededBefore({ messages_before: [1, 2, 3, 4].map((i) => ({ t: `0:0${i}.0`, text: `m${i}` })) }, []).map((m) => m.text).join() === "m2,m3,m4", "maks. 3 najbliższe zdjęciu");
  assert(neededBefore({}, []).length === 0 && neededBefore({ messages_before: [{ t: "?", text: "a" }] }, []).length === 0, "brak czasu → pominięte, nigdy wyjątek");
  assert.strictEqual(chooseBeforeShot({ p0: 5, before: [] }).code, "BRAK_WIADOMOSCI_PRZED");
}
// czas kadru „przed”: zakres, czasy zapasowe i przypadki skrajne (p0 z początku ciągu bywa późniejsze niż rzeczywiste pojawienie się zdjęcia, więc liczymy z czasu wizji)
{
  const p1 = chooseBeforeShot({ firstVisible: 20, before: [{ t: 10 }] });
  assert(p1.shot.t === 19.4 && p1.alts.length === 2 && p1.alts[0] === 19 && p1.alts[1] === 18.6, "docelowo początek − 0,6 s; dwa wcześniejsze czasy zapasowe co 0,4 s");
  const p2 = chooseBeforeShot({ firstVisible: 27.1, before: [{ t: 26.9 }] });
  assert(p2.tight === true && p2.shot.t === 27, "ostatnia wiadomość tuż przed zdjęciem → tight, czas = min(początek − 0,1 s, ostatnia wiadomość + 0,1 s): nigdy przed ostatnią wiadomością");
  const p3 = chooseBeforeShot({ firstVisible: 2.9, before: [{ t: 2.3 }, { t: 2.8 }] }); // przypadek z żywego testu: wiadomość 0,1 s przed zdjęciem
  assert(p3.tight === true && p3.shot.t === 2.8 && p3.shot.t >= 2.8, "wiadomość 0,1 s przed zdjęciem: klatka w chwili tej wiadomości, nie wcześniej (wcześniej było początek − 0,2 = 2,7 s, przed wiadomością)");
  assert(chooseBeforeShot({ p0: 27.1, before: [{ t: 20 }] }).shot.t === 26.5, "bez czasu z wizji: p0 zamiast pierwszego pojawienia się");
  assert.strictEqual(chooseBeforeShot({ firstVisible: 0.4, before: [{ t: 0.05 }] }).code, "ZDJECIE_NA_POCZATKU");
  assert.strictEqual(chooseBeforeShot({ firstVisible: 0.4, before: [{ t: 0.05 }] }).shot, null);
  assert.strictEqual(chooseBeforeShot({ before: [{ t: 3 }] }).code, "BLEDNE_DANE", "brak jakiegokolwiek czasu zdjęcia");
  assert.strictEqual(chooseBeforeShot({ firstVisible: 5, before: [{ t: NaN }] }).code, "BLEDNE_DANE");
}
console.log("TESTY KONTEKSTU: OK");
