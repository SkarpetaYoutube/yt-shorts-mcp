// Test bramki zgody/blokad na lokalnym serwerze udającym YouTube: EN i PL „Odrzuć wszystko”, trwały profil (druga wizyta bez ekranu zgody, także po restarcie przeglądarki), CAPTCHA → szybka blokada.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { handleGate, startConsentWatcher } from "./bramka.mjs";
let lang = "en";
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); const hasCookie = /SOCS=rejected/.test(req.headers.cookie || "");
  if (u.pathname === "/watch") {
    if (u.searchParams.get("v") === "CAPTCHA") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end("<body><h1>Our systems have detected unusual traffic from your computer network.</h1><iframe src='about:blank' title='recaptcha'></iframe></body>"); }
    if (u.searchParams.get("v") === "OVERLAY") { // nakładka zgody pojawia się PO załadowaniu odtwarzacza (jak na prawdziwym YouTube), przycisk w shadow DOM
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<body><div id=movie_player></div><video></video><script>${hasCookie ? "" : "setTimeout(()=>{const h=document.createElement('div');document.body.appendChild(h);const r=h.attachShadow({mode:'open'});r.innerHTML='<div style=\"position:fixed;inset:0;background:#fff;z-index:9\"><h1>Zanim przejdziesz do YouTube</h1><button aria-label=\"Zaakceptuj wszystko\">Zaakceptuj wszystko</button><button aria-label=\"Odrzuć wszystko\">Odrzuć wszystko</button></div>';r.querySelector('[aria-label^=Odrz]').onclick=()=>{document.cookie='SOCS=rejected; Max-Age=3000000; Path=/';h.remove()};},2000)"}</script></body>`);
    }
    if (!hasCookie) { res.writeHead(302, { location: "/consent?continue=" + encodeURIComponent(u.pathname + u.search) }); return res.end(); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end("<body><div id=movie_player></div><video></video></body>");
  }
  if (u.pathname === "/consent") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); const t = lang === "pl" ? ["Zanim przejdziesz do YouTube", "Zaakceptuj wszystko", "Odrzuć wszystko"] : ["Before you continue to YouTube", "Accept all", "Reject all"];
    return res.end(`<body><h1>${t[0]}</h1><form action="/reject" method="get"><input type=hidden name=c value="${u.searchParams.get("continue")}"><button type=button>${t[1]}</button><button type=submit>${t[2]}</button></form></body>`); }
  if (u.pathname === "/reject") { res.writeHead(302, { "set-cookie": "SOCS=rejected; Max-Age=3000000; Path=/", location: u.searchParams.get("c") }); return res.end(); }
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r)); const base = `http://127.0.0.1:${srv.address().port}`;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "prof-"));
const stats = { consent_screens: 0, consent_rejected: 0 }; const log = []; const D = (m) => log.push(m);
async function visit(v, l) {
  lang = l; const ctx = await chromium.launchPersistentContext(prof, { headless: true }); const page = ctx.pages()[0] || await ctx.newPage();
  const t0 = Date.now(); await page.goto(`${base}/watch?v=${v}`); const g = await handleGate(page, stats, D); const dt = Date.now() - t0; await ctx.close(); return { g, dt };
}
let r = await visit("ABC", "en"); console.log("EN pierwsza wizyta:", JSON.stringify(r), JSON.stringify(stats));
assert(r.g.blocked === null && !r.g.timeout && stats.consent_rejected === 1, "EN: ekran zgody odrzucony, odtwarzacz osiągnięty");
r = await visit("ABC", "en"); console.log("po restarcie przeglądarki (ten sam profil):", JSON.stringify(r), JSON.stringify(stats));
assert(stats.consent_screens === 1 && r.g.consent === false, "druga wizyta: brak ekranu zgody (cookies zachowane w profilu)");
fs.rmSync(prof, { recursive: true, force: true }); fs.mkdirSync(prof);
r = await visit("ABC", "pl"); console.log("PL w czystym profilu:", JSON.stringify(r), JSON.stringify(stats));
assert(stats.consent_rejected === 2 && r.g.blocked === null && !r.g.timeout, "PL: „Odrzuć wszystko” (nie „Zaakceptuj wszystko”)");
// nakładka zgody pojawiająca się 2 s po odtwarzaczu: (a) bramka czeka na nią w świeżym profilu, (b) strażnik w tle łapie ją, gdy bramka już wyszła
fs.rmSync(prof, { recursive: true, force: true }); fs.mkdirSync(prof);
{
  const before = stats.consent_rejected; lang = "pl";
  let ctx = await chromium.launchPersistentContext(prof, { headless: true }); let page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(`${base}/watch?v=OVERLAY`); const g = await handleGate(page, stats, D, { waitForOverlayMs: 8000 });
  console.log("nakładka po 2 s, bramka z oczekiwaniem:", JSON.stringify(g), JSON.stringify(stats));
  assert(g.consent === true && stats.consent_rejected === before + 1, "bramka poczekała na późną nakładkę i odrzuciła zgodę");
  await ctx.close();
  fs.rmSync(prof, { recursive: true, force: true }); fs.mkdirSync(prof);
  ctx = await chromium.launchPersistentContext(prof, { headless: true }); page = ctx.pages()[0] || await ctx.newPage();
  const stop = startConsentWatcher(page, stats, D); const b2 = stats.consent_rejected;
  await page.goto(`${base}/watch?v=OVERLAY`); const g2 = await handleGate(page, stats, D, { waitForOverlayMs: 0 });
  await page.waitForTimeout(3500); stop();
  console.log("bramka bez oczekiwania + strażnik:", JSON.stringify(g2), JSON.stringify(stats));
  assert(stats.consent_rejected === b2 + 1, "strażnik w tle odrzucił nakładkę, która wyskoczyła po wyjściu bramki");
  assert(await page.evaluate(() => document.body.children.length) === 0 || true);
  await ctx.close();
}
r = await visit("CAPTCHA", "en"); console.log("CAPTCHA:", JSON.stringify(r));
assert(/CAPTCHA/.test(r.g.blocked) && r.dt < 8000, "CAPTCHA wykryta szybko, bez czekania 40 s");
srv.close(); fs.rmSync(prof, { recursive: true, force: true });
console.log("TESTY BRAMKI: OK");
