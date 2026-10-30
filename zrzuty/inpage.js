// Biblioteka wstrzykiwana do strony z odtwarzaczem. Wykrywa na klatce rozmowy (ciemna karta) prostokąt zdjęcia i szuka go w oknie czasu.
(function () {
  const CFG = window.__cfg = Object.assign({ dark: 24, black: 10, pdark: 12, header: 0, erode: 2, minFrac: 0.04 }, window.__cfg || {});
  const V = () => document.querySelector("video");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ready = () => { const v = V(); return !!v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0 && Number.isFinite(v.duration); };
  // Klasyfikacja przyczyny niegotowości: BLAD_ODTWARZACZA (ekran błędu YouTube / v.error / playability != OK) | BUFOROWANIE (dane jeszcze się ładują) | SEEK (odtwarzacz zdrowy, ale przewinięcie nie zadziałało).
  const ERR_RE = /Coś poszło nie tak|Something went wrong|An error occurred|Wystąpił błąd|Playback error|Błąd odtwarzania/i;
  function playerKind() {
    const v = V(); const p = document.getElementById("movie_player");
    let errText = null; try { const e = document.querySelector(".ytp-error, .ytp-error-content-wrap"); if (e && (e.innerText || "").trim()) errText = e.innerText.trim().slice(0, 120); if (!errText && p && ERR_RE.test((p.innerText || "").slice(0, 400))) errText = (p.innerText || "").trim().slice(0, 120); } catch {}
    let play = null; try { play = p && p.getPlayerResponse && p.getPlayerResponse().playabilityStatus; } catch {}
    let ps = null; try { ps = p && p.getPlayerState && p.getPlayerState(); } catch {}
    const verr = v && v.error ? `kod ${v.error.code}` : null;
    if (verr || errText || (play && play.status && play.status !== "OK")) return { kind: "BLAD_ODTWARZACZA", detail: `${verr ? "v.error " + verr + "; " : ""}${errText ? "tekst: " + JSON.stringify(errText) + "; " : ""}${play && play.status && play.status !== "OK" ? "playability " + play.status : ""}`.replace(/; $/, "") };
    if (v && (v.readyState < 3 || ps === 3)) return { kind: "BUFOROWANIE", detail: `readyState=${v.readyState}, playerState=${ps}` };
    return { kind: "SEEK", detail: `readyState=${v && v.readyState}, playerState=${ps}, currentTime=${v && v.currentTime}` };
  }
  async function waitReady(ms = 12000) { const t0 = Date.now(); while (!ready()) { if (Date.now() - t0 > ms) { const v = V(); const k = playerKind(); throw new Error(`NOT_READY[${k.kind}]: wideo niegotowe (readyState=${v && v.readyState}, ${v && v.videoWidth}x${v && v.videoHeight}, duration=${v && v.duration}; ${k.detail})`); } await sleep(150); } }
  // Zabezpieczenie przed przejściem na inny film (autoplay/nawigacja): ID filmu i długość sprawdzane przed każdym przewinięciem i zapisem.
  let VID = null, VDUR = null;
  function setId(id, dur) {
    VID = id; VDUR = dur || null;
    const _push = history.pushState, _rep = history.replaceState;
    const bad = (u) => { try { const x = new URL(u, location.href); return x.pathname === "/watch" && x.searchParams.get("v") && x.searchParams.get("v") !== VID; } catch { return false; } };
    history.pushState = function (s, t, u) { if (u && bad(u)) return; return _push.apply(this, arguments); };
    history.replaceState = function (s, t, u) { if (u && bad(u)) return; return _rep.apply(this, arguments); };
    return blockAutoplay();
  }
  function blockAutoplay() {
    const out = [];
    const tg = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]'); if (tg) { tg.click(); out.push("wyłączono autoodtwarzanie (przełącznik)"); }
    const p = document.getElementById("movie_player"); try { if (p && p.setAutonavState) { p.setAutonavState(1); out.push("setAutonavState(1)"); } } catch {}
    return out;
  }
  function assertVideo() {
    if (!VID) return { id: null };
    const p = document.getElementById("movie_player"); const v = V();
    let pid = null; try { pid = p && p.getVideoData && p.getVideoData().video_id; } catch {}
    const urlId = new URL(location.href).searchParams.get("v");
    if (urlId !== VID || (pid && pid !== VID)) throw new Error(`WRONG_VIDEO: oczekiwano ${VID}, strona ${urlId}, odtwarzacz ${pid}`);
    if (VDUR && Number.isFinite(v.duration) && Math.abs(v.duration - VDUR) > 3) throw new Error(`WRONG_VIDEO: długość ${v.duration} s zamiast ok. ${VDUR} s (to inny film)`);
    return { id: VID, url_id: urlId, player_id: pid, duration: v.duration };
  }
  // Przewijanie przez własny interfejs odtwarzacza YouTube (seekTo) — surowe v.currentTime potrafi zawisnąć w readyState=1 bez doładowania danych.
  async function seek(t) {
    await waitReady(); assertVideo();
    const v = V(); const p = document.getElementById("movie_player");
    const near = () => ready() && Math.abs(v.currentTime - t) <= 0.6;
    const settle = async (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (near()) return true; await sleep(150); } return false; };
    if (p && p.seekTo) { p.seekTo(t, true); } else { v.pause(); v.currentTime = t; }
    let ok = await settle(7000);
    if (!ok && p && p.playVideo) { p.playVideo(); ok = await settle(8000); } // odtwarzanie wymusza doładowanie bufora w nowym miejscu
    if (p && p.pauseVideo) p.pauseVideo(); else v.pause();
    if (!ok) { const k = playerKind(); throw new Error(`NOT_READY[${k.kind}]: seek do ${t} s nie powiódł się (currentTime=${v.currentTime}, readyState=${v.readyState}; ${k.detail})`); }
    assertVideo(); await sleep(300); v.pause();
    return v.currentTime;
  }
  function draw(scale) {
    const v = V(); const c = document.createElement("canvas");
    if (!ready()) { const k = playerKind(); throw new Error(`NOT_READY[${k.kind}]: klatka niegotowa (videoWidth=0; ${k.detail})`); }
    c.width = Math.max(1, Math.round(v.videoWidth * scale)); c.height = Math.max(1, Math.round(v.videoHeight * scale));
    const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(v, 0, 0, c.width, c.height);
    return { c, x };
  }
  function find(minCardFrac = 0.05) {
    const S = 180 / V().videoWidth; const { c, x } = draw(S); const W = c.width, H = c.height;
    const d = x.getImageData(0, 0, W, H).data;
    const mx = (i) => Math.max(d[i], d[i + 1], d[i + 2]);
    // Karta rozmowy = największy zwarty obszar CZYSTEJ CZERNI (tło czatu ma 0–2; ciemne tło gry rzadko schodzi poniżej progu). Mała dylatacja domyka wąskie przerwy
    // (np. lewy margines oddzielony od reszty po zmniejszeniu), a ramkę liczymy tylko po prawdziwie czarnych pikselach (dylatacja jej nie powiększa).
    const dark = new Uint8Array(W * H);
    // maska czerni z próbkowania BEZ wygładzania: wąski czarny margines (kilka pikseli po zmniejszeniu) nie zlewa się z jasnym zdjęciem i krawędzią karty
    const c2 = document.createElement("canvas"); c2.width = W; c2.height = H; const x2 = c2.getContext("2d", { willReadFrequently: true }); x2.imageSmoothingEnabled = false; x2.drawImage(V(), 0, 0, W, H);
    const dn = x2.getImageData(0, 0, W, H).data;
    for (let p = 0; p < W * H; p++) dark[p] = Math.max(dn[p * 4], dn[p * 4 + 1], dn[p * 4 + 2]) <= CFG.black ? 1 : 0;
    const dil = (m, r) => { const t = new Uint8Array(W * H), o = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) { let v = 0; for (let k = Math.max(0, xx - r); k <= Math.min(W - 1, xx + r); k++) if (m[y * W + k]) { v = 1; break; } t[y * W + xx] = v; }
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) { let v = 0; for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) if (t[k * W + xx]) { v = 1; break; } o[y * W + xx] = v; }
      return o; };
    const comp = (mask, minArea, orig) => {
      const seen = new Uint8Array(W * H); let best = null; const st = new Int32Array(W * H);
      for (let s = 0; s < W * H; s++) {
        if (!mask[s] || seen[s]) continue;
        let sp = 0, n = 0, x0 = W, y0 = H, x1 = 0, y1 = 0; st[sp++] = s; seen[s] = 1;
        while (sp) { const p = st[--sp]; const px = p % W, py = (p / W) | 0; if (!orig || orig[p]) { n++; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
          if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; st[sp++] = p - 1; } if (px < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; st[sp++] = p + 1; }
          if (py > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; st[sp++] = p - W; } if (py < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; st[sp++] = p + W; } }
        if (n >= minArea && (!best || n > best.n)) best = { n, x0, y0, x1, y1 };
      }
      return best;
    };
    const card = comp(dil(dark, 2), W * H * minCardFrac, dark);
    if (!card) return null;
    // Wąski czarny margines po lewej/prawej bywa odcięty od głównej plamy (zdjęcie lub dymek leży przy samej krawędzi) — dociągamy kolumny, które w zakresie wierszy karty są w większości czarne.
    { const colFrac = (xx) => { let n = 0; for (let y = card.y0; y <= card.y1; y++) n += dark[y * W + xx]; return n / (card.y1 - card.y0 + 1); };
      const reach = Math.round((card.x1 - card.x0) * 0.6);
      let lo = card.x0; for (let xx = card.x0 - 1; xx >= Math.max(0, card.x0 - reach); xx--) if (colFrac(xx) >= 0.4) lo = xx;
      let hi = card.x1; for (let xx = card.x1 + 1; xx <= Math.min(W - 1, card.x1 + reach); xx++) if (colFrac(xx) >= 0.4) hi = xx;
      if (hi - lo + 1 <= W * 0.95) { card.x0 = lo; card.x1 = hi; } }
    const cw =card.x1 - card.x0 + 1, ch = card.y1 - card.y0 + 1;
    const top = card.y0 + Math.round(ch * CFG.header);
    const m2 = new Uint8Array(W * H);
    for (let y = top; y <= card.y1; y++) for (let xx = card.x0; xx <= card.x1; xx++) {
      const p = y * W + xx, i = p * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      const blue = b > 170 && r < 90 && g > 90 && g < 190;
      m2[p] = mx(i) >= CFG.pdark && !blue ? 1 : 0;
    }
    const R = CFG.erode; const m3 = new Uint8Array(W * H);
    for (let y = R; y < H - R; y++) for (let xx = R; xx < W - R; xx++) { let ok = 1; for (let dy = -R; dy <= R && ok; dy++) for (let dx = -R; dx <= R; dx++) if (!m2[(y + dy) * W + xx + dx]) { ok = 0; break; } m3[y * W + xx] = ok; }
    const ph = comp(m3, cw * ch * CFG.minFrac);
    // Pasek nagłówka (nadawca) leży nad czarnym tłem czatu: ciemnoszary, jednolity (np. 20,20,22). Doliczamy go do karty (kadr z nadawcą), ale NIE do maski zdjęcia.
    let hdr = 0, hgap = 0, hmode = null; const maxHdr = Math.round(ch * 0.3);
    const rowMode = (yy) => { const cnt = new Map(); let t = 0; for (let xx = card.x0; xx <= card.x1; xx++) { const i = (yy * W + xx) * 4, m = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); t++; if (m >= 10 && m <= 44 && m - mn <= 10) cnt.set(m, (cnt.get(m) || 0) + 1); } let bm = null, bc = 0; for (const [m] of cnt) { let c = 0; for (let k = -3; k <= 3; k++) c += cnt.get(m + k) || 0; if (c > bc) { bc = c; bm = m; } } return { mode: bm, frac: t ? bc / t : 0 }; };
    for (let yy = card.y0 - 1; yy >= 0 && hdr + hgap < maxHdr; yy--) { const r = rowMode(yy); const okRow = r.frac >= 0.5 && (hmode == null || Math.abs(r.mode - hmode) <= 3); if (okRow) { if (hmode == null) hmode = r.mode; hdr += hgap + 1; hgap = 0; } else if (++hgap > 2) break; }
    const cardBox = { x: card.x0 / S, y: (card.y0 - hdr) / S, w: cw / S, h: (ch + hdr) / S };
    if (!ph) return { card: cardBox, photo: null, black: { x: card.x0 / S, y: card.y0 / S, w: cw / S, h: ch / S }, header_px: Math.round(hdr / S) };
    let bx = ph.x0 - R, by = ph.y0 - R, bw = ph.x1 - ph.x0 + 1 + 2 * R, bh = ph.y1 - ph.y0 + 1 + 2 * R;
    // Dymki pod/nad zdjęciem są WĘŻSZE niż zdjęcie, a po wygładzeniu zlewają się z nim: tniemy wiersze, w których szerokość maski spada poniżej 70% mediany szerokości zdjęcia.
    { const cnt = []; for (let y = by; y < by + bh; y++) { let n = 0; for (let xx = Math.max(0, bx); xx < Math.min(W, bx + bw); xx++) n += m2[y * W + xx]; cnt.push(n); }
      const med = [...cnt].sort((a, b) => a - b)[cnt.length >> 1], thr = med * 0.7; const lo = Math.round(bh * 0.2);
      let s0 = 0; while (s0 < cnt.length - 2 && cnt[s0] < thr && cnt[s0 + 1] < thr) s0++;
      let e0 = cnt.length; for (let i = Math.max(s0 + lo, 1); i < cnt.length - 1; i++) if (cnt[i] < thr && cnt[i + 1] < thr) { e0 = i; break; }
      if (e0 - s0 >= 20) { by += s0; bh = e0 - s0; } }
    // Dymek wiadomości tuż nad/pod zdjęciem (neutralny ciemnoszary z tekstem) potrafi się zlać ze zdjęciem — obcinamy takie wiersze od góry i od dołu.
    const grayRow = (yy) => { let g = 0, w = 0, n = 0; for (let xx = Math.max(0, bx); xx < Math.min(W, bx + bw); xx++) { const i = (yy * W + xx) * 4, r = d[i], gg = d[i + 1], b = d[i + 2], m = Math.max(r, gg, b), mn = Math.min(r, gg, b); n++; if (m >= 28 && m <= 80 && m - mn <= 12) g++; else if (mn >= 190 && m - mn <= 14) w++; } return n && g / n >= 0.25 && (g + w) / n >= 0.5 ? 1 : 0; };
    let trimmed = 0, tb = 0; const lim = Math.round(bh * 0.4);
    // wiersze tekstu w dymku (po zmniejszeniu rozmyte) potrafią nie przejść testu — pozwalamy na przerwę do 2 wierszy
    for (;;) { let hit = -1; for (let k = 0; k < 3; k++) if (grayRow(Math.max(0, by + k))) { hit = k; break; } if (hit < 0 || trimmed + hit + 1 > lim || bh <= 20) break; by += hit + 1; bh -= hit + 1; trimmed += hit + 1; }
    for (;;) { let hit = -1; for (let k = 0; k < 3; k++) if (grayRow(Math.min(H - 1, by + bh - 1 - k))) { hit = k; break; } if (hit < 0 || tb + hit + 1 > lim || bh <= 20) break; bh -= hit + 1; tb += hit + 1; }
    // Po przycięciu wierszy: szerokość ramki mogła zostać po szerszym dymku (leżącym nad/pod zdjęciem) — zawężamy kolumny do tych, w których maska zdjęcia zajmuje ≥ 50% pozostałych wierszy.
    { let c0 = null, c1 = null; for (let xx = Math.max(0, bx); xx < Math.min(W, bx + bw); xx++) { let n = 0; for (let y = by; y < by + bh; y++) n += m2[y * W + xx]; if (n >= bh * 0.5) { if (c0 == null) c0 = xx; c1 = xx; } }
      if (c0 != null && (c1 - c0 + 1) <= bw * 0.92 && (c1 - c0 + 1) >= 20) { bx = c0; bw = c1 - c0 + 1; } }
    return { card: cardBox, black: { x: card.x0 / S, y: card.y0 / S, w: cw / S, h: ch / S }, header_px: Math.round(hdr / S), photo: { x: bx / S, y: by / S, w: bw / S, h: bh / S, area: Math.round(ph.n / (cw * ch) * 100) / 100, trimmed_bubble_px: Math.round((trimmed + tb) / S) } };
  }
  // Natywna rozdzielczość, PNG, bez skalowania i bez kompresji stratnej. Zerowy/ujemny obszar → błąd (ponowne sprawdzenie), nie zapis.
  async function pngAt(box) {
    await waitReady();
    const v = V(); const W = v.videoWidth, H = v.videoHeight;
    let sx = 0, sy = 0, sw = W, sh = H;
    if (box) { sx = Math.max(0, Math.round(box.x)); sy = Math.max(0, Math.round(box.y)); sw = Math.min(W, Math.round(box.x + box.w)) - sx; sh = Math.min(H, Math.round(box.y + box.h)) - sy; }
    if (!(sw > 8 && sh > 8)) throw new Error(`NOT_READY: pusty obszar wycinka (${sw}x${sh}, klatka ${W}x${H})`);
    const c = document.createElement("canvas"); c.width = sw; c.height = sh;
    c.getContext("2d").drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
    return { data: c.toDataURL("image/png").split(",")[1], w: sw, h: sh, source_w: W, source_h: H, box: { x: sx, y: sy, w: sw, h: sh } };
  }
  const okBox = (f) => { if (!f || !f.card || !f.photo) return false; const k = V().videoWidth / 360; const c = f.card, p = f.photo, a = p.w / p.h, tol = 4 * k; return p.w >= 70 * k && p.h >= 70 * k && a >= 0.5 && a <= 1.9 && p.x >= c.x - tol && p.y >= c.y - tol && p.x + p.w <= c.x + c.w + tol && p.y + p.h <= c.y + c.h + tol; };
  const why = (f) => { if (!f) return "brak ciemnej karty rozmowy"; if (!f.photo) return "karta jest, ale nie wykryto jasnego prostokąta zdjęcia"; return okBox(f) ? "ok" : `prostokąt poza kartą/zły rozmiar (${Math.round(f.photo.w)}x${Math.round(f.photo.h)})`; };
  // Szuka zdjęcia w oknie wokół czasu podanego przez model; zwraca najdłuższy ciąg klatek z ramką (przerwy do 0,6 s).
  // Okno wokół czasu modelu przeglądamy ODTWARZANIEM (jak zwykły widz, jeden seek na okno), a nie setkami przewinięć; próbki co >= `step` s z klatek wideo.
  async function sampleWindow(a, b, step) {
    const v = V(); const rows = [];
    if (!v.requestVideoFrameCallback) { for (let t = a; t <= b + 1e-6; t += step) { const tt = Math.round(t * 100) / 100; await seek(tt); const f = find(); rows.push({ t: tt, f }); } return rows; }
    await seek(a); v.muted = true; v.playbackRate = 1;
    let last = -1e9, stop = false; const t0 = Date.now();
    await new Promise((resolve, reject) => {
      const cb = (now, meta) => {
        if (stop) return;
        const t = meta.mediaTime;
        if (t >= b || Date.now() - t0 > (b - a) * 1000 * 2 + 15000) { stop = true; v.pause(); resolve(); return; }
        if (t - last >= step) { try { const f = find(); rows.push({ t: Math.round(t * 100) / 100, f }); last = t; } catch (e) { stop = true; v.pause(); reject(e); return; } }
        v.requestVideoFrameCallback(cb);
      };
      const fin = () => { if (!stop) { stop = true; v.pause(); resolve(); } };
      v.addEventListener("ended", fin, { once: true }); setTimeout(fin, (b - a) * 1000 * 2 + 8000);
      v.requestVideoFrameCallback(cb); v.play().catch((e) => { stop = true; reject(new Error("NOT_READY[SEEK]: nie można odtworzyć: " + e.message)); });
    });
    v.pause();
    // odtwarzanie w sterowanej przeglądarce bywa zbyt rzadkie (kilka próbek) — wtedy uzupełniamy przewijaniem przez odtwarzacz co 0,5 s
    if (rows.length < Math.max(4, Math.floor((b - a) / step / 3))) {
      const seen = new Set(rows.map((r) => r.t)); const extra = [];
      for (let t = a; t <= b + 1e-6; t += Math.max(step, 0.5)) { const tt = Math.round(t * 100) / 100; await seek(tt); extra.push({ t: tt, f: find() }); }
      return rows.concat(extra).sort((x, y) => x.t - y.t);
    }
    return rows;
  }
  // Szuka zdjęcia w oknie wokół czasu podanego przez model; zwraca najdłuższy ciąg klatek z ramką (przerwy do 0,6 s).
  async function refine(first, last, before = 1.5, after = 2.5, step = 0.25) {
    await waitReady(); const v = V(); const a = Math.max(0, first - before), b = Math.min(v.duration - 0.05, Math.max(last, first + 0.5) + after);
    if (!(b > a)) throw new Error(`NOT_READY: okno czasu puste (${a}–${b}, duration=${v.duration})`);
    const diag = {}; const rows = (await sampleWindow(a, b, step)).map(({ t, f }) => { const wy = why(f); const key = wy.replace(/\(.*\)/, "").trim(); diag[key] = (diag[key] || 0) + 1; return { t, ok: okBox(f), box: f && f.photo ? [f.photo.x, f.photo.y, f.photo.w, f.photo.h].map(Math.round) : null, card: f && f.card ? [f.card.x, f.card.y, f.card.w, f.card.h].map(Math.round) : null }; });
    const runs = [];
    for (const r of rows) { if (!r.ok) continue; const l = runs[runs.length - 1]; const same = l && Math.abs(r.box[2] - l.pts[l.pts.length - 1].box[2]) <= 14 * (v.videoWidth / 360) && Math.abs(r.box[3] - l.pts[l.pts.length - 1].box[3]) <= 14 * (v.videoWidth / 360); if (l && same && r.t - l.to <= 0.6) { l.to = r.t; l.pts.push(r); } else runs.push({ from: r.t, to: r.t, pts: [r] }); }
    if (!runs.length) return { found: false, all_runs: [], window: [a, b], checked: rows.length, diag, rows, k: v.videoWidth / 360, duration: v.duration };
    runs.sort((x, y) => (y.pts.length - x.pts.length) || (Math.abs(x.from - first) - Math.abs(y.from - first)));
    const all_runs = runs.map((x) => { const m = x.pts[Math.floor(x.pts.length / 2)]; return { from: x.from, to: x.to, n: x.pts.length, mid_t: m.t, box: m.box, card: m.card }; });
    const r = runs[0]; const mid = r.pts[Math.floor(r.pts.length / 2)];
    return { found: true, run: [r.from, r.to], n: r.pts.length, mid_t: mid.t, box: mid.box, other_runs: runs.slice(1, 4).map((x) => [x.from, x.to]), all_runs, window: [a, b], checked: rows.length, diag, rows, k: v.videoWidth / 360, card: mid.card, duration: v.duration };
  }
  // Geometria do diagnostyki: współrzędne karty i zdjęcia w pikselach źródła, proporcje i udział zdjęcia w karcie.
  const geom = (f) => { const v = V(); return { src: [v.videoWidth, v.videoHeight], card: f && f.card ? [f.card.x, f.card.y, f.card.w, f.card.h].map(Math.round) : null, photo: f && f.photo ? [f.photo.x, f.photo.y, f.photo.w, f.photo.h].map(Math.round) : null,
    aspect: f && f.photo ? Math.round(f.photo.w / f.photo.h * 100) / 100 : null, photo_card_ratio: f && f.card && f.photo ? Math.round(f.photo.w * f.photo.h / (f.card.w * f.card.h) * 100) / 100 : null, trimmed_bubble_px: f && f.photo ? f.photo.trimmed_bubble_px : null, header_px: f ? f.header_px : null }; };
  // Klatka diagnostyczna: cała klatka (JPEG) z zaznaczoną kartą (zielona) i proponowanym wycinkiem (czerwona) + liczby. Służy do oceny, dlaczego wycinek został odrzucony.
  async function diag(t) {
    await seek(t); const v = V(); const f = find(0.02); const W = v.videoWidth, H = v.videoHeight;
    const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d"); x.drawImage(v, 0, 0, W, H);
    x.lineWidth = Math.max(3, Math.round(W / 200)); x.font = `${Math.round(W / 40)}px sans-serif`;
    if (f && f.card) { x.strokeStyle = "#00ff00"; x.strokeRect(f.card.x, f.card.y, f.card.w, f.card.h); }
    if (f && f.photo) { x.strokeStyle = "#ff0000"; x.strokeRect(f.photo.x, f.photo.y, f.photo.w, f.photo.h); }
    const g = geom(f); x.fillStyle = "#ffff00"; x.fillText(`t=${v.currentTime.toFixed(2)} ${W}x${H} wycinek=${g.photo ? g.photo.join(",") : "-"} karta=${g.card ? g.card.join(",") : "-"} udział=${g.photo_card_ratio}`, 10, Math.round(W / 30));
    return { jpeg: c.toDataURL("image/jpeg", 0.85).split(",")[1], geom: g, t_actual: v.currentTime, why: why(f) };
  }
  // Jedno przewinięcie, jedna klatka: wykrycie, pełna klatka i wycinek z TEGO SAMEGO momentu; walidacja treści wycinka.
  async function capture(t, withFull = true) {
    await seek(t); const ver = assertVideo(); const v = V();
    const f = find(); if (!okBox(f)) return { ok: false, why: why(f), t, video: ver, geom: geom(f) };
    const full = withFull ? await pngAt(null) : { source_w: v.videoWidth, source_h: v.videoHeight }; const crop = await pngAt(f.photo);
    const ac = f.card.w * f.card.h, ap = f.photo.w * f.photo.h;
    if (ap > 0.6 * ac) return { ok: false, why: "wycinek zajmuje zbyt dużą część karty — nie wygląda na zdjęcie", t, video: ver, geom: geom(f) };
    const im = new Image(); await new Promise((r, j) => { im.onload = r; im.onerror = j; im.src = "data:image/png;base64," + crop.data; });
    const c = document.createElement("canvas"); c.width = 64; c.height = 64; const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(im, 0, 0, 64, 64);
    const d = x.getImageData(0, 0, 64, 64).data; let dk = 0; for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) < 24) dk++;
    const dark = dk / 4096; if (dark > 0.6) return { ok: false, why: `wycinek zbyt ciemny (${Math.round(dark * 100)}% czerni)`, t, video: ver, geom: geom(f) };
    return { ok: true, t, t_actual: v.currentTime, video: ver, full, crop, dark_fraction: Math.round(dark * 100) / 100, card: f.card, geom: geom(f) };
  }
  // Skan okna czasu: dla każdej próbki (co ~step s) czy jest zdjęcie (ramka) i gdzie jest karta rozmowy. Do wyboru klatek kontekstowych.
  async function contextScan(a, b, step = 0.25) {
    await waitReady(); const v = V(); a = Math.max(0, a); b = Math.min(v.duration - 0.05, b);
    if (!(b > a)) throw new Error(`NOT_READY: okno skanu puste (${a}–${b})`);
    const rows = (await sampleWindow(a, b, step)).map(({ t, f }) => ({ t, ok: okBox(f), box: f && f.photo ? [f.photo.x, f.photo.y, f.photo.w, f.photo.h].map(Math.round) : null, card: f && f.card ? [f.card.x, f.card.y, f.card.w, f.card.h].map(Math.round) : null }));
    return { rows, window: [a, b], k: v.videoWidth / 360, duration: v.duration };
  }
  // Screen kontekstowy: jedna klatka, kadr = cała karta rozmowy (zdjęcie, wiadomości, nadawca) z zapasem; tło gry odcięte. needPhoto: wymagaj widocznego zdjęcia.
  async function shotAt(t, needPhoto) {
    await seek(t); const ver = assertVideo(); const v = V();
    const f = find(0.02); if (!f || !f.card) return { ok: false, why: "brak ciemnej karty rozmowy", t, video: ver };
    const c = f.card; if (c.w * c.h < 0.03 * v.videoWidth * v.videoHeight) return { ok: false, why: `karta zbyt mała (${Math.round(c.w)}x${Math.round(c.h)})`, t, video: ver };
    const photoOk = okBox(f); if (needPhoto && !photoOk) return { ok: false, why: why(f), t, video: ver };
    const k = v.videoWidth / 360; const px = Math.round(4 * k), top = Math.round(c.h * 0.03); // zapas u góry na pasek z nadawcą, jeśli leży nad ciemną kartą
    const box = { x: c.x - px, y: c.y - top, w: c.w + 2 * px, h: c.h + top + px };
    const img = await pngAt(box);
    return { ok: true, t, t_actual: v.currentTime, video: ver, img, photo_visible: photoOk, photo_box: photoOk ? [f.photo.x, f.photo.y, f.photo.w, f.photo.h].map(Math.round) : null, card: [c.x, c.y, c.w, c.h].map(Math.round) };
  }
  // Wybór jakości przez odtwarzacz YouTube; czeka na faktyczną zmianę rozdzielczości źródła (videoWidth/Height).
  async function setQuality(targets) {
    const p = document.getElementById("movie_player"); const v = V();
    const out = { available: p && p.getAvailableQualityLevels ? p.getAvailableQualityLevels() : null, before: { w: v.videoWidth, h: v.videoHeight }, tried: [] };
    if (!p || !p.setPlaybackQualityRange) { out.error = "brak interfejsu jakości odtwarzacza"; out.after = out.before; return out; }
    const t = v.currentTime;
    for (const q of targets) {
      if (out.available && !out.available.includes(q)) { out.tried.push({ q, skipped: "niedostępna dla tego filmu" }); continue; }
      const w0 = v.videoWidth; p.setPlaybackQualityRange(q, q); if (p.setPlaybackQuality) p.setPlaybackQuality(q);
      let changed = false; for (let i = 0; i < 50; i++) { await sleep(300); if (v.videoWidth !== w0 && ready()) { changed = true; break; } if (v.videoWidth === w0 && p.getPlaybackQuality && p.getPlaybackQuality() === q && ready() && i > 6) { changed = true; break; } }
      out.tried.push({ q, changed, w: v.videoWidth, h: v.videoHeight, reported: p.getPlaybackQuality && p.getPlaybackQuality() });
      if (changed) { out.chosen = q; break; }
    }
    try { await waitReady(); v.pause(); v.currentTime = t; } catch (e) { out.error = String(e.message); }
    out.after = { w: v.videoWidth, h: v.videoHeight }; return out;
  }
  window.__fr = { CFG, playerKind, seek, find, pngAt, capture, contextScan, shotAt, diag, geom, setId, assertVideo, blockAutoplay, refine, okBox, setQuality, waitReady, info: () => { const v = V(); return { w: v.videoWidth, h: v.videoHeight, dur: v.duration, ready: v.readyState }; } };
})();
