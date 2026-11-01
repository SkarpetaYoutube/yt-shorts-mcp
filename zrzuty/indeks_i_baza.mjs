// Indeks kanału (jeden wiersz na rolkę) i lokalna baza główna (scalanie kolejnych eksportów, historia wyświetleń).
// Dane pochodzą wyłącznie z eksportu serwera i ze statusów zrzutów; nic nie jest zgadywane ani oceniane.
import fs from "node:fs";
import path from "node:path";

export const INDEKS_KOLUMNY = [
  "lp", "kanal", "tytul", "id", "link", "opublikowano", "dlugosc_s", "wyswietlenia", "polubienia", "komentarze_liczba",
  "ranking_kanalu", "rolek_w_rankingu", "krotnosc_mediany", "top5_kanalu", "ponad_norme_kanalu", "przyrost_wyswietlen", "przyrost_na_dobe",
  "transkrypt_status", "czasy_transkryptu_status", "komentarze_status", "statystyki_status", "wizja_status",
  "zdjec_wg_gemini", "zdjec_pelnych", "zdjec_czesciowych", "zdjec_brak", "status_zdjec", "folder",
];
const tak = (v) => (v == null ? "" : v ? "TAK" : "NIE");
const txt = (v) => (v == null ? "" : String(v));

/** Liczby zdjęć wg kategorii kontekstu (pełne / częściowe / brak) i krótki opis statusu. */
export function liczbyZdjec(opis) {
  let pelne = 0, czesciowe = 0, brak = 0, zweryf = 0;
  for (const z of opis) {
    const k = z.zrzuty?.kategoria_kontekstu ?? "BRAK_ZRZUTU";
    if (k.startsWith("PELNY")) pelne++; else if (k.startsWith("CZESCIOWY")) czesciowe++; else brak++;
    if (k.endsWith("_ZWERYFIKOWANY")) zweryf++;
  }
  const status = !opis.length ? "bez zdjęć wg wizji lub brak analizy wizji"
    : `${pelne} pełne, ${czesciowe} częściowe, ${brak} brak (z ${opis.length}); sprawdzone wzrokowo: ${zweryf}`;
  return { pelne, czesciowe, brak, zweryf, status };
}

/** Jeden wiersz indeksu: rekord eksportu + status zdjęć + względna ścieżka folderu rolki. */
export function wierszIndeksu(rec, opis, lp, folderWzgledny) {
  const z = liczbyZdjec(opis);
  return [
    lp, rec.channel_title, rec.title, rec.video_id, rec.url, rec.published_at, rec.duration_seconds, rec.views, rec.likes, rec.comments_count,
    rec.channel_views_rank, rec.channel_shorts_ranked, rec.views_vs_channel_median, tak(rec.top_5_percent_channel), tak(rec.above_channel_norm), rec.views_gain, rec.views_gain_per_day,
    rec.transcript_status, rec.transcript_timed_status, rec.comments_status, rec.stats_status, rec.vision_status,
    opis.length, z.pelne, z.czesciowe, z.brak, z.status, folderWzgledny,
  ].map(txt);
}

const csvQ = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvSafe = (s) => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s); // ochrona przed formułami w Excelu (jak w eksporcie serwera)
export const csvTekst = (kolumny, wiersze) => "﻿" + [kolumny, ...wiersze.map((w) => w.map(csvSafe))].map((r) => r.map(csvQ).join(",")).join("\r\n") + "\r\n";

/** Tabela Markdown z najważniejszymi kolumnami indeksu. */
export function mdIndeksu(kanal, wiersze) {
  const i = (k) => INDEKS_KOLUMNY.indexOf(k);
  const L = [`# Indeks rolek: ${kanal}`, "", `Rolek: ${wiersze.length}. Wszystkie kolumny: \`indeks_rolek.csv\`. Statusy zdjęć: „pełne/częściowe/brak” wg kontekstu; „sprawdzone wzrokowo” tylko po audycie (patrz zdjecia.md w folderze rolki).`, "",
    "| lp | tytuł | wyświetlenia | ranking kanału | zdjęcia (pełne/częśc./brak) | folder |", "|---|---|---|---|---|---|"];
  for (const w of wiersze) L.push(`| ${w[i("lp")]} | ${w[i("tytul")].replace(/\|/g, "/")} | ${w[i("wyswietlenia")]} | ${w[i("ranking_kanalu")]}${w[i("rolek_w_rankingu")] ? "/" + w[i("rolek_w_rankingu")] : ""} | ${w[i("zdjec_pelnych")]}/${w[i("zdjec_czesciowych")]}/${w[i("zdjec_brak")]} | \`${w[i("folder")]}\` |`);
  return L.join("\n") + "\n";
}

/** Zapis indeksu kanału do folderu _zbiorczo (CSV + Markdown). */
export function zapiszIndeks(zbiorczoDir, kanal, wiersze) {
  fs.mkdirSync(zbiorczoDir, { recursive: true });
  fs.writeFileSync(path.join(zbiorczoDir, "indeks_rolek.csv"), csvTekst(INDEKS_KOLUMNY, wiersze));
  fs.writeFileSync(path.join(zbiorczoDir, "indeks_rolek.md"), mdIndeksu(kanal, wiersze));
}

// ------------------------------------------------------------------------------------------------ baza główna
const punkt = (rec) => ({ at: rec.measured_at, views: rec.views ?? null, likes: rec.likes ?? null, comments_count: rec.comments_count ?? null });

/**
 * Scala rekordy z bieżącego eksportu z lokalną bazą kanału (baza.json): bez duplikatów po ID rolki; zostaje najnowszy rekord (wg measured_at),
 * a historia wyświetleń jest sumą punktów ze wszystkich eksportów (bez powtórek po czasie). Serwer trzyma dane tylko 30 dni, baza lokalna nie wygasa.
 * pozycje: [{rec, opis, folder}]. Zwraca {baza, nowe, odswiezone}.
 */
export function scalBaze(bazaDir, kanal, pozycje, teraz = new Date().toISOString()) {
  fs.mkdirSync(bazaDir, { recursive: true });
  const plik = path.join(bazaDir, "baza_rolek.json");
  const baza = fs.existsSync(plik) ? JSON.parse(fs.readFileSync(plik, "utf8")) : { kanal, utworzona: teraz, rolki: {} };
  let nowe = 0, odswiezone = 0;
  for (const { rec, opis, folder } of pozycje) {
    const stara = baza.rolki[rec.video_id];
    const hist = new Map((stara?.historia ?? []).map((p) => [p.at, p]));
    for (const p of [...(rec.views_history ?? []), punkt(rec)]) if (p?.at) hist.set(p.at, { at: p.at, views: p.views ?? null, likes: p.likes ?? null, comments_count: p.comments_count ?? null });
    const historia = [...hist.values()].sort((a, b) => a.at.localeCompare(b.at));
    const nowszy = !stara || (rec.measured_at ?? "") >= (stara.rekord?.measured_at ?? "");
    if (!stara) nowe++; else odswiezone++;
    baza.rolki[rec.video_id] = {
      pierwszy_zapis: stara?.pierwszy_zapis ?? teraz, ostatni_zapis: teraz,
      rekord: nowszy ? rec : stara.rekord, zdjecia: nowszy ? opis : stara.zdjecia, folder: nowszy ? folder : stara.folder, historia,
    };
  }
  baza.kanal = kanal; baza.zaktualizowana = teraz;
  fs.writeFileSync(plik, JSON.stringify(baza, null, 1));
  // płaska tabela całej bazy (jedna linia na rolkę, w kolejności od najnowszej publikacji)
  const lista = Object.values(baza.rolki).sort((a, b) => (b.rekord.published_at ?? "").localeCompare(a.rekord.published_at ?? ""));
  const kolumny = [...INDEKS_KOLUMNY, "pierwszy_pomiar", "ostatni_pomiar", "punktow_historii", "przyrost_od_pierwszego_pomiaru"];
  const wiersze = lista.map((r, k) => {
    const h = r.historia, pierwszy = h[0], ostatni = h.at(-1);
    const przyrost = pierwszy && ostatni && pierwszy.views != null && ostatni.views != null ? ostatni.views - pierwszy.views : "";
    return [...wierszIndeksu(r.rekord, r.zdjecia, k + 1, r.folder ?? ""), txt(pierwszy?.at), txt(ostatni?.at), txt(h.length), txt(przyrost)];
  });
  fs.writeFileSync(path.join(bazaDir, "baza_rolek.csv"), csvTekst(kolumny, wiersze));
  return { baza, nowe, odswiezone, rolek: lista.length };
}
