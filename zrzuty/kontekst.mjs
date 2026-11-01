// Wybór klatek kontekstowych: czysta logika (bez przeglądarki), testowalna. Korzysta tylko z istniejących danych (wizja Gemini + transkrypt z czasami).
export const sec = (t) => {
  if (t == null) return null;
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(String(t).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

/** Czas wiadomości wg modelu bywa za wczesny; ogon wiadomości (ostatnie 3 słowa) szukamy w transkrypcie z czasami i bierzemy późniejszy z czasów. */
export function refineMsgTime(msg, segs) {
  const t = sec(msg.t);
  if (t == null) return { t: null, basis: "brak czasu" };
  const words = norm(msg.text).split(" ").filter(Boolean);
  if (!words.length || !segs?.length) return { t, basis: "czas modelu" };
  const tail = words.slice(-3).join(" ");
  let best = null;
  for (const s of segs) { if (norm(s.text).includes(tail)) { const d = Math.abs(s.start_s - t); if (d <= 3 && (!best || d < best.d)) best = { d, start: s.start_s }; } }
  if (best && best.start > t) return { t: best.start, basis: `transkrypt (ogon „${tail}", ${best.start.toFixed(1)} s > czas modelu ${t.toFixed(1)} s)` };
  return { t, basis: best ? "czas modelu (transkrypt zgodny)" : "czas modelu (brak dopasowania w transkrypcie)" };
}

/** Wiadomości odnoszące się do zdjęcia: powiązane przez model + wiadomości „po" w czasie widoczności zdjęcia (+1,5 s), maks. 4. */
export function neededMessages(im, segs) {
  const last = sec(im.last_visible) ?? sec(im.first_visible) ?? 0;
  const seen = new Set(); const out = [];
  const add = (m) => { const k = (m.t || "") + "|" + (m.text || ""); if (seen.has(k)) return; seen.add(k); const r = refineMsgTime(m, segs); if (r.t != null) out.push({ t_model: sec(m.t), t: r.t, text: m.text, sender: m.sender, basis: r.basis }); };
  for (const m of (im.messages_after || [])) { const t = sec(m.t); if (t != null && t <= last + 1.5) add(m); }
  for (const m of (im.related_messages || [])) add(m);
  out.sort((a, b) => a.t - b.t);
  return out.slice(0, 4);
}

/**
 * Wiadomości SPRZED zdjęcia (messages_before z wizji): zdjęcie na nie odpowiada, a po jego pojawieniu się bywają już poza kartą rozmowy
 * (karta ma stały rozmiar w wideo, duże zdjęcie wypycha starsze wiadomości). Czas z korektą transkryptem; maks. 3, najbliższe zdjęciu.
 */
export function neededBefore(im, segs) {
  const seen = new Set(); const out = [];
  for (const m of (im.messages_before || [])) {
    const k = (m.t || "") + "|" + (m.text || ""); if (seen.has(k)) continue; seen.add(k);
    const r = refineMsgTime(m, segs); if (r.t != null) out.push({ t_model: sec(m.t), t: r.t, text: m.text, sender: m.sender, basis: r.basis });
  }
  out.sort((a, b) => a.t - b.t);
  return out.slice(-3);
}

/**
 * Czas kadru „przed”: klatka tuż przed pojawieniem się zdjęcia, gdy poprzednie wiadomości są jeszcze na karcie rozmowy (zdjęcie wjeżdża na kartę i wypycha je).
 * Czas liczony z wizji (pierwsze pojawienie się zdjęcia wg modelu) i czasu ostatniej wiadomości „przed”, NIE z początku ciągu zmierzonego w skanie (p0 bywa później niż rzeczywiste
 * pojawienie się zdjęcia: pierwsza próba na żywo trafiała w klatki, na których zdjęcie już było). Zakres: [ostatnia wiadomość + 0,4 s, początek zdjęcia − 0,2 s], docelowo początek − 0,6 s.
 * alts: kolejne, wcześniejsze czasy do wypróbowania, gdy na klatce widać już zdjęcie (zapas nie schodzi poniżej ostatniej wiadomości + 0,15 s).
 * Zwraca {shot, alts, code, why, tight}: brak wiadomości „przed” albo zdjęcie na początku wideo => shot=null z jawnym kodem (nigdy wyjątek).
 * tight: ostatnia wiadomość „przed” pojawia się tuż przed zdjęciem, więc klatka może jej jeszcze nie pokazywać.
 */
export const BEFORE_WANT_S = 0.6, BEFORE_HI_S = 0.2, BEFORE_LO_S = 0.4, BEFORE_ALT_STEP_S = 0.4;
export function chooseBeforeShot({ firstVisible, p0, before }) {
  if (!before || !before.length) return { shot: null, alts: [], code: "BRAK_WIADOMOSCI_PRZED", why: "wizja nie podała wiadomości przed zdjęciem" };
  const fv = Number.isFinite(firstVisible) ? firstVisible : p0; // czas wizji ma pierwszeństwo przed początkiem zmierzonego ciągu
  const lastT = Math.max(...before.map((m) => m.t));
  if (!Number.isFinite(fv) || !Number.isFinite(lastT)) return { shot: null, alts: [], code: "BLEDNE_DANE", why: "brak czasu pojawienia się zdjęcia albo wiadomości przed" };
  const hi = fv - BEFORE_HI_S, lo = lastT + BEFORE_LO_S; const tight = lo > hi;
  const r2 = (x) => Math.round(x * 100) / 100;
  // gdy ostatnia wiadomość „przed” pojawia się tuż przed zdjęciem (okno puste), klatka nie może być zrobiona przed tą wiadomością: bierzemy chwilę zaraz po niej, ale przed zdjęciem
  const t = r2(tight ? Math.min(fv - 0.1, lastT + 0.1) : Math.min(hi, Math.max(lo, fv - BEFORE_WANT_S)));
  if (t < 0.3) return { shot: null, alts: [], code: "ZDJECIE_NA_POCZATKU", why: `zdjęcie pojawia się na początku wideo (${fv.toFixed(2)} s): nie ma klatki sprzed niego` };
  const floor = Math.max(0.3, lastT + 0.15); const alts = [];
  for (let a = r2(t - BEFORE_ALT_STEP_S); a >= floor && alts.length < 2; a = r2(a - BEFORE_ALT_STEP_S)) alts.push(a);
  return { shot: { t, role: "przed", needPhoto: false, reason: `klatka tuż przed pojawieniem się zdjęcia (wg wizji ${fv.toFixed(2)} s), po ostatniej wiadomości przed nim (${lastT.toFixed(2)} s)${tight ? "; ostatnia wiadomość pojawia się tuż przed zdjęciem" : ""}` }, alts, tight, code: "OK", why: "ok" };
}

/**
 * Wybiera czasy screenów kontekstowych.
 * rows: [{t, ok, box:[x,y,w,h]|null}] ze skanu okna; midT: czas znalezionego zdjęcia; k: skala (videoWidth/360); tReady: kiedy wszystkie potrzebne wiadomości są już na ekranie.
 * Zasada: zdjęcie ma być w pełni widoczne (rozmiar jak w środku przebiegu, nie ucięte) i mają być już widoczne wiadomości do niego.
 *  - zdjęcie nadal widoczne w chwili tReady → jeden screen: najpóźniejsza pełna klatka ze zdjęciem, ale nie dalej niż tReady+2,5 s;
 *  - zdjęcie znika przed reakcją → screen 1: ostatnia pełna klatka ze zdjęciem, screen 3: reakcja (tReady+0,4), screen 2 (środek) gdy odstęp > 3 s.
 */
export const MAX_GAP_BEFORE_PHOTO_S = 6; // wiadomości potrzebne wcześniej niż tyle sekund przed pojawieniem się zdjęcia = czasy niespójne (wiadomości zdążyłyby zjechać z panelu)
/** Zwraca {shots, run, why, code}. Brak kandydatów lub niespójne czasy => shots=[] i jawny kod (BRAK_KLATEK_ZE_ZDJECIEM | NIESPOJNE_CZASY | BLEDNE_DANE), nigdy wyjątek. */
export function chooseShots({ rows, midT, k = 1, tReady, maxT = Infinity }) {
  const okRows = (rows || []).filter((r) => r && r.ok && r.box && Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  if (!okRows.length) return { shots: [], run: null, code: "BRAK_KLATEK_ZE_ZDJECIEM", why: "zdjęcie nie wykryte w skanie" };
  if (!Number.isFinite(midT)) return { shots: [], run: null, code: "BLEDNE_DANE", why: "brak czasu znalezionego zdjęcia" };
  if (tReady != null && !Number.isFinite(tReady)) return { shots: [], run: null, code: "BLEDNE_DANE", why: "niepoprawny czas wiadomości potrzebnych do kontekstu" };
  const base = okRows.reduce((p, r) => (Math.abs(r.t - midT) < Math.abs(p.t - midT) ? r : p));
  const tol = 14 * k;
  const same = (r) => Math.abs(r.box[2] - base.box[2]) <= tol && Math.abs(r.box[3] - base.box[3]) <= tol;
  // przebieg ciągły (przerwy do 0,6 s) wokół base, tylko klatki o tym samym rozmiarze (zdjęcie nieucięte)
  const cand = okRows.filter(same);
  let i0 = cand.indexOf(base), i1 = i0;
  while (i0 > 0 && cand[i0].t - cand[i0 - 1].t <= 0.6) i0--;
  while (i1 < cand.length - 1 && cand[i1 + 1].t - cand[i1].t <= 0.6) i1++;
  const run = cand.slice(i0, i1 + 1); const p0 = run[0].t, p1 = run[run.length - 1].t;
  const need = tReady == null ? p0 : tReady;
  if (need < p0 - MAX_GAP_BEFORE_PHOTO_S) return { shots: [], run: [p0, p1], code: "NIESPOJNE_CZASY", why: `niespójne czasy: wiadomości potrzebne do ${need.toFixed(1)} s, a zdjęcie widoczne dopiero od ${p0.toFixed(1)} s (różnica ${(p0 - need).toFixed(1)} s > ${MAX_GAP_BEFORE_PHOTO_S} s) — to nie to samo zdjęcie albo błędne czasy modelu` };
  const shots = [];
  if (p1 + 0.01 >= need) {
    const cap = need + 2.5;
    const upto = run.filter((r) => r.t <= cap + 1e-6);
    const row = upto.length ? upto[upto.length - 1] : run[0]; // zdjęcie pojawia się dopiero po wiadomościach (np. wiadomość zapowiadająca) — pierwsza pełna klatka ze zdjęciem
    shots.push({ t: row.t, role: "zdjecie_i_reakcja", needPhoto: true, reason: `zdjęcie widoczne w całości ${p0.toFixed(2)}–${p1.toFixed(2)} s, wiadomości potrzebne do ${need.toFixed(2)} s — wybrano ${upto.length ? "najpóźniejszą pełną klatkę ze zdjęciem (≤ " + cap.toFixed(2) + " s)" : "pierwszą pełną klatkę ze zdjęciem (wiadomości były już wcześniej na ekranie)"}` });
  } else {
    shots.push({ t: p1, role: "zdjecie_widoczne", needPhoto: true, reason: `ostatnia pełna klatka ze zdjęciem (${p1.toFixed(2)} s); zdjęcie znika przed pełną reakcją (potrzebna do ${need.toFixed(2)} s)` });
    const tr = Math.min(maxT, need + 0.4);
    if (tr - p1 > 3.0) shots.push({ t: Math.round(((p1 + tr) / 2) * 100) / 100, role: "w_trakcie", needPhoto: false, reason: "klatka pośrednia (odstęp między zdjęciem a reakcją > 3 s)" });
    shots.push({ t: Math.round(tr * 100) / 100, role: "reakcja", needPhoto: false, reason: `zdjęcia już nie ma; klatka z pełną reakcją (${tr.toFixed(2)} s)` });
  }
  return { shots, run: [p0, p1], base_t: base.t, why: "ok", code: "OK" };
}

/**
 * Przypisanie ciągów zdjęcia do obrazów rolki. Czasy Gemini to tylko wskazówka, ale jeden zmierzony ciąg nie może należeć do dwóch zdjęć ani do cudzego okna.
 * runs: [{from,to,n}] kandydaci z okna wokół wskazówki; claims: [{from,to,id}] ciągi już przypisane innym zdjęciom (zmierzone) lub okna modelu innych zdjęć jeszcze niezmierzonych.
 * Zwraca {status:"OK", run} | {status:"PRZYPISANE_DO_INNEGO", by} | {status:"NIEJEDNOZNACZNE", runs} | {status:"BRAK"}.
 * Kandydat dotykający cudzego roszczenia (odstęp ≤ gap) jest odrzucany; spośród reszty: jeden => OK, więcej => NIEJEDNOZNACZNE (nie zgadujemy), zero => BRAK/PRZYPISANE_DO_INNEGO.
 */
export function assignRun(runs, claims, gap = 0.6) {
  const touches = (a, b) => a.from <= b.to + gap && b.from <= a.to + gap;
  const free = [], taken = [];
  for (const r of runs || []) { const c = (claims || []).find((x) => touches(r, x)); if (c) taken.push({ run: r, by: c.id }); else free.push(r); }
  if (free.length === 1) return { status: "OK", run: free[0], skipped: taken };
  if (free.length > 1) return { status: "NIEJEDNOZNACZNE", runs: free, skipped: taken };
  if (taken.length) return { status: "PRZYPISANE_DO_INNEGO", by: [...new Set(taken.map((t) => t.by))], skipped: taken };
  return { status: "BRAK", skipped: [] };
}

/**
 * Własność zmierzonych ciągów zdjęć w jednej rolce. Czasy Gemini są tylko wskazówką, ale jeden fizyczny ciąg zdjęcia (kilka klatek z rzędu)
 * może należeć tylko do jednego obrazu. Ciągi dotykające się (odstęp ≤ gap) tworzą grupę; właścicielem jest obraz, którego przedział modelu
 * (z zapasem pad) najbardziej pokrywa się z sumą grupy; remis (różnica < 0,3 s) rozstrzyga dłuższy ciąg. Przegrany próbuje następnego kandydata.
 * items: [{key, model:[a,b], cands:[{from,to,n}] (najlepszy pierwszy), kept?:true}] — kept (poprawny wynik z wcześniejszego biegu) nigdy nie przegrywa.
 * Zwraca [{key, run|null, lostTo:[key…]}].
 */
export function resolveOwners(items, pad = 0.5, gap = 0.6) {
  const st = items.map((it) => ({ it, idx: 0, lostTo: [] }));
  const touches = (a, b) => a.from <= b.to + gap && b.from <= a.to + gap;
  const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  for (let guard = 0; guard < 100; guard++) {
    const cur = st.filter((s) => s.idx < s.it.cands.length).map((s) => ({ s, run: s.it.cands[s.idx] }));
    const grp = cur.map((_, i) => i); const find = (i) => (grp[i] === i ? i : (grp[i] = find(grp[i])));
    for (let i = 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) if (touches(cur[i].run, cur[j].run)) grp[find(i)] = find(j);
    const groups = new Map(); cur.forEach((c, i) => { const g = find(i); (groups.get(g) || groups.set(g, []).get(g)).push(c); });
    let changed = false;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const s0 = Math.min(...members.map((m) => m.run.from)), s1 = Math.max(...members.map((m) => m.run.to));
      const score = (m) => (m.s.it.kept ? Infinity : m.s.it.model ? ov(s0, s1, m.s.it.model[0] - pad, m.s.it.model[1] + pad) : 0);
      let win = members[0];
      for (const m of members.slice(1)) { const d = score(m) - score(win); if (d > 0.3 || (Math.abs(d) <= 0.3 && (m.run.n || 0) > (win.run.n || 0)) || (score(m) === Infinity && score(win) !== Infinity)) win = m; }
      for (const m of members) if (m !== win) { m.s.lostTo.push(win.s.it.key); m.s.idx++; changed = true; }
    }
    if (!changed) break;
  }
  return st.map((s) => ({ key: s.it.key, run: s.idx < s.it.cands.length ? s.it.cands[s.idx] : null, lostTo: s.lostTo }));
}

// ===== Kategorie kontekstu: program NIE sprawdza treści (nie czyta tekstu). „Pełny” bez sprawdzenia wzrokowego = NIEZWERYFIKOWANY. =====
// content_check (z audytu wzrokowego, audyt.mjs) jest ważny tylko dla dokładnie tych plików, które oceniono.
export const CTX = { PELNY_ZWERYFIKOWANY: 4, PELNY_NIEZWERYFIKOWANY: 3, CZESCIOWY_ZWERYFIKOWANY: 2, CZESCIOWY_NIEZWERYFIKOWANY: 1, BRAK: 0 };
export const CTX_LABEL = {
  PELNY_ZWERYFIKOWANY: "kontekst pełny — treść sprawdzona wzrokowo",
  PELNY_NIEZWERYFIKOWANY: "kontekst wg programu pełny — treść NIESPRAWDZONA (wynik niezweryfikowany)",
  CZESCIOWY_ZWERYFIKOWANY: "kontekst częściowy — sprawdzony wzrokowo",
  CZESCIOWY_NIEZWERYFIKOWANY: "kontekst częściowy wg programu — treść niesprawdzona",
  BRAK: "brak screena ze zdjęciem",
};
export const shotFiles = (e, exists = () => true) => (e?.context_shots || []).filter((s) => s.file && exists(s.file));
/** Ocena wzrokowa jest ważna tylko dla dokładnie tych plików. md5Of (plik → suma md5 albo null): gdy podane, zmiana TREŚCI kadru pod tą samą nazwą też unieważnia ocenę. */
export function checkValid(e, exists = () => true, md5Of = null) {
  const cc = e?.content_check; if (!cc) return false;
  const now = shotFiles(e, exists).map((s) => s.file).sort().join("|");
  if (now !== (cc.files || []).map((f) => f.file).sort().join("|")) return false;
  if (md5Of) for (const f of cc.files || []) if (f.md5 && md5Of(f.file) !== f.md5) return false;
  return true;
}
export function contextCategory(e, exists = () => true, md5Of = null) {
  const shots = shotFiles(e, exists);
  if (!shots.length || !shots.some((s) => s.photo_visible)) return "BRAK";
  if (checkValid(e, exists, md5Of)) { const r = e.content_check.result; if (r === "PELNY") return "PELNY_ZWERYFIKOWANY"; if (r === "CZESCIOWY") return "CZESCIOWY_ZWERYFIKOWANY"; if (r === "BLEDNY") return "BRAK"; }
  // before_complete === false: wizja podała wiadomości sprzed zdjęcia, a kadru „przed” nie udało się zapisać (wpisy sprzed tej zmiany nie mają pola)
  if (e.context_complete) return e.before_complete === false ? "CZESCIOWY_NIEZWERYFIKOWANY" : "PELNY_NIEZWERYFIKOWANY";
  return "CZESCIOWY_NIEZWERYFIKOWANY";
}
export const hasBeforeShot = (e, exists = () => true) => shotFiles(e, exists).some((s) => s.role === "przed");
export const ctxScore = (e, exists) => (e ? CTX[contextCategory(e, exists)] : -1);
/** Najlepszy zapisany wynik vs ostatnia próba: nowa próba zastępuje poprzedni wynik TYLKO gdy jest lepsza; remis = zostaje poprzedni. */
export function mergeBest(prevE, newE, exists = () => true, at = new Date().toISOString()) {
  const sNew = ctxScore(newE, exists), sOld = ctxScore(prevE, exists);
  const brief = (x) => ({ attempt_no: x.attempt_no ?? 1, at: x.attempt_at ?? null, status: x.status ?? null, category: contextCategory(x, exists), note: x.note ?? null, files: shotFiles(x, exists).map((s) => s.file) });
  // remis kategorii: nowa próba z kadrem „przed” zastępuje zapisany wynik bez niego (wcześniej remis zostawiał stary)
  const gainsBefore = !!prevE && sOld === sNew && hasBeforeShot(newE, exists) && !hasBeforeShot(prevE, exists);
  if (prevE && sOld >= sNew && !gainsBefore) {
    return { ...prevE, attempts_total: Math.max(prevE.attempts_total ?? prevE.attempt_no ?? 1, newE.attempt_no ?? 1), last_attempt: { ...brief(newE), at, adopted: false, why: `nie lepsza od zapisanego wyniku (${contextCategory(newE, exists)} vs ${contextCategory(prevE, exists)})` } };
  }
  return { ...newE, attempts_total: newE.attempt_no ?? 1, last_attempt: { ...brief(newE), at, adopted: true }, ...(prevE ? { replaced_best: brief(prevE) } : {}) };
}
