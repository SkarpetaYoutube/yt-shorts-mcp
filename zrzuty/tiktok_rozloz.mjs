// TikTok: układa eksport serwera (export_tiktok, JSON) w czytelne foldery lokalne: jedno konto = jeden folder, jeden film = jeden podfolder.
//   wyniki\TikTok - <konto>\<konto> - <opis> [<ID>]\  dane.md (karta filmu), dane.json, dane.csv, transkrypt.txt (czysty tekst), transkrypt_czasy.txt
//   wyniki\TikTok - <konto>\_zbiorczo\                 indeks_filmow.csv/md (jedna linia na film), do_analizy.md (wszystkie filmy w jednym pliku), eksport_serwera\ (pliki oryginalne)
//   wyniki\TikTok - <konto>\_baza\                     baza_filmow.json/csv (scala kolejne eksporty, historia statystyk w czasie)
// Dane pochodzą wyłącznie z eksportu (Supadata); nic nie jest oceniane ani zgadywane. Wskaźniki „stosunki” to zwykła arytmetyka z podanych liczb.
// Użycie: node tiktok_rozloz.mjs <eksport.json> <folder_wyniki> [--zrodlo folder_z_plikami_eksportu]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bezpiecznaNazwa, nazwaFolderuRolki } from "./rozloz_na_rolki.mjs";
import { csvTekst } from "./indeks_i_baza.mjs";

const txt = (v) => (v == null ? "" : String(v));
const liczba = (v) => (v == null ? "brak danych" : String(Math.round(Number(v))).replace(/\B(?=(\d{3})+(?!\d))/g, " ").replace(/ /g, " "));
const proc = (a, b) => (a == null || !b ? null : Math.round((a / b) * 10000) / 100);
const mediana = (xs) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

/** m:ss albo g:mm:ss. */
export function czas(sek) {
  if (sek == null || !Number.isFinite(sek)) return "?";
  const s = Math.round(sek), g = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return g ? `${g}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
const dataPl = (iso) => (iso ? iso.slice(0, 10) : "brak daty");
const pierwszeZdanie = (s, max = 70) => { const t = txt(s).replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") + "…" : t; };
/** Nazwa filmu do folderów i nagłówków: tytuł (jeśli jest), inaczej początek opisu. */
export const nazwaFilmu = (r) => pierwszeZdanie((r.title || r.description || "bez opisu").replace(/^\s*\[[^\]]{1,30}\]\s*/, "") || "bez opisu", 60);
const kontoDir = (r) => bezpiecznaNazwa(`TikTok - ${(r.channel_handle ?? "nieznane konto").replace(/^@/, "")}`, 60, "TikTok - nieznane konto");
const kontoNazwa = (r) => (r.channel_handle ?? "nieznane konto").replace(/^@/, "");

/** Karta Markdown jednego filmu: najpierw dane, na końcu transkrypt (od góry czytelna także dla modelu). */
export function kartaFilmu(r, folder) {
  const L = [`# ${nazwaFilmu(r)}`, ""];
  L.push("| | |", "|---|---|");
  L.push(`| Konto | ${txt(r.channel_title) || "brak danych"} (${txt(r.channel_handle) || "brak"})${r.channel_verified ? ", zweryfikowane" : ""} |`);
  L.push(`| Link | ${r.url} |`, `| ID filmu | \`${txt(r.video_id)}\` |`);
  L.push(`| Publikacja | ${dataPl(r.published_at)} |`, `| Długość | ${r.duration_seconds != null ? czas(r.duration_seconds) : "brak danych"} |`);
  L.push(`| Pomiar statystyk | ${txt(r.measured_at) || "brak danych"}${r.stats_status !== "ok" ? ` (status: ${r.stats_status}${r.stats_note ? `, ${r.stats_note}` : ""})` : ""} |`, "");
  L.push("## Statystyki", "", "| Wyświetlenia | Polubienia | Komentarze | Udostępnienia |", "|---:|---:|---:|---:|");
  L.push(`| ${liczba(r.views)} | ${liczba(r.likes)} | ${liczba(r.comments_count)} | ${liczba(r.shares)} |`, "");
  const st = [["polubienia", r.likes], ["komentarze", r.comments_count], ["udostępnienia", r.shares]].map(([n, v]) => [n, proc(v, r.views)]).filter(([, p]) => p != null);
  if (st.length) L.push(`Stosunki do wyświetleń (obliczone z powyższych liczb): ${st.map(([n, p]) => `${n} ${String(p).replace(".", ",")}%`).join(", ")}.`, "");
  if (r.author_views_rank_in_sample != null) L.push(`Pozycja w próbie (tylko filmy z tego eksportu, nie całe konto): miejsce ${r.author_views_rank_in_sample} z ${r.author_videos_in_sample} filmów tego konta, krotność mediany tych filmów ${txt(r.views_vs_author_median_in_sample) || "brak danych"}.`, "");
  if (r.tags?.length) L.push(`**Tagi:** ${r.tags.join(" ")}`, "");
  if (r.description) L.push("## Opis filmu", "", r.description, "");
  L.push("## Transkrypt", "");
  L.push(`Status: ${r.transcript_status}${r.transcript_lang ? `, język transkryptu: ${r.transcript_lang}` : ""}${r.transcript ? `, ${r.transcript.length.toLocaleString("pl-PL").replace(/ /g, " ")} znaków` : ""}. Czysty tekst: \`transkrypt.txt\`, ze znacznikami czasu: \`transkrypt_czasy.txt\`.`, "");
  if (r.transcript_timed?.length) L.push("```", ...r.transcript_timed.map((s) => `[${czas(s.start_s)}] ${s.text}`), "```");
  else if (r.transcript) L.push(r.transcript);
  else L.push(`(brak transkryptu${r.transcript_note ? `: ${r.transcript_note}` : ""})`);
  L.push("", `Folder filmu: \`${folder}\``, "");
  return L.join("\n");
}

export const INDEKS_TT = ["lp", "konto", "opis", "id", "link", "opublikowano", "dlugosc_s", "wyswietlenia", "polubienia", "komentarze", "udostepnienia", "polubienia_proc", "komentarze_proc", "udostepnienia_proc", "tagi", "transkrypt_status", "transkrypt_jezyk", "transkrypt_znakow", "transkrypt_segmentow", "statystyki_status", "pomiar", "folder"];
const wierszIndeksu = (r, lp, folder) => [
  lp, kontoNazwa(r), nazwaFilmu(r), r.video_id, r.url, r.published_at, r.duration_seconds, r.views, r.likes, r.comments_count, r.shares,
  proc(r.likes, r.views), proc(r.comments_count, r.views), proc(r.shares, r.views), (r.tags ?? []).join(" "),
  r.transcript_status, r.transcript_lang, r.transcript?.length ?? 0, r.transcript_timed?.length ?? 0, r.stats_status, r.measured_at, folder,
].map(txt);

function indeksMd(konto, rows, teraz) {
  const L = [`# Indeks filmów TikTok: @${konto}`, "", `Filmów: **${rows.length}**. Wygenerowano: ${teraz}. Pełne kolumny: \`indeks_filmow.csv\`. Posortowane od najnowszego.`, ""];
  const w = rows.map((x) => x.r.views).filter((v) => v != null);
  if (w.length) L.push(`Wyświetlenia: razem ${liczba(w.reduce((a, b) => a + b, 0))}, mediana ${liczba(mediana(w))}, najwięcej ${liczba(Math.max(...w))}, najmniej ${liczba(Math.min(...w))} (liczone tylko z filmów w tym indeksie).`, "");
  L.push("| lp | data | opis | wyśw. | polub. | kom. | udost. | długość | transkrypt | folder |", "|---:|---|---|---:|---:|---:|---:|---:|---|---|");
  rows.forEach(({ r, folder }, i) => L.push(`| ${i + 1} | ${dataPl(r.published_at)} | ${nazwaFilmu(r).replace(/\|/g, "/")} | ${liczba(r.views)} | ${liczba(r.likes)} | ${liczba(r.comments_count)} | ${liczba(r.shares)} | ${r.duration_seconds != null ? czas(r.duration_seconds) : "?"} | ${r.transcript_status}${r.transcript ? ` (${Math.round(r.transcript.length / 1000)} tys. zn.)` : ""} | \`${folder}\` |`));
  return L.join("\n") + "\n";
}

/** Jeden plik dla modelu: wszystkie filmy konta, każdy z nagłówkiem statystyk i czystym transkryptem. */
function doAnalizyMd(konto, rows, teraz) {
  const L = [`# TikTok @${konto}: dane do analizy`, "", `Filmów: ${rows.length}. Wygenerowano: ${teraz}. Źródło: Supadata (statystyki i transkrypty); lista filmów podana przez użytkownika. Statystyki z chwili pomiaru podanego przy filmie.`, ""];
  rows.forEach(({ r }, i) => {
    L.push("---", "", `## ${i + 1}. ${nazwaFilmu(r)}`, "");
    L.push(`- ID: \`${txt(r.video_id)}\` | link: ${r.url} | publikacja: ${dataPl(r.published_at)} | długość: ${r.duration_seconds != null ? czas(r.duration_seconds) : "?"}`);
    L.push(`- Wyświetlenia: ${liczba(r.views)} | polubienia: ${liczba(r.likes)} | komentarze: ${liczba(r.comments_count)} | udostępnienia: ${liczba(r.shares)}${r.tags?.length ? ` | tagi: ${r.tags.join(" ")}` : ""}`);
    if (r.description) L.push(`- Opis: ${r.description.replace(/\s*\n\s*/g, " ")}`);
    L.push(`- Transkrypt (${r.transcript_status}${r.transcript_lang ? `, ${r.transcript_lang}` : ""}):`, "", r.transcript ?? `(brak${r.transcript_note ? `: ${r.transcript_note}` : ""})`, "");
  });
  return L.join("\n");
}

function scalBazeTt(bazaDir, konto, rows, teraz) {
  fs.mkdirSync(bazaDir, { recursive: true });
  const plik = path.join(bazaDir, "baza_filmow.json");
  if (fs.existsSync(plik)) { // kopia zapasowa poprzedniej wersji (ostatnie 5)
    const kopie = path.join(bazaDir, "kopie"); fs.mkdirSync(kopie, { recursive: true });
    fs.copyFileSync(plik, path.join(kopie, `baza_filmow_${teraz.replace(/[:.]/g, "-")}.json`));
    for (const s of fs.readdirSync(kopie).filter((f) => f.startsWith("baza_filmow_")).sort().slice(0, -5)) fs.unlinkSync(path.join(kopie, s));
  }
  const baza = fs.existsSync(plik) ? JSON.parse(fs.readFileSync(plik, "utf8")) : { konto, utworzona: teraz, filmy: {} };
  let nowe = 0, odswiezone = 0;
  for (const { r, folder } of rows) {
    const id = txt(r.video_id) || r.url, st = baza.filmy[id];
    const hist = new Map((st?.historia ?? []).map((p) => [p.at, p]));
    if (r.measured_at) hist.set(r.measured_at, { at: r.measured_at, views: r.views ?? null, likes: r.likes ?? null, comments: r.comments_count ?? null, shares: r.shares ?? null });
    const nowszy = !st || (r.measured_at ?? "") >= (st.rekord?.measured_at ?? "");
    if (st) odswiezone++; else nowe++;
    baza.filmy[id] = { pierwszy_zapis: st?.pierwszy_zapis ?? teraz, ostatni_zapis: teraz, rekord: nowszy ? r : st.rekord, folder: nowszy ? folder : st.folder, historia: [...hist.values()].sort((a, b) => a.at.localeCompare(b.at)) };
  }
  baza.konto = konto; baza.zaktualizowana = teraz;
  fs.writeFileSync(plik, JSON.stringify(baza, null, 1));
  const lista = Object.values(baza.filmy).sort((a, b) => txt(b.rekord.published_at).localeCompare(txt(a.rekord.published_at)));
  const kol = [...INDEKS_TT, "pierwszy_pomiar", "ostatni_pomiar", "punktow_historii", "przyrost_wyswietlen_od_pierwszego_pomiaru"];
  const wiersze = lista.map((f, i) => { const h = f.historia, p = h[0], o = h.at(-1); return [...wierszIndeksu(f.rekord, i + 1, f.folder ?? ""), txt(p?.at), txt(o?.at), txt(h.length), p?.views != null && o?.views != null ? String(o.views - p.views) : ""]; });
  fs.writeFileSync(path.join(bazaDir, "baza_filmow.csv"), csvTekst(kol, wiersze));
  return { nowe, odswiezone, razem: lista.length };
}

/** records: tablica z export_tiktok (JSON); wyjscie: folder „wyniki”; zrodlo: folder z oryginalnymi plikami eksportu (kopiowane do _zbiorczo\eksport_serwera). */
export function rozlozTikTok({ records, wyjscie, zrodlo = null, teraz = new Date().toISOString() }) {
  if (!Array.isArray(records) || !records.length) throw new Error("Eksport TikTok jest pusty albo ma zły format (oczekiwana tablica rekordów).");
  const grupy = new Map();
  for (const r of records) { const k = kontoDir(r); (grupy.get(k) ?? grupy.set(k, []).get(k)).push(r); }
  const wynik = [];
  for (const [dirNazwa, filmy] of grupy) {
    const kdir = path.join(wyjscie, dirNazwa), konto = kontoNazwa(filmy[0]);
    filmy.sort((a, b) => txt(b.published_at).localeCompare(txt(a.published_at)));
    const rows = [];
    for (const r of filmy) {
      const folder = nazwaFolderuRolki(konto, nazwaFilmu(r), txt(r.video_id) || "bez-id");
      const d = path.join(kdir, folder); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "dane.md"), kartaFilmu(r, folder));
      fs.writeFileSync(path.join(d, "dane.json"), JSON.stringify(r, null, 1));
      fs.writeFileSync(path.join(d, "dane.csv"), csvTekst(INDEKS_TT, [wierszIndeksu(r, 1, folder)]));
      fs.writeFileSync(path.join(d, "transkrypt.txt"), r.transcript ?? "");
      fs.writeFileSync(path.join(d, "transkrypt_czasy.txt"), (r.transcript_timed ?? []).map((s) => `[${czas(s.start_s)}] ${s.text}`).join("\n"));
      rows.push({ r, folder });
    }
    const zb = path.join(kdir, "_zbiorczo"); fs.mkdirSync(zb, { recursive: true });
    fs.writeFileSync(path.join(zb, "indeks_filmow.csv"), csvTekst(INDEKS_TT, rows.map(({ r, folder }, i) => wierszIndeksu(r, i + 1, folder))));
    fs.writeFileSync(path.join(zb, "indeks_filmow.md"), indeksMd(konto, rows, teraz));
    fs.writeFileSync(path.join(zb, "do_analizy.md"), doAnalizyMd(konto, rows, teraz));
    if (zrodlo && fs.existsSync(zrodlo)) {
      const ed = path.join(zb, "eksport_serwera"); fs.mkdirSync(ed, { recursive: true });
      for (const f of fs.readdirSync(zrodlo)) if (fs.statSync(path.join(zrodlo, f)).isFile()) fs.copyFileSync(path.join(zrodlo, f), path.join(ed, f));
    }
    const baza = scalBazeTt(path.join(kdir, "_baza"), konto, rows, teraz);
    wynik.push({ konto, folder: kdir, filmow: rows.length, baza });
  }
  return wynik;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2), plik = a.find((x) => !x.startsWith("--")), wyj = a.filter((x) => !x.startsWith("--"))[1];
  const zi = a.indexOf("--zrodlo");
  if (!plik || !wyj) { console.error("Użycie: node tiktok_rozloz.mjs <eksport.json> <folder_wyniki> [--zrodlo folder_eksportu]"); process.exit(2); }
  const out = rozlozTikTok({ records: JSON.parse(fs.readFileSync(plik, "utf8")), wyjscie: wyj, zrodlo: zi >= 0 ? a[zi + 1] : null });
  for (const o of out) console.log(`@${o.konto}: ${o.filmow} filmów -> ${o.folder} (baza: ${o.baza.nowe} nowych, ${o.baza.odswiezone} odświeżonych, razem ${o.baza.razem})`);
}
