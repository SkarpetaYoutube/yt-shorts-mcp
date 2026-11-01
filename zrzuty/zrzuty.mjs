// Zrzuty zdjęć z rozmów w rolkach. Działa NA TWOIM KOMPUTERZE w Twojej przeglądarce (Edge/Chrome).
// Dwa źródła klatek:
//   (a) YouTube: otwiera rolkę jak zwykły widz i ustawia czas odtwarzania (nie pobiera plików wideo, nie omija reklam ani logowania),
//   (b) lokalne MP4:  --local <folder>  (pliki <video_id>.mp4 / .webm w folderze) — gdy YouTube nie jest dostępny.
// Dla każdego zdjęcia z wyniku modelu: sprawdza sąsiednie klatki (okno wokół czasu modelu, krok 0,25 s), mierzy rzeczywisty czas
// widoczności zdjęcia, zapisuje (1) pełny zrzut rozmowy i (2) wycinek samego zdjęcia. Gdy zdjęcia nie potwierdzi — zapisuje klatkę
// z czasu modelu i oznacza to w manifeście (crop=null, confirmed=false).
// Użycie: node zrzuty.mjs <eksport.json> <folder_wyjsciowy> [--local folder_z_mp4] [--channel msedge|chrome|chromium] [--only ID,ID] [--pause 6]
import { chromium } from "playwright";
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neededMessages, neededBefore, chooseBeforeShot, chooseShots, resolveOwners, assignRun, ctxScore, contextCategory, mergeBest, CTX } from "./kontekst.mjs";
import { handleGate, startConsentWatcher } from "./bramka.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const [inFile, outDir] = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!inFile || !outDir) { console.error("Użycie: node zrzuty.mjs <eksport.json> <folder_wyjsciowy> [--local folder] [--channel msedge] [--only ID,ID]"); process.exit(2); }
const channel = opt("channel", "msedge");
const only = opt("only", "") ? opt("only", "").split(",") : null;
const pauseS = Number(opt("pause", "6"));
const localDir = opt("local", null);
const redo = opt("redo", "") ? new Set(opt("redo", "").split(",")) : new Set(); // --redo ID#nr,ID#nr: przetwórz te zdjęcia od nowa (reszta poprawnych zostaje nietknięta)
const reelMaxS = Number(opt("reel-max", "480")); // twardy limit czasu na jedną rolkę (s): po przekroczeniu przeglądarka jest zamykana, rolka oznaczana jako NIEUKOŃCZONA i program przechodzi dalej
const maxTotalS = Number(opt("max-total", "1500")); // twardy limit czasu CAŁEJ próby (s): obejmuje przewijanie, przeładowania i oczekiwanie; po nim program kończy się z zapisanym manifestem
const callMaxS = Number(opt("call-max", "120")); // limit jednego wywołania w stronie (skan okna, przewinięcie, zrzut) — zawieszone wywołanie nie blokuje rolki
const shiftTol = Number(opt("shift", "0.5"));
// budżet ponowień odtwarzacza na rolkę (domyślnie jak dotąd); druga runda w zbierz_rolki.ps1 podaje większy, bo zostają tylko rolki, które zawiodły
const maxReloads = Number(opt("reloads", "2")), retryBudgetMs = Number(opt("retry-budget", "90")) * 1000, bufferWaitMs = Number(opt("buffer-wait", "12")) * 1000;
const runStart = Date.now(), runEnd = runStart + maxTotalS * 1000;
const failStatus = (m, other) => (/LIMIT_CZASU|LIMIT CZASU/.test(m) ? (/całej/.test(m) ? "NIEUKONCZONA_LIMIT_CALOSCI" : "NIEUKONCZONA_LIMIT_CZASU") : /LIMIT_PONOWIEN/.test(m) ? "ODTWARZACZ_NIEDOSTEPNY" : other);
const withTimeoutTop = (p, ms, what) => { let tm; return Promise.race([p.finally(() => clearTimeout(tm)), new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(`NOT_READY[ZAWIESZENIE]: ${what} przekroczyło ${Math.round(ms / 1000)} s`)), Math.max(1000, ms)); })]); }; // tolerancja rozbieżności czasu modelu i zmierzonego (s)
// --probe "ID#nr=t1,t2,..." — wariant awaryjny dla jednego zdjęcia: zapisuje w podanych chwilach pełną klatkę oraz kadr karty rozmowy (bez wykrywania i bez ciasnego wycinka); ocena wzrokowa po stronie człowieka/Claude.
const probeMap = {}; for (const part of opt("probe", "").split(";").filter(Boolean)) { const [k, v] = part.split("="); probeMap[k] = v.split(",").map(Number); }
const onlyImages = opt("images", "") ? opt("images", "").split(",").map(Number) : null; // np. --images 1,4 (tylko wskazane zdjęcia)
// Osobny, trwały profil przeglądarki tylko dla programu (cookies i wybór zgody przetrwają między rolkami i uruchomieniami). NIE jest to profil osobisty użytkownika.
const profileRoot = path.resolve(opt("profile", path.join(here, "..", "profil_przegladarki_programu")));
const headless = args.includes("--headless");
const QUALITY = opt("quality", "hd1080,hd1440,hd2160,hd720").split(",").map((x) => x.trim()); // kolejność prób; pierwsza zmieniająca rozdzielczość wygrywa

export const sec = (t) => {
  if (t == null) return null;
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(String(t).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// --- lokalny serwer plików wideo (z obsługą Range, bo bez niego przewijanie nie działa)
let server = null, base = null;
async function startServer() {
  const types = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };
  server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (u.startsWith("/page/")) {
      const id = u.slice(6);
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><body style="margin:0;background:#000">${process.env.ZRZUTY_TEST_RELOAD ? "<script>if(!sessionStorage.r){setTimeout(()=>{sessionStorage.r=1;location.reload()},4000)}</script>" : ""}${process.env.ZRZUTY_FAKE_PLAYER ? "<div id=movie_player></div><script>addEventListener(\"load\",()=>{const p=document.getElementById(\"movie_player\"),v=document.querySelector(\"video\");p.seekTo=(t)=>{v.currentTime=t};p.playVideo=()=>v.play();p.pauseVideo=()=>v.pause()})</script>" : ""}${process.env.ZRZUTY_FAKE_ERROR ? "<script>addEventListener(\"load\",()=>{const p=document.getElementById(\"movie_player\");if(p){p.seekTo=()=>{};p.playVideo=()=>{};const e=document.createElement(\"div\");e.className=\"ytp-error\";e.innerText=\"Coś poszło nie tak. Spróbuj ponownie później.\";p.appendChild(e)}})</script>" : ""}<video id=v src="/v/${id}" muted playsinline style="height:100vh"></video></body>`);
    }
    if (u.startsWith("/v/")) {
      const f = path.join(localDir, path.basename(u.slice(3)));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      const size = fs.statSync(f).size, ct = types[path.extname(f).toLowerCase()] || "application/octet-stream";
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
      if (m) {
        const s = m[1] ? Number(m[1]) : 0, e = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        res.writeHead(206, { "content-type": ct, "accept-ranges": "bytes", "content-range": `bytes ${s}-${e}/${size}`, "content-length": e - s + 1 });
        return fs.createReadStream(f, { start: s, end: e }).pipe(res);
      }
      res.writeHead(200, { "content-type": ct, "accept-ranges": "bytes", "content-length": size });
      return fs.createReadStream(f).pipe(res);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const localFile = (id) => (localDir ? fs.readdirSync(localDir).find((f) => f.startsWith(id + ".") && /\.(mp4|webm|mov)$/i.test(f)) : null);

const records = JSON.parse(fs.readFileSync(inFile, "utf8")).filter((r) => r.vision && r.vision.images?.length && (!only || only.includes(r.video_id)))
  .map((r) => (onlyImages ? { ...r, vision: { ...r.vision, images: r.vision.images.filter((im) => onlyImages.includes(im.id)) } } : r)).filter((r) => r.vision.images.length);
const diagFile = path.join(outDir, "diagnostyka.log");
fs.mkdirSync(outDir, { recursive: true });
// ponowne uruchomienie nie nadpisuje poprzedniego logu ani podsumowania przebiegu: stary plik dostaje sygnaturę czasu (nic nie jest kasowane)
const archiveOld = (p) => { if (fs.existsSync(p) && fs.statSync(p).size > 0) fs.renameSync(p, p.replace(/\.(log|json)$/, `.stary-${Date.now()}.$1`)); };
archiveOld(diagFile);
fs.writeFileSync(diagFile, "");
const D = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(diagFile, l + "\n"); };
fs.mkdirSync(outDir, { recursive: true });
if (localDir) await startServer();
const lib = fs.readFileSync(path.join(here, "inpage.js"), "utf8");

D(`node ${process.version}, playwright, platforma ${process.platform}; rekordów do przetworzenia: ${records.length}; kanał: ${channel}`);
const order = [...new Set([channel, "msedge", "chrome", "chromium"])];

// ---- Sesja przeglądarki: JEDNA przeglądarka z trwałym profilem programu na całą partię; po awarii odtwarzana z tego samego profilu.
let session = null, closedWhy = null, blockedWhy = null, curId = null, reelTimedOut = false, keptNow = [];
const stats = { consent_screens: 0, consent_rejected: 0, session_launches: 0, session_restores: 0, human_required: [], browsers_used: [] };
async function getPage(ch) {
  if (session && session.ch === ch && !session.closed && !session.page.isClosed()) return session.page;
  const restore = !!session;
  if (session && !session.closed) { try { await session.ctx.close(); } catch {} }
  const dir = path.join(profileRoot, ch); fs.mkdirSync(dir, { recursive: true });
  D(`${restore ? "odtwarzam sesję z tego samego profilu" : "start przeglądarki"} (${ch}); profil programu: ${dir}`);
  const ctx = await chromium.launchPersistentContext(dir, { channel: ch === "chromium" ? undefined : ch, headless, chromiumSandbox: process.platform !== "linux", viewport: { width: 900, height: 1000 }, args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=CalculateNativeWinOcclusion"] });
  stats.session_launches++; if (restore) stats.session_restores++; if (!stats.browsers_used.includes(ch)) stats.browsers_used.push(ch);
  const s = { ctx, ch, closed: false, page: null };
  ctx.on("close", () => { s.closed = true; closedWhy = closedWhy || "przeglądarka zamknięta"; D("  EVENT context close"); });
  const page = ctx.pages()[0] || await ctx.newPage();
  for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});
  await page.route((u) => u.hostname.endsWith("youtube.com") && u.pathname === "/watch" && u.searchParams.get("v") && curId && u.searchParams.get("v") !== curId, (r) => { D(`  ZABLOKOWANO nawigację do innego filmu: ${r.request().url().slice(0, 90)}`); return r.abort(); });
  page.on("close", () => { closedWhy = closedWhy || "karta zamknięta"; D("  EVENT page close"); });
  page.on("crash", () => { closedWhy = "karta ZAWIESIŁA SIĘ (crash renderera)"; D("  EVENT page crash"); });
  page.on("pageerror", (e) => D(`  pageerror: ${String(e).slice(0, 200)}`));
  page.on("popup", () => D("  EVENT popup"));
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) D(`  nawigacja: ${f.url().slice(0, 120)}`); });
  s.stopWatch = startConsentWatcher(page, stats, D); // stały strażnik zgody: nakładka „Zanim przejdziesz do YouTube” może wyskoczyć w dowolnym momencie
  ctx.on("close", () => s.stopWatch && s.stopWatch());
  s.page = page; session = s; return page;
}
/** Jedno podejście do rolki w świeżo uruchomionej przeglądarce; zwraca wpisy manifestu. Zamknięcie przeglądarki/karty jest logowane z przyczyną. */
async function processReel(rec, ch) {
  const entries = [];
  const dir = path.join(outDir, "frames", rec.video_id);
  fs.mkdirSync(dir, { recursive: true });
  closedWhy = null; blockedWhy = null; curId = rec.video_id;
  const reelEnd = Math.min(Date.now() + reelMaxS * 1000, runEnd - 15000); const reelLimitWhy = reelEnd < Date.now() + reelMaxS * 1000 ? `limit całej próby ${maxTotalS} s` : `limit rolki ${reelMaxS} s`;
  try {
    const page = await getPage(ch);
    if (page.url() !== "about:blank") await page.goto("about:blank").catch(() => {}); // ta sama karta i ten sam profil — bez nowej pustej sesji
    let ready = false, note = null, source = "youtube", wantQuality = false, want = 0;
    const prepare = async (first) => {
      if (localDir) {
        const f = localFile(rec.video_id);
        if (!f) throw new Error(`brak pliku ${rec.video_id}.mp4 w folderze ${localDir}`);
        source = "lokalny plik " + f;
        await page.goto(`${base}/page/${f}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      } else {
        if (first || !/youtube\.com\/watch/.test(page.url())) await page.goto(`https://www.youtube.com/watch?v=${rec.video_id}${want > 5 ? `&t=${Math.floor(want)}s` : ""}`, { waitUntil: "domcontentloaded", timeout: 45000 }); // &t= : start od okolic szukanego czasu (omija zawieszanie dalekich przewinięć)
        D(`  strona: "${await page.title().catch(() => "?")}"`);
        const flag = path.join(profileRoot, session.ch, "zgoda_zapisana.flag"); // jest po pierwszym obsłużonym ekranie zgody w tym profilu
        const g = await handleGate(page, stats, D, { waitForOverlayMs: fs.existsSync(flag) ? 0 : 8000 });
        if (!g.blocked && !g.unavailable && !g.timeout) { try { fs.writeFileSync(flag, new Date().toISOString()); } catch {} }
        if (g.blocked) { blockedWhy = g.blocked; D(`  BLOKADA WYMAGAJĄCA CZŁOWIEKA: ${g.blocked} — pomijam tę rolkę (bez czekania)`); throw new Error("BLOCKED: " + g.blocked); }
        if (g.unavailable) throw new Error("FILM_NIEDOSTEPNY: " + g.unavailable);
        if (g.timeout) D("  uwaga: odtwarzacz nie pojawił się w 40 s po bramce zgody");
      }
      await page.waitForSelector("video", { timeout: 30000 });
      for (let i = 0; i < 40; i++) { if (!(await page.evaluate(() => !!document.querySelector(".ad-showing")))) break; D("  reklama — czekam"); await page.waitForTimeout(1000); }
      await page.evaluate(async () => { const v = document.querySelector("video"); v.muted = true; for (let i = 0; i < 100 && v.readyState < 2; i++) await new Promise((r) => setTimeout(r, 200)); v.pause(); });
      const info = await page.evaluate(() => { const v = document.querySelector("video"); return { ready: v.readyState, w: v.videoWidth, h: v.videoHeight, dur: v.duration, err: v.error && v.error.code }; });
      D(`  wideo: ${JSON.stringify(info)}`);
      ready = info.ready >= 2 && info.w > 0;
      if (!ready) { note = `wideo nie załadowało się (${JSON.stringify(info)})`; return; }
      await page.evaluate(lib); const ap = await page.evaluate(([id, d]) => window.__fr.setId(id, d), [localDir ? null : rec.video_id, rec.duration_seconds]); D(`  biblioteka wstrzyknięta; zabezpieczenie ID=${rec.video_id}, długość ok. ${rec.duration_seconds} s; autoodtwarzanie: ${JSON.stringify(ap)}`);
      if (wantQuality) { const q2 = await page.evaluate(async (t) => window.__fr.setQuality(t), QUALITY); D(`  jakość po odtworzeniu stanu: ${JSON.stringify(q2.after)}`); }
    };
    const TT = { start: Date.now() };
    try { await withTimeoutTop(prepare(true), Math.min(90000, Math.max(1000, reelEnd - Date.now())), "otwarcie strony"); } catch (e) { note = "błąd otwarcia: " + String(e.message).split("\n")[0] + (closedWhy ? ` [${closedWhy}]` : ""); D("  " + note); }
    // odporność: YouTube potrafi przeładować kartę w trakcie pracy (niszczy kontekst i wstrzykniętą bibliotekę) — wtedy przygotowujemy stronę od nowa i ponawiamy to zdjęcie
    const dump = async (tag) => {
      try {
        const st = await page.evaluate(() => { const p = document.getElementById("movie_player"); const v = document.querySelector("video"); const err = document.querySelector(".ytp-error, .ytp-error-content-wrap"); return { url: location.href, title: document.title, webdriver: navigator.webdriver, video: v ? { rs: v.readyState, w: v.videoWidth, h: v.videoHeight, dur: v.duration, err: v.error && { code: v.error.code, msg: v.error.message }, src: (v.currentSrc || "").slice(0, 40) } : null, playerState: p && p.getPlayerState && p.getPlayerState(), errorText: err ? err.innerText.slice(0, 200) : null, playability: (() => { try { return p.getPlayerResponse().playabilityStatus; } catch { return null; } })() }; });
        D(`  STAN STRONY (${tag}): ${JSON.stringify(st).slice(0, 700)}`);
      } catch (e) { D(`  STAN STRONY (${tag}): nie odczytano: ${String(e.message).split("\n")[0]}`); }
      try { await page.screenshot({ path: path.join(outDir, `diag_${rec.video_id}_${tag}.png`) }); } catch {}
    };
    // Ponowienia odtwarzacza są OGRANICZONE na rolkę: najwyżej MAX_RELOADS przeładowań i RETRY_BUDGET_MS łącznego czasu bez postępu; potem rolka kończy się jawnym statusem (nie kilka minut na jednej rolce).
    // Przyczyny rozdzielone: BLAD_ODTWARZACZA (ekran błędu YouTube) | BUFOROWANIE (czekamy bez przeładowania) | SEEK (przewinięcie nie zadziałało) | ZLY_FILM.
    const MAX_RELOADS = maxReloads, RETRY_BUDGET_MS = retryBudgetMs;
    const player = { reloads: 0, retryMs: 0, incidents: [], exhausted: null };
    const logPlayer = () => { (stats.player_by_reel ||= {})[rec.video_id] = { incidents: player.incidents.length, reloads: player.reloads, retry_s: Math.round(player.retryMs / 1000), exhausted: player.exhausted }; D(`  odtwarzacz: incydentów ${player.incidents.length} (${["BLAD_ODTWARZACZA", "BUFOROWANIE", "SEEK", "ZLY_FILM"].map((k) => k + " ×" + player.incidents.filter((x) => x.kind === k).length).join(", ")}), przeładowań ${player.reloads}/${MAX_RELOADS}, czas bez postępu ${Math.round(player.retryMs / 1000)} s${player.exhausted ? "; BUDŻET PONOWIEŃ WYCZERPANY" : ""}`); };
    const kindOf = (m) => (/NOT_READY\[(BLAD_ODTWARZACZA|BUFOROWANIE|SEEK|ZAWIESZENIE)\]/.exec(m) || [])[1] || (/WRONG_VIDEO/.test(m) ? "ZLY_FILM" : null);
    // Twardy limit: każde wywołanie w stronie i każde przygotowanie strony ma własny limit czasu, a całość nie przekroczy końca rolki (reelEnd) — także w trakcie oczekiwania.
    const left = () => reelEnd - Date.now();
    const withTimeout = (p, ms, what) => { let tm; return Promise.race([p.finally(() => clearTimeout(tm)), new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(`NOT_READY[ZAWIESZENIE]: ${what} przekroczyło ${Math.round(ms / 1000)} s`)), Math.max(1000, ms)); })]); };
    const guard = () => { if (left() <= 0) throw new Error(`LIMIT_CZASU: koniec czasu (${reelLimitWhy})`); };
    const waitStable = (ms) => page.evaluate(async (ms) => { const t0 = Date.now(); const v = document.querySelector("video"); while (Date.now() - t0 < ms) { if (v && v.readyState >= 3 && v.videoWidth > 0) return true; if (window.__fr && window.__fr.playerKind && window.__fr.playerKind().kind === "BLAD_ODTWARZACZA") return false; await new Promise((r) => setTimeout(r, 300)); } return false; }, ms).catch(() => false);
    const run = async (fn, arg) => {
      let buffWaited = false, last = null;
      for (let k = 0; k < 4; k++) {
        if (blockedWhy) throw new Error("BLOCKED: " + blockedWhy);
        const tTry = Date.now(); const spent = () => { player.retryMs += Date.now() - tTry; };
        try {
          guard();
          if (!(await withTimeout(page.evaluate(() => !!window.__fr), 10000, "sprawdzenie strony").catch(() => false))) { D("  biblioteki brak (strona przeładowana) — przygotowuję od nowa"); await withTimeout(prepare(false), Math.min(60000, left()), "przygotowanie strony"); }
          return await withTimeout(page.evaluate(fn, arg), Math.min(callMaxS * 1000, left(), k === 0 ? Infinity : Math.max(15000, RETRY_BUDGET_MS - player.retryMs)), "wywołanie w stronie");
        } catch (err) {
          last = err; const m = String(err.message); const kind = kindOf(m);
          if (closedWhy || /^LIMIT_(PONOWIEN|CZASU)/.test(m)) throw err;
          if (left() < 10000) throw new Error(`LIMIT_CZASU: koniec czasu (${reelLimitWhy}); ostatni problem: ${m.split("\n")[0].slice(0, 120)}`);
          if (!kind) { // zwykła utrata kontekstu strony (YouTube przeładował kartę): dwa szybkie ponowienia bez przeładowania
            if (!/Execution context was destroyed|__fr|undefined|IndexSizeError|source width/.test(m) || k >= 2) throw err;
            D(`  ponawiam (${m.split("\n")[0].slice(0, 90)})`); await page.waitForTimeout(1500); continue;
          }
          D(`  problem odtwarzacza: ${kind} — ${m.split("\n")[0].slice(0, 220)}`); player.incidents.push({ kind, at: new Date().toISOString() });
          if (player.exhausted) { spent(); throw new Error(`LIMIT_PONOWIEN: ${player.exhausted}`); }
          await dump(`${kind.toLowerCase()}${player.incidents.length}`);
          if (kind === "BUFOROWANIE" && !buffWaited && left() > 15000) { buffWaited = true; D(`  buforowanie: czekam do ${Math.round(bufferWaitMs / 1000)} s na dane, bez przeładowania`); const okw = await withTimeout(waitStable(bufferWaitMs), bufferWaitMs + 3000, "oczekiwanie na bufor").catch(() => false); spent(); if (okw) continue; }
          if (player.reloads >= MAX_RELOADS || player.retryMs >= RETRY_BUDGET_MS || left() < 10000) { spent(); player.exhausted = `budżet ponowień rolki wyczerpany (przeładowań ${player.reloads}/${MAX_RELOADS}, ${Math.round(player.retryMs / 1000)} s bez postępu; ostatnia przyczyna: ${kind})`; D(`  ${player.exhausted} — dalej nie ponawiam`); throw new Error(`LIMIT_PONOWIEN: ${player.exhausted}`); }
          player.reloads++; D(`  ${kind}: przeładowuję stronę i odtwarzam stan (przeładowanie ${player.reloads}/${MAX_RELOADS})`);
          await withTimeout(prepare(true), Math.min(60000, Math.max(1000, left())), "przeładowanie strony").catch((e2) => D("  przygotowanie nie powiodło się: " + String(e2.message).split("\n")[0]));
          spent();
        }
      }
      throw last;
    };
    // Faza A: wykrycie zdjęcia i pomiar czasu (na domyślnej jakości — szybko). Faza B: wybór najwyższej jakości (docelowo 1080p) i zapis PNG w natywnej rozdzielczości.
    const attemptOf = (im) => { const p0 = prev.find((x) => x.video_id === rec.video_id && x.image_id === im.id); return p0 ? (p0.attempts_total ?? p0.attempt_no ?? 1) + 1 : 1; };
    const items = rec.vision.images.map((im) => ({ im, e: { video_id: rec.video_id, image_id: im.id, attempt_no: attemptOf(im), attempt_at: new Date().toISOString(), file_suffix: attemptOf(im) > 1 ? `_proba${attemptOf(im)}` : "", model_first: im.first_visible, model_last: im.last_visible, source, channel: ch, confirmed: false, measured_first_s: null, measured_last_s: null,
      capture_t_s: null, conversation_file: null, photo_file: null, photo_box_px: null, source_resolution: null, photo_resolution: null, quality_note: null, note: null } }));
    for (const it of items) entries.push(it.e);
    if (!ready) { for (const it of items) it.e.note = note; return entries; }
    TT.open = Date.now();
    const stage = [], meas = [];
    for (const it of items) {
      const { im, e } = it; const first = sec(im.first_visible), last = sec(im.last_visible);
      const pk = probeMap[`${rec.video_id}#${im.id}`];
      if (pk) { // wariant awaryjny: pełne klatki w podanych chwilach, bez progów wykrywania
        e.selection = "RECZNY_AWARYJNY (nie wynik automatyczny)"; e.status = "WARIANT_AWARYJNY_DO_OCENY"; e.context_v = 2; e.context_complete = false; e.confirmed = false; e.crop_confirmed = false; e.crop_status = "NIE_PROBOWANO (wariant awaryjny)"; e.context_shots = []; e.note = `wariant awaryjny: klatki w chwilach ${pk.join(", ")} s; potwierdzenie wyłącznie wzrokowe`;
        try { for (const [i, t] of pk.entries()) {
          const s2 = await run(async (t) => { const r = await window.__fr.shotAt(t, false); const full = await window.__fr.pngAt(null); return { r, full: full.data, w: full.w, h: full.h }; }, t);
          const rel = `frames/${rec.video_id}/zdjecie${im.id}${e.file_suffix}_awaryjna${i + 1}_t${String(Math.round(t * 100)).padStart(4, "0")}`;
          fs.writeFileSync(path.join(outDir, rel + "_pelna.png"), Buffer.from(s2.full, "base64"));
          if (s2.r.ok) fs.writeFileSync(path.join(outDir, rel + "_karta.png"), Buffer.from(s2.r.img.data, "base64"));
          e.context_shots.push({ order: i + 1, role: "awaryjna", t_s: Math.round(s2.r.t_actual * 100) / 100 || t, t_planned_s: t, file: s2.r.ok ? rel + "_karta.png" : rel + "_pelna.png", full_frame_file: rel + "_pelna.png", resolution: `${s2.w}x${s2.h}`, photo_visible: s2.r.ok ? s2.r.photo_visible : null, card_found: !!s2.r.ok, reason: "klatka awaryjna" });
          D(`  zdjęcie ${im.id}: klatka awaryjna ${i + 1} t=${t} s: karta=${s2.r.ok ? "tak" : "NIE (" + s2.r.why + ")"} zdjęcie_widoczne=${s2.r.ok ? s2.r.photo_visible : "?"}`);
        } } catch (err) { e.note += "; błąd: " + String(err.message).split("\n")[0]; D(`  zdjęcie ${im.id}: ${e.note}`); }
        e.conversation_file = e.context_shots[0]?.file ?? null; continue;
      }
      if (first == null) { e.note = "model nie podał czasu — nie wiadomo, gdzie szukać"; e.status = "BRAK_CZASU_MODELU"; continue; }
      try {
        want = Math.max(0, first - 1.5);
        const r = await run(([a, b]) => window.__fr.refine(a, b), [first, last ?? first]);
        meas.push({ it, first, last: last ?? first, r });
        D(`  zdjęcie ${im.id}: faza A: ${r.found ? `ciągi w oknie ${r.window.map((x) => x.toFixed(1)).join("–")} s: ${(r.all_runs || []).map((x) => `${x.from}–${x.to} (${x.n} kl.)`).join(", ")}` : "nic w oknie " + r.window.map((x) => x.toFixed(1)).join("–") + " s"}`);
      } catch (err) { const m = String(err.message); e.note = "błąd fazy A: " + m.split("\n")[0] + (closedWhy ? ` [przyczyna: ${closedWhy}]` : ""); e.status = failStatus(m, "BLAD_FAZY_A"); e.closed = !!closedWhy; D(`  zdjęcie ${im.id}: ${e.note}`); if (closedWhy) return entries; }
    }
    // --- Przypisanie zmierzonych ciągów do obrazów. Czasy modelu to wskazówka; jeden ciąg nie może należeć do dwóch zdjęć (ani do zdjęcia z wcześniejszego poprawnego biegu).
    const fixed = keptNow.filter((k) => Number.isFinite(k.measured_first_s) && Number.isFinite(k.measured_last_s)).map((k) => ({ key: `#${k.image_id}(zachowane)`, kept: true, model: [sec(k.model_first), sec(k.model_last)], cands: [{ from: k.measured_first_s, to: k.measured_last_s, n: 99 }] }));
    const owners = resolveOwners([...fixed, ...meas.map((x) => ({ key: `#${x.it.im.id}`, model: [x.first, x.last], cands: x.r.all_runs || [] }))], shiftTol);
    const claims = owners.filter((o) => o.run).map((o) => ({ from: o.run.from, to: o.run.to, id: o.key }));
    const accept = (m, cand, basis, extra = {}) => {
      const { it, first, last, r } = m; const { im, e } = it;
      const r2 = { ...r, ...extra, found: true, run: [cand.from, cand.to], n: cand.n, mid_t: cand.mid_t, box: cand.box, card: cand.card };
      e.overlaps_model_interval = cand.to >= first - shiftTol && cand.from <= last + shiftTol; e.match_basis = basis; e.model_time_shift_s = Math.round((cand.from - first) * 100) / 100;
      e.measured_first_s = cand.from; e.measured_last_s = cand.to; e.capture_t_s = cand.mid_t;
      e.note = `zdjęcie widoczne na ${cand.n} klatkach (krok 0,25 s); zmierzony przedział ${cand.from}–${cand.to} s (wskazówka modelu: ${im.first_visible}–${im.last_visible}${!e.overlaps_model_interval ? `; przesunięcie względem modelu ${e.model_time_shift_s >= 0 ? "+" : ""}${e.model_time_shift_s} s` : ""}); dopasowanie: ${basis}`;
      stage.push({ it, r: r2 }); claims.push({ from: cand.from, to: cand.to, id: `#${im.id}` });
      D(`  zdjęcie ${im.id}: wykryte ${cand.from}–${cand.to} s (faza A; ${basis})`);
    };
    const unresolved = [];
    for (const m of meas) {
      const o = owners.find((x) => x.key === `#${m.it.im.id}`);
      if (o && o.run) accept(m, o.run, o.lostTo.length ? `okno wokół wskazówki modelu; pierwszy ciąg należał do ${o.lostTo.join(", ")}, wzięto następny` : "okno wokół wskazówki modelu");
      else { m.lostTo = o ? o.lostTo : []; unresolved.push(m); }
    }
    // --- Okno rozszerzone dla brakujących: czas modelu mógł się mylić o kilka sekund. Ciąg przyjmujemy tylko, gdy jest JEDYNY i nie należy do innego zdjęcia (bez zgadywania).
    for (const m of unresolved) {
      const { it, first, last, r } = m; const { im, e } = it;
      try {
        want = Math.max(0, first - 6);
        const rx = await run(([a, b, bf, af]) => window.__fr.refine(a, b, bf, af), [first, last, 6, 8]);
        const as = assignRun(rx.all_runs || [], claims);
        D(`  zdjęcie ${im.id}: okno rozszerzone ${rx.window.map((x) => x.toFixed(1)).join("–")} s: ciągi ${(rx.all_runs || []).map((x) => `${x.from}–${x.to}`).join(", ") || "brak"}; ocena: ${as.status}${as.by ? " (" + as.by.join(", ") + ")" : ""}`);
        if (as.status === "OK") { accept({ it, first, last, r: rx }, as.run, `okno rozszerzone ${rx.window.map((x) => x.toFixed(1)).join("–")} s: jedyny ciąg nieprzypisany do innego zdjęcia; tożsamość wg opisu modelu niezweryfikowana`); continue; }
        const skipped = (as.skipped || []).map((x) => `${x.run.from}–${x.run.to} → ${x.by}`).join("; ");
        if (as.status === "NIEJEDNOZNACZNE") { e.status = "NIEJEDNOZNACZNE"; e.note = `NIEJEDNOZNACZNE: w oknie ${rx.window.map((x) => x.toFixed(1)).join("–")} s jest ${as.runs.length} nieprzypisanych ciągów zdjęć (${as.runs.map((x) => `${x.from}–${x.to}`).join(", ")}) — nie zgaduję, które to zdjęcie ${im.id}`; }
        else if (as.status === "PRZYPISANE_DO_INNEGO" || m.lostTo.length) { e.status = "PRZYPISANE_DO_INNEGO"; e.note = `NIE ZNALEZIONO własnego ciągu: jedyne wykryte zdjęcia w oknie ${rx.window.map((x) => x.toFixed(1)).join("–")} s należą do innych zdjęć (${skipped || m.lostTo.join(", ")}) — nie przypisuję cudzego zdjęcia`; }
        else { e.status = "NIE_ZNALEZIONO"; e.note = `zdjęcia NIE znaleziono w oknie ${rx.window.map((x) => x.toFixed(1)).join("–")} s (sprawdzono ${rx.checked} klatek; przyczyny odrzuceń klatek: ${Object.entries(rx.diag || {}).map(([k, v]) => `${k} ×${v}`).join(", ") || "brak danych"})`; }
        e.context_v = 2; e.context_complete = false; e.confirmed = false; D(`  zdjęcie ${im.id}: ${e.status}: ${e.note}`);
        // klatka diagnostyczna z chwili wskazanej przez model (do oceny wzrokowej; NIE jest to screen rozmowy ze zdjęciem)
        if (!player.exhausted) { try { const tm = Math.round((first + Math.min(1.5, ((last ?? first) - first) / 2)) * 100) / 100; const dg = await run((t) => window.__fr.diag(t), tm); const rel = `frames/${rec.video_id}/zdjecie${im.id}${e.file_suffix}_diagnostyka_brak.jpg`; fs.writeFileSync(path.join(outDir, rel), Buffer.from(dg.jpeg, "base64")); e.missing_diag = { file: rel, t_s: dg.t_actual, finding: dg.why }; D(`  zdjęcie ${im.id}: klatka diagnostyczna z chwili wskazanej przez model → ${rel}`); } catch (e3) { D(`  zdjęcie ${im.id}: nie zapisano klatki diagnostycznej: ${String(e3.message).split("\n")[0]}`); } }
      } catch (err) { const mm = String(err.message); e.note = "błąd fazy A (okno rozszerzone): " + mm.split("\n")[0] + (closedWhy ? ` [przyczyna: ${closedWhy}]` : ""); e.status = failStatus(mm, "BLAD_FAZY_A"); e.closed = !!closedWhy; D(`  zdjęcie ${im.id}: ${e.note}`); if (closedWhy) return entries; }
    }
    TT.A = Date.now();
    if (!stage.length) { logPlayer(); return entries; }
    wantQuality = true;
    let q;
    try { q = await run(async (t) => window.__fr.setQuality(t), QUALITY); D(`  jakość: ${JSON.stringify(q)}`); } catch (err) { q = { error: String(err.message).split("\n")[0], after: null }; D("  jakość: błąd " + q.error); }
    TT.Q = Date.now();
    const srcH = q.after ? Math.max(q.after.w, q.after.h) : 0;
    const limited = !q.after || Math.min(q.after.w, q.after.h) < 1080;
    const keepOld = (rel) => { const f = path.join(outDir, rel); if (fs.existsSync(f)) fs.renameSync(f, f.replace(/\.(png|jpg)$/, `.stary-${Date.now()}.$1`)); };
    for (const { it, r } of stage) {
      const { im, e } = it; const tPh = Date.now(); e.timing_s = {};
      try {
        want = Math.max(0, r.mid_t - 1);
        e.crop_before_quality = { t_s: r.mid_t, source: null, photo_box_px: r.box, card_box_px: r.card || null, aspect: r.box ? Math.round(r.box[2] / r.box[3] * 100) / 100 : null, photo_card_ratio: r.box && r.card ? Math.round(r.box[2] * r.box[3] / (r.card[2] * r.card[3]) * 100) / 100 : null };
        // ===== 1) KONTEKST NAJPIERW (priorytet): zdjęcie + wiadomości z dialogu; NIE zależy od powodzenia ciasnego wycinka =====
        const needMsgs = neededMessages(im, rec.transcript_timed || []);
        const tNeed = needMsgs.length ? Math.max(...needMsgs.map((m) => m.t)) : null, tReady = tNeed == null ? null : tNeed + 0.7;
        e.messages_needed = needMsgs; e.t_need_s = tNeed; e.t_ready_s = tReady;
        // KROK 1 (najtańszy): sprawdź od razu moment PO ostatniej potrzebnej wiadomości (tReady) i kilka chwil wcześniej — jeśli zdjęcie jest wtedy jeszcze widoczne w tym samym rozmiarze,
        // jedna klatka pokazuje zdjęcie ze wszystkimi wiadomościami. Pokrywa też przedział między zdjęciem a reakcją, który wcześniej bywał pomijany (błąd cN_DmOQ6PT4#1).
        let direct = null; const probeLog = []; const kk = r.k || 3;
        if (tReady != null) {
          const dur = r.duration ? r.duration - 0.1 : 1e9;
          for (const d of [0, 0.3, -0.3, -0.6]) { // nie wcześniej niż chwilę po OSTATNIEJ potrzebnej wiadomości (tNeed); klatka sprzed niej nie pokazuje pełnego dialogu (błąd E2Byb#1: 2 z 3 wiadomości)
            const tt = Math.round((tReady + d) * 100) / 100; if (tt < r.run[0] || tt > dur || tt < tNeed + 0.05) continue;
            const s2 = await run(([t, np]) => window.__fr.shotAt(t, np), [tt, true]);
            const sizeOk = !!(s2.ok && s2.photo_visible && r.box && s2.photo_box && Math.abs(s2.photo_box[2] - r.box[2]) <= 14 * kk && Math.abs(s2.photo_box[3] - r.box[3]) <= 14 * kk);
            probeLog.push({ t: tt, card: !!s2.ok, photo_visible: s2.ok ? s2.photo_visible : null, size_ok: sizeOk, why: s2.ok ? null : s2.why });
            D(`  zdjęcie ${im.id}: sondowanie po ostatniej wiadomości t=${tt}: karta=${s2.ok ? "tak" : "NIE"} zdjęcie=${s2.ok ? s2.photo_visible : "-"} rozmiar zdjęcia zgodny=${sizeOk}`);
            if (sizeOk) { direct = { t: tt }; break; }
          }
        }
        e.context_probe = probeLog; e.selection = "automatyczny";
        let rows = r.rows || []; const maxRowT = rows.length ? Math.max(...rows.map((x) => x.t)) : r.run[1]; let scanned = 0, tailScan = null, pick;
        if (direct) {
          pick = { shots: [{ t: direct.t, role: "zdjecie_i_reakcja", needPhoto: true, exact: true, reason: `sondowanie od chwili po ostatniej potrzebnej wiadomości (${tReady.toFixed(2)} s): zdjęcie nadal widoczne w tym samym rozmiarze, więc jedna klatka zawiera zdjęcie i wszystkie potrzebne wiadomości` }], run: r.run, why: "ok" };
        } else {
          // KROK 2 (gdy zdjęcie zniknęło przed tReady): wcześniejsza logika — ostatnia pełna klatka ze zdjęciem + osobna klatka reakcji; skan tylko brakującego ogona
          if (tReady != null && tReady > maxRowT + 0.01) {
            const a1 = Math.max(0, maxRowT), b1 = Math.min(tReady + 0.8, a1 + 5);
            D(`  zdjęcie ${im.id}: ogon skanu ${a1.toFixed(1)}–${b1.toFixed(1)} s (wiadomości potrzebne do ${tReady.toFixed(2)} s; okno fazy A kończyło się ${maxRowT.toFixed(1)} s)`);
            const sc = await run(([x, y]) => window.__fr.contextScan(x, y), [a1, b1]); rows = rows.concat(sc.rows); scanned = sc.rows.length; tailScan = sc.window;
          }
          pick = chooseShots({ rows, midT: r.mid_t, k: kk, tReady, maxT: (r.duration ? r.duration - 0.1 : 1e9) });
        }
        e.context_plan = pick.shots; e.photo_visible_run_s = pick.run; e.context_scan = { reused_frames: (r.rows || []).length, tail_window: tailScan, tail_samples: scanned };
        D(`  zdjęcie ${im.id}: kontekst — wiadomości potrzebne (${needMsgs.length}) do ${tReady == null ? "brak" : tReady.toFixed(2)} s; plan: ${pick.shots.map((x) => `${x.role}@${x.t}`).join(", ") || "BRAK"}`);
        e.context_shots = []; let allOk = pick.shots.length > 0, n = 0;
        if (!pick.shots.length) { // brak kandydatów lub niespójne czasy: jawny status zamiast awarii; bez ciasnego wycinka (nie wiadomo, czy to właściwe zdjęcie)
          e.context_error = pick.why; e.failure_code = pick.code; e.context_v = 2; e.context_complete = false; e.context_confirmed = false; e.confirmed = false; e.crop_confirmed = false; e.crop_status = `NIE_PROBOWANO (${pick.code})`;
          e.status = pick.code === "NIESPOJNE_CZASY" ? "NIESPOJNE_CZASY" : "KONTEKST_NIEKOMPLETNY"; e.timing_s.kontekst = Math.round((Date.now() - tPh) / 100) / 10;
          e.note += `; KONTEKST NIEKOMPLETNY: ${pick.why}`; D(`  zdjęcie ${im.id}: STATUS ${e.status}: ${pick.why}`); continue;
        }
        D(`  zdjęcie ${im.id}: kontekst — wiadomości potrzebne (${needMsgs.length}) do ${tReady == null ? "brak" : tReady.toFixed(2)} s; plan: ${pick.shots.map((x) => `${x.role}@${x.t}`).join(", ") || "BRAK"}; ponownie użyto ${(r.rows || []).length} klatek z fazy A`);
        for (const sh of pick.shots) {
          let got = null, why2 = null;
          for (const off of (sh.exact ? [0] : sh.needPhoto ? [0, -0.25, -0.5, -0.75] : [0, 0.25, 0.5, -0.25])) {
            const tt = Math.max(0, Math.round((sh.t + off) * 100) / 100);
            const s2 = await run(([t, np]) => window.__fr.shotAt(t, np), [tt, sh.needPhoto]);
            if (s2.ok) { got = s2; break; } why2 = `t=${tt}: ${s2.why}`; D(`  zdjęcie ${im.id}: screen kontekstu odrzucony ${why2}`);
          }
          if (!got) { allOk = false; e.context_shots.push({ role: sh.role, t_planned_s: sh.t, file: null, error: why2, reason: sh.reason }); continue; }
          n++;
          const rel = `frames/${rec.video_id}/zdjecie${im.id}${e.file_suffix}_kontekst${n}_${sh.role}.png`; keepOld(rel);
          fs.writeFileSync(path.join(outDir, rel), Buffer.from(got.img.data, "base64"));
          e.context_shots.push({ order: n, role: sh.role, file: rel, t_s: Math.round(got.t_actual * 100) / 100, t_planned_s: sh.t, resolution: `${got.img.w}x${got.img.h}`, source_resolution: `${got.img.source_w}x${got.img.source_h}`, photo_visible: got.photo_visible, card_box_px: got.card, reason: sh.reason });
          D(`  zdjęcie ${im.id}: screen ${n} (${sh.role}) t=${got.t_actual.toFixed(2)} s ${got.img.w}x${got.img.h} zdjęcie widoczne=${got.photo_visible}`);
        }
        // kadr „przed”: wiadomości sprzed zdjęcia (messages_before). Po pojawieniu się zdjęcia karta rozmowy bywa już bez nich (karta ma stały rozmiar w wideo), więc osobna klatka tuż przed zdjęciem.
        // Jego niepowodzenie nie unieważnia kadrów ze zdjęciem: ustawia tylko before_complete=false (kategoria „częściowy”); nie przerywa pracy nad zdjęciem.
        {
          const beforeMsgs = neededBefore(im, rec.transcript_timed || []); e.messages_before_needed = beforeMsgs;
          const bp = chooseBeforeShot({ firstVisible: sec(im.first_visible), p0: (pick.run || r.run)[0], before: beforeMsgs });
          e.before_shot_plan = bp.shot ? { t: bp.shot.t, tight: !!bp.tight } : { code: bp.code, why: bp.why }; e.before_complete = true;
          if (bp.shot) {
            let gotB = null, whyB = null, usedT = null;
            // Czas z wizji i wiadomości „przed” (nie z początku zmierzonego ciągu). Ścisły detektor zdjęcia odrzuca klatki, na których zdjęcie już jest; wtedy próbujemy wcześniejszych czasów (alts).
            // Każde wywołanie to jedna próba: bez przeładowań i bez zużywania budżetu ponowień rolki (dodatkowy kadr nie może pogorszyć reszty rolki).
            const once = (fn, arg) => withTimeout(page.evaluate(fn, arg), Math.min(callMaxS * 1000, Math.max(1000, left())), "kadr przed");
            try {
              if (player.exhausted) throw new Error(`pominięty (${player.exhausted})`);
              guard();
              if (!(await once(() => !!window.__fr))) throw new Error("brak biblioteki na stronie");
              const refW = e.context_shots.find((x) => x.card_box_px)?.card_box_px?.[2] ?? null; const tried = [];
              for (const tt of [bp.shot.t, ...bp.alts]) {
                const s2 = await once(([t, np]) => window.__fr.shotAt(t, np), [tt, false]);
                const wOk = !refW || !s2.card || Math.abs(s2.card[2] - refW) <= 0.08 * refW; // karta o innej szerokości niż na kadrze głównym = animacja wjazdu zdjęcia
                tried.push({ t: tt, ok: !!s2.ok, photo_visible: !!s2.photo_visible, card_w_ok: wOk, why: s2.ok ? null : s2.why });
                if (s2.ok && !s2.photo_visible && wOk) { gotB = s2; usedT = tt; break; }
                whyB = !s2.ok ? `t=${tt}: ${s2.why}` : s2.photo_visible ? `t=${tt}: zdjęcie już widoczne` : `t=${tt}: karta o innej szerokości (animacja?)`;
              }
              e.before_tried = tried;
            } catch (eb) { whyB = String(eb.message).split("\n")[0]; }
            if (gotB) {
              n++; const relB = `frames/${rec.video_id}/zdjecie${im.id}${e.file_suffix}_kontekst${n}_przed.png`; keepOld(relB);
              fs.writeFileSync(path.join(outDir, relB), Buffer.from(gotB.img.data, "base64"));
              e.context_shots.push({ order: n, role: "przed", file: relB, t_s: Math.round(gotB.t_actual * 100) / 100, t_planned_s: usedT, resolution: `${gotB.img.w}x${gotB.img.h}`, source_resolution: `${gotB.img.source_w}x${gotB.img.source_h}`, photo_visible: gotB.photo_visible, card_box_px: gotB.card, reason: `${bp.shot.reason}${usedT !== bp.shot.t ? "; wcześniejszy czas (na pierwszym zdjęcie było już widoczne)" : ""}` });
              // klatka zrobiona PRZED czasem ostatniej potrzebnej wiadomości nie może jej pokazywać: kadr zapisany, ale oznaczony jako niepełny (kategoria „częściowy”)
              const lastNeeded = Math.max(...beforeMsgs.map((m) => m.t));
              if (gotB.t_actual < lastNeeded - 0.05) { e.before_complete = false; e.before_early = { t_shot_s: Math.round(gotB.t_actual * 100) / 100, last_message_s: lastNeeded }; }
              D(`  zdjęcie ${im.id}: kadr „przed” (${n}) t=${gotB.t_actual.toFixed(2)} s; wiadomości przed: ${beforeMsgs.length}${bp.tight ? " (ostatnia tuż przed zdjęciem)" : ""}${e.before_early ? " — klatka sprzed ostatniej wiadomości (" + lastNeeded.toFixed(2) + " s): kadr niepełny" : ""}`);
            } else {
              e.before_complete = false; e.context_shots.push({ role: "przed", t_planned_s: bp.shot.t, file: null, error: whyB, reason: bp.shot.reason });
              D(`  zdjęcie ${im.id}: kadr „przed” NIE zapisany: ${whyB}`);
            }
          } else D(`  zdjęcie ${im.id}: kadr „przed” pominięty (${bp.code}: ${bp.why})`);
          e.note += `; kadr przed: ${bp.shot ? (e.before_complete ? "zapisany" : e.before_early ? "zapisany, ale sprzed ostatniej wiadomości (niepełny)" : "NIE zapisany") : bp.code}`;
        }
        if (allOk && pick.shots[0].needPhoto && !e.context_shots.some((x) => x.file && x.photo_visible)) { allOk = false; e.context_error = "żaden screen kontekstu nie pokazuje zdjęcia"; }
        e.context_v = 2; e.context_complete = allOk; e.context_confirmed = allOk; e.conversation_file = e.context_shots.find((x) => x.file)?.file ?? null;
        e.timing_s.kontekst = Math.round((Date.now() - tPh) / 100) / 10;
        // ===== 2) CIASNY WYCINEK (osobno): jego niepowodzenie oznacza TYLKO wycinek jako niepotwierdzony, kontekst zostaje =====
        const tCrop = Date.now(); const attempts = []; let done = false;
        const offs = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75];
        for (const off of offs) {
          const t = Math.max(0, r.mid_t + off);
          const cp = await run((t) => window.__fr.capture(t, false), t);
          if (!cp.ok) { attempts.push({ t, why: cp.why, geom: cp.geom || null }); D(`  zdjęcie ${im.id}: wycinek odrzucony t=${t}: ${cp.why}${cp.geom ? ` | karta ${JSON.stringify(cp.geom.card)} wycinek ${JSON.stringify(cp.geom.photo)} proporcje ${cp.geom.aspect} udział ${cp.geom.photo_card_ratio} źródło ${cp.geom.src.join("x")}` : ""}`); continue; }
          const base = `frames/${rec.video_id}/zdjecie${im.id}${e.file_suffix}`;
          e.photo_file = `${base}_wycinek.png`; keepOld(e.photo_file); keepOld(`${base}_rozmowa.png`);
          fs.writeFileSync(path.join(outDir, e.photo_file), Buffer.from(cp.crop.data, "base64"));
          e.capture_t_s = t; e.photo_box_px = cp.crop.box; e.source_resolution = `${cp.full.source_w}x${cp.full.source_h}`; e.photo_resolution = `${cp.crop.w}x${cp.crop.h}`;
          e.verified = true; e.verified_video = { expected_id: rec.video_id, ...cp.video, t_actual: cp.t_actual, crop_dark_fraction: cp.dark_fraction, same_instant: true };
          e.native_png = true; e.crop_confirmed = true; e.crop_status = "POTWIERDZONY"; e.crop_after_quality = { t_s: t, source: e.source_resolution, ...cp.geom }; e.quality_limited = limited;
          e.quality_note = limited ? `OGRANICZENIE JAKOŚCI: źródło tylko ${cp.full.source_w}x${cp.full.source_h} (cel: 1080 po krótszym boku); obraz NIE jest ulepszony — to natywne klatki dostępnego strumienia` : `źródło ${cp.full.source_w}x${cp.full.source_h}, zapis natywny PNG, bez skalowania i bez poprawiania`;
          D(`  zdjęcie ${im.id}: wycinek OK ${e.source_resolution} → ${e.photo_resolution} t=${t}s`);
          done = true; break;
        }
        if (!done) {
          e.crop_confirmed = false; e.crop_status = "NIEPOTWIERDZONY"; e.crop_attempts = attempts; e.photo_file = null;
          try {
            const dg = await run((t) => window.__fr.diag(t), r.mid_t);
            const rel = `frames/${rec.video_id}/zdjecie${im.id}${e.file_suffix}_diagnostyka_wycinka.jpg`; keepOld(rel); fs.writeFileSync(path.join(outDir, rel), Buffer.from(dg.jpeg, "base64"));
            e.crop_diag = { file: rel, t_s: dg.t_actual, proposed: dg.geom, finding: dg.why };
            D(`  zdjęcie ${im.id}: DIAGNOSTYKA wycinka → ${rel}; proponowane granice: karta ${JSON.stringify(dg.geom.card)} wycinek ${JSON.stringify(dg.geom.photo)}, proporcje ${dg.geom.aspect}, udział ${dg.geom.photo_card_ratio}; przed zmianą jakości: ${JSON.stringify(e.crop_before_quality.photo_box_px)} (${e.crop_before_quality.photo_card_ratio}); rozdzielczość ${q.before ? q.before.w + "x" + q.before.h : "?"} → ${q.after ? q.after.w + "x" + q.after.h : "?"}`);
          } catch (e3) { D(`  zdjęcie ${im.id}: nie zapisano klatki diagnostycznej: ${String(e3.message).split("\n")[0]}`); }
        }
        e.timing_s.wycinek = Math.round((Date.now() - tCrop) / 100) / 10;
        e.quality_change = { before: q.before || null, after: q.after || null };
        e.confirmed = !!e.context_complete; // „użyteczne do paczki” = kompletny kontekst; wycinek ma osobny status (crop_confirmed)
        e.status = !e.context_complete ? "KONTEKST_NIEKOMPLETNY" : e.crop_confirmed ? "KOMPLET" : "KOMPLET_KONTEKST_WYCINEK_NIEPOTWIERDZONY";
        e.note += `; kontekst: ${e.context_complete ? e.context_shots.map((x) => `${x.role}@${x.t_s}s`).join(", ") : "NIEKOMPLETNY: " + (e.context_error || e.context_shots.filter((x) => !x.file).map((x) => `${x.role}: ${x.error}`).join("; "))}; wycinek: ${e.crop_status}`;
        D(`  zdjęcie ${im.id}: STATUS ${e.status} (czas: kontekst ${e.timing_s.kontekst} s, wycinek ${e.timing_s.wycinek} s)`);
      } catch (err) { const mm = String(err.message); e.note += "; błąd fazy B: " + mm.split("\n")[0] + (closedWhy ? ` [przyczyna: ${closedWhy}]` : ""); e.status = failStatus(mm, "BLAD_FAZY_B"); e.context_v = 2; e.context_complete = false; e.confirmed = false; e.closed = !!closedWhy; D(`  zdjęcie ${im.id}: ${e.note}`); if (closedWhy) break; }
    }
    TT.B = Date.now(); logPlayer(); const sx = (a, b) => Math.round((b - a) / 100) / 10;
    D(`  CZAS rolki ${rec.video_id}: otwarcie+bramka ${sx(TT.start, TT.open)} s; faza A (wykrycie zdjęć) ${sx(TT.open, TT.A)} s; zmiana jakości ${sx(TT.A, TT.Q)} s; faza B (kontekst+wycinki) ${sx(TT.Q, TT.B)} s`);
  } catch (err) { D(`  błąd uruchomienia ${ch}: ${String(err.message).split("\n")[0]}`); entries.push({ video_id: rec.video_id, image_id: null, channel: ch, confirmed: false, note: "błąd uruchomienia: " + String(err.message).split("\n")[0], closed: true }); }
  finally { /* przeglądarka i profil zostają otwarte dla kolejnej rolki */ }
  return entries;
}

const prevPath = path.join(outDir, "frames_manifest.json");
const prev = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, "utf8")) : [];
const exists = (f) => !!f && fs.existsSync(path.join(outDir, f));
// Pominięcie przy ponownym biegu: tylko wyniki co najmniej „pełny wg programu” z istniejącymi plikami (częściowe próbujemy ponownie — bez ryzyka pogorszenia, patrz mergeBest).
const isDone = (e) => e && !redo.has(`${e.video_id}#${e.image_id}`) && e.context_v === 2 && ctxScore(e, exists) >= CTX.PELNY_NIEZWERYFIKOWANY && (e.context_shots || []).every((x) => !x.file || exists(x.file)) && (!e.crop_confirmed || exists(e.photo_file));
let consecutiveBlocked = 0, humanRequired = 0, stoppedWhy = null, runTimedOut = false;
const manifest = [];
const t0 = runStart;
// --- zapis manifestu: zawsze z zachowaniem najlepszych wyników; wpisy nieprzetworzone (limit/blokada) nie nadpisują poprzednich
const finalize = (reason) => {
  const out = [...manifest];
  for (const pe of prev) if (!out.some((m) => m.video_id === pe.video_id && m.image_id === pe.image_id)) out.push(pe);
  for (const r of records) for (const im of r.vision.images) if (!out.some((m) => m.video_id === r.video_id && m.image_id === im.id)) out.push({ video_id: r.video_id, image_id: im.id, confirmed: false, context_v: 2, context_complete: false, status: "NIEUKONCZONA_LIMIT_CALOSCI", note: `nieprzetworzone: ${reason}` });
  fs.writeFileSync(path.join(outDir, "frames_manifest.json"), JSON.stringify(out, null, 1));
  return out;
};
// --- twardy limit całej próby: po upływie zamykamy przeglądarkę; jeśli program mimo to nie skończy w 60 s, zapisujemy manifest i kończymy proces
setTimeout(async () => {
  runTimedOut = true; closedWhy = `LIMIT CZASU CAŁEJ PRÓBY (${maxTotalS} s)`; D(`${closedWhy}: kończę — zamykam przeglądarkę, zapisuję wyniki`);
  try { await session?.ctx.close(); } catch {}
  setTimeout(() => { try { finalize(closedWhy); D("WYMUSZONE ZAKOŃCZENIE po limicie całej próby (manifest zapisany)"); } catch (e) { D("błąd zapisu przy wymuszonym końcu: " + e.message); } process.exit(4); }, 20000).unref();
}, maxTotalS * 1000).unref();
for (const rec0 of records) {
  if (runTimedOut) { D(`${rec0.video_id}: pominięta — limit całej próby`); continue; }
  if (process.env.ZRZUTY_TEST_HANG && rec0 !== records[0]) await new Promise(() => {}); // tylko test: symulacja zawieszenia poza przeglądarką
  const kept = rec0.vision.images.map((im) => prev.find((e) => e.video_id === rec0.video_id && e.image_id === im.id)).filter(isDone);
  if (kept.length) D(`${rec0.video_id}: zachowuję wyniki z poprzedniego biegu: ${kept.map((e) => e.image_id).join(", ")}`);
  const todo = rec0.vision.images.filter((im) => !kept.some((e) => e.image_id === im.id));
  manifest.push(...kept); keptNow = kept;
  if (!todo.length) { D(`${rec0.video_id}: wszystko gotowe, pomijam`); continue; }
  const rec = { ...rec0, vision: { ...rec0.vision, images: todo } };
  let final = null;
  if (stoppedWhy) { final = rec.vision.images.map((im) => ({ video_id: rec.video_id, image_id: im.id, confirmed: false, status: "POMINIETE_PO_BLOKADZIE", note: `pominięte: wcześniejsza blokada wymagająca człowieka (${stoppedWhy})` })); manifest.push(...final.map((e) => mergeBest(prev.find((x) => x.video_id === e.video_id && x.image_id === e.image_id), e, exists))); continue; }
  const tReel = Date.now();
  for (const ch of localDir ? [channel, channel] : [channel, ...order]) { // po awarii najpierw odtworzenie sesji z TEGO SAMEGO profilu, dopiero potem inna przeglądarka
    if (runTimedOut) break;
    reelTimedOut = false;
    const limS = Math.max(5, Math.min(reelMaxS, (runEnd - Date.now()) / 1000 - 20));
    const wd = setTimeout(async () => { reelTimedOut = true; closedWhy = limS < reelMaxS ? `LIMIT CZASU całej próby (${maxTotalS} s; dla tej rolki zostało ${Math.round(limS)} s)` : `LIMIT CZASU ROLKI (${reelMaxS} s) — zawieszenie lub zbyt wolne przewijanie`; D(`  ${closedWhy}: zamykam przeglądarkę i przechodzę do następnej rolki`); try { await session?.ctx.close(); } catch {} }, limS * 1000);
    let ents; try { ents = await processReel(rec, ch); } finally { clearTimeout(wd); }
    final = ents;
    const anyOk = ents.some((e) => e.confirmed);
    const closed = ents.some((e) => e.closed);
    if (blockedWhy) {
      humanRequired++; consecutiveBlocked++; stats.human_required.push({ video_id: rec.video_id, status: blockedWhy });
      for (const e of final) { e.status = "WYMAGA_CZLOWIEKA"; e.human_required = blockedWhy; e.note = `WYMAGA CZŁOWIEKA: ${blockedWhy}. ` + (e.note || ""); }
      if (consecutiveBlocked >= 2) stoppedWhy = blockedWhy;
      break;
    }
    if (reelTimedOut || runTimedOut) { stats.reel_timeouts = (stats.reel_timeouts || 0) + 1; for (const e of final) if (!e.context_complete) { e.status = runTimedOut ? "NIEUKONCZONA_LIMIT_CALOSCI" : failStatus(closedWhy || "LIMIT CZASU", "NIEUKONCZONA_LIMIT_CZASU"); e.note = `NIEUKOŃCZONA: ${closedWhy}. ` + (e.note || ""); } break; }
    consecutiveBlocked = 0;
    if (anyOk || !closed) break;
    D(`${rec.video_id}: przeglądarka ${ch} zamknęła się — próbuję następnej z listy (ta sama logika, osobny profil programu)`);
  }
  { const sT = Math.round((Date.now() - tReel) / 1000); (stats.reel_times ||= {})[rec.video_id] = sT; D(`${rec.video_id}: czas rolki ${sT} s`); }
  final = final || [];
  for (const im of rec.vision.images) if (!final.some((e) => e.image_id === im.id)) final.push({ video_id: rec.video_id, image_id: im.id, confirmed: false, context_v: 2, context_complete: false, status: runTimedOut ? "NIEUKONCZONA_LIMIT_CALOSCI" : "NIEPRZETWORZONE", note: "nieprzetworzone (przeglądarka zamknięta lub limit czasu)" });
  // najlepszy zapisany wynik ≠ ostatnia próba: gorsza próba NIE zastępuje lepszego wyniku (zostaje w last_attempt)
  for (const e of final.filter((x) => x.image_id != null)) {
    const p0 = prev.find((x) => x.video_id === e.video_id && x.image_id === e.image_id);
    const m = mergeBest(p0, e, exists);
    if (p0 && m.last_attempt && !m.last_attempt.adopted) D(`${e.video_id}#${e.image_id}: ostatnia próba (${m.last_attempt.category}) NIE zastępuje zapisanego wyniku (${contextCategory(p0, exists)})`);
    manifest.push(m);
  }
  if (!runTimedOut) await new Promise((r) => setTimeout(r, pauseS * 1000));
}
if (server) server.close();
try { session?.stopWatch?.(); await session?.ctx.close(); } catch {}
const all = finalize(runTimedOut ? `limit całej próby ${maxTotalS} s` : "nie przetworzono");
const md5Of = (f) => { try { return crypto.createHash("md5").update(fs.readFileSync(path.join(outDir, f))).digest("hex"); } catch { return null; } };
const cat = (c) => all.filter((m) => contextCategory(m, exists, md5Of) === c).length;
const nPV = cat("PELNY_ZWERYFIKOWANY"), nPN = cat("PELNY_NIEZWERYFIKOWANY"), nCV = cat("CZESCIOWY_ZWERYFIKOWANY"), nCN = cat("CZESCIOWY_NIEZWERYFIKOWANY"), nB = cat("BRAK");
const cropOk = all.filter((m) => ctxScore(m, exists) >= CTX.PELNY_NIEZWERYFIKOWANY && m.crop_confirmed && exists(m.photo_file)).length;
const retries = (fs.readFileSync(diagFile, "utf8").match(/ponawiam|przeładowuję/g) || []).length;
const summary = { czas_s: Math.round((Date.now() - t0) / 1000), limit_calosci_s: maxTotalS, przerwano_limitem_calosci: runTimedOut, rolek: records.length, zdjec: all.length,
  kontekst_pelny_zweryfikowany: nPV, kontekst_pelny_niezweryfikowany: nPN, kontekst_czesciowy_zweryfikowany: nCV, kontekst_czesciowy_niezweryfikowany: nCN, brak_screena_ze_zdjeciem: nB, wycinek_potwierdzony: cropOk,
  uwaga: "program nie sprawdza treści kadrów; „pełny niezweryfikowany” wymaga kontroli wzrokowej (audyt.mjs)",
  interwencje_uzytkownika: humanRequired, ekrany_zgody_napotkane: stats.consent_screens, zgoda_odrzucona_automatycznie: stats.consent_rejected, uruchomienia_przegladarki: stats.session_launches, odtworzenia_sesji: stats.session_restores, ponowienia: retries, przegladarki: stats.browsers_used, blokady: stats.human_required, czasy_rolek_s: stats.reel_times || {}, rolki_przerwane_limitem_czasu: stats.reel_timeouts || 0, odtwarzacz_na_rolke: stats.player_by_reel || {} };
archiveOld(path.join(outDir, "przebieg.json"));
fs.writeFileSync(path.join(outDir, "przebieg.json"), JSON.stringify(summary, null, 1));
D(`PRZEBIEG: ${JSON.stringify(summary)}`);
D(`WYNIK: ${all.length} zdjęć | pełny zweryfikowany ${nPV} | pełny NIEZWERYFIKOWANY ${nPN} | częściowy zweryfikowany ${nCV} | częściowy niezweryfikowany ${nCN} | brak ${nB} | czas ${summary.czas_s} s (limit ${maxTotalS} s)${runTimedOut ? " | PRZERWANO LIMITEM CAŁEJ PRÓBY" : ""}. Folder: ${outDir}`);
process.exit(runTimedOut ? 4 : nB + nCV + nCN === 0 ? (nPN === 0 ? 0 : 3) : (nPV + nPN === 0 ? 1 : 2));
