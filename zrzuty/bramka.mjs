// Bramka zgody cookies i blokad (CAPTCHA/logowanie) — wydzielona, testowalna.
// YouTube pokazuje „Zanim przejdziesz do YouTube” albo jako osobną stronę (consent.youtube.com), albo jako NAKŁADKĘ na stronie filmu, która pojawia się
// z opóźnieniem — już po załadowaniu odtwarzacza. Dlatego: (1) przy pierwszej wizycie w profilu czekamy na nakładkę, (2) w tle działa stały strażnik zgody.
const NAME_RE = /^\s*(reject all|odrzuć wszystko|odrzuć wszystkie)\s*$/i;

/** Jeden przegląd: jeśli widać przycisk „Odrzuć wszystko”/„Reject all” (w dowolnej ramce, także w shadow DOM), klika go. Zwraca true po kliknięciu. */
export async function consentSweep(page, stats, D) {
  if (page.isClosed()) return false;
  for (const fr of page.frames()) {
    const cands = [
      fr.getByRole("button", { name: NAME_RE }),
      fr.locator('button[aria-label*="Reject all" i], button[aria-label*="Odrzuć wszystko" i], [aria-label*="Reject all" i][role=button], [aria-label*="Odrzuć wszystko" i][role=button]'),
      fr.getByText(NAME_RE),
    ];
    for (const loc of cands) {
      const b = loc.first();
      let vis = false;
      try { vis = (await b.count()) > 0 && (await b.isVisible()); } catch { vis = false; }
      if (!vis) continue;
      stats.consent_screens++;
      D("  ekran zgody: wybieram „Odrzuć wszystko”");
      try { await b.click({ timeout: 4000 }); stats.consent_rejected++; return true; }
      catch (e) { D("  klik zgody nie powiódł się: " + String(e.message).split("\n")[0]); try { await b.click({ timeout: 3000, force: true }); stats.consent_rejected++; return true; } catch {} }
    }
  }
  return false;
}

/** Strażnik w tle: co ~700 ms sprawdza, czy nie pojawiła się zgoda (nakładka może wyskoczyć w dowolnym momencie). Zwraca funkcję zatrzymującą. */
export function startConsentWatcher(page, stats, D) {
  let busy = false, stopped = false;
  const iv = setInterval(async () => {
    if (busy || stopped || page.isClosed()) return; busy = true;
    try { await consentSweep(page, stats, D); } catch {} finally { busy = false; }
  }, 700);
  return () => { stopped = true; clearInterval(iv); };
}

/**
 * Po nawigacji do filmu: obsługuje zgodę i czeka na właściwy odtwarzacz; wykrywa CAPTCHA/logowanie/film niedostępny.
 * opts.waitForOverlayMs: jak długo czekać po pojawieniu się odtwarzacza, czy nie wyskoczy nakładka zgody (gdy profil jeszcze nie ma zapisanego wyboru).
 */
export async function handleGate(page, stats, D, opts = {}) {
  const t0 = Date.now(); let consent = false, playerSince = null;
  const waitOverlay = opts.waitForOverlayMs ?? 0;
  while (Date.now() - t0 < 45000) {
    const url = page.url();
    if (/google\.[a-z.]+\/sorry|\/sorry\/index/.test(url)) return { consent, blocked: "CAPTCHA (strona google.com/sorry)" };
    if (await consentSweep(page, stats, D)) {
      consent = true; playerSince = null;
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      if (!/\/watch/.test(page.url())) await page.waitForURL(/youtube\.com\/watch/, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(800); // nakładka znika po kliknięciu; sprawdzimy ponownie w kolejnej iteracji
      continue;
    }
    if (/^https?:\/\/consent\.(youtube|google)\.com/.test(url)) { await page.waitForTimeout(500); continue; }
    const st = await page.evaluate(() => { const v = document.querySelector("video"); const p = document.getElementById("movie_player"); const e = document.querySelector(".ytp-error"); const errVis = !!(e && e.offsetParent); return { video: !!v, player: !!p, errVis, text: (!v || errVis) && document.body ? document.body.innerText.slice(0, 2500) : "" }; }).catch(() => null);
    if (st) {
      if (st.video && st.player && !st.errVis) {
        if (playerSince == null) playerSince = Date.now();
        if (consent || Date.now() - playerSince >= waitOverlay) return { consent, blocked: null };
        await page.waitForTimeout(400); continue; // czekamy, czy nakładka zgody jeszcze się pojawi
      }
      const tx = st.text || "";
      if (/unusual traffic|nietypowy ruch|nie jesteś robotem|not a robot|captcha/i.test(tx)) return { consent, blocked: "CAPTCHA/nietypowy ruch" };
      if (/confirm you.re not a bot|potwierdź, że nie jesteś botem|Sign in to confirm|Zaloguj się, aby potwierdzić/i.test(tx)) return { consent, blocked: "YouTube żąda logowania/potwierdzenia, że to nie bot" };
      if (/video unavailable|film jest niedostępny|ten film jest niedostępny|private video|prywatny film/i.test(tx)) return { consent, blocked: null, unavailable: "film niedostępny" };
    }
    await page.waitForTimeout(500);
  }
  return { consent, blocked: null, timeout: true };
}
