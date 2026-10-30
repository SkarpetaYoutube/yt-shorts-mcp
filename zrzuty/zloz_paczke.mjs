// Składa jeden folder-paczkę dla modelu: dane.json (eksport), paczka.md (metadane, statystyki, transkrypt z czasami, komentarze,
// zdjęcia z obrazami obok odpowiadających wpisów), frames/ (screeny rozmów i wycinki zdjęć), frames_manifest.json.
// Użycie: node zloz_paczke.mjs <eksport.json> <folder_zrzutow (z frames_manifest.json)> <folder_paczki>
import fs from "node:fs";
import path from "node:path";
import { contextCategory, CTX, CTX_LABEL } from "./kontekst.mjs";
const [expFile, framesDir, outDir, onlyArg] = process.argv.slice(2);
const onlyIds = onlyArg ? onlyArg.split(",") : null;
if (!expFile || !framesDir || !outDir) { console.error("Użycie: node zloz_paczke.mjs <eksport.json> <folder_zrzutow> <folder_paczki>"); process.exit(2); }
const manPath = path.join(framesDir, "frames_manifest.json");
const man = fs.existsSync(manPath) ? JSON.parse(fs.readFileSync(manPath, "utf8")) : [];
const manIds = new Set(man.map((m) => m.video_id));
// filtr obowiązuje w całym procesie: tylko rolki wskazane (-Tylko) albo te, które przeszły przez zrzuty
const recs = JSON.parse(fs.readFileSync(expFile, "utf8")).filter((r) => (onlyIds ? onlyIds.includes(r.video_id) : manIds.has(r.video_id)));
fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });
const clock = (s) => { s = Math.max(0, Number(s) || 0); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
const n = (x) => (x == null ? "brak danych" : Number(x).toLocaleString("pl-PL"));
const L = [`# Paczka dla modelu — ${recs.length} rolek`, "", `Złożono automatycznie z: eksportu programu (${path.basename(expFile)}) i zrzutów klatek (${man.length} zdjęć). Opisy i powiązania zdjęć z wiadomościami to ocena modelu Gemini (nie potwierdzona przez człowieka); obrazy to rzeczywiste klatki z wideo. Czas „zmierzony" pochodzi ze sprawdzenia sąsiednich klatek (krok 0,25 s), czas „modelu" jest przybliżony.`, ""];
const cropOk = (m) => m.crop_confirmed ?? (!!m.photo_file && !!m.confirmed);
const exists = (f) => !!f && fs.existsSync(path.join(framesDir, f));
const catOf = (m) => contextCategory(m, exists);
const ctxOk = (m) => CTX[catOf(m)] >= CTX.PELNY_NIEZWERYFIKOWANY; // „pełny” (zweryfikowany lub nie) — do wyboru, który status pokazać
const ccLine = (m) => { const c = catOf(m), cc = m.content_check; let t = `Kontekst: **${CTX_LABEL[c]}**`;
  if (c.endsWith("_ZWERYFIKOWANY") && cc) t += ` (sprawdził: ${cc.checked_by ?? "?"}, ${cc.checked_at ?? "?"})${cc.missing?.length ? `; brakuje w kadrach: ${cc.missing.map((x) => `„${x}"`).join("; ")}` : ""}`;
  if (m.last_attempt && !m.last_attempt.adopted) t += ` | ostatnia próba${m.last_attempt.attempt_no ? " nr " + m.last_attempt.attempt_no : ""} (${m.last_attempt.status ?? "?"}) dała gorszy wynik i NIE zastąpiła tego`;
  return t; };
let copied = 0, missing = 0, unconfirmed = 0;
recs.forEach((r, i) => {
  L.push(`## ${i + 1}. ${String(r.title).replace(/\s*\n\s*/g, " ")}`, "");
  L.push(`- ID: \`${r.video_id}\` | ${r.url} | kanał: ${r.channel_title}${r.channel_handle ? ` (${r.channel_handle})` : ""} | publikacja: ${r.published_at} | długość: ${r.duration_seconds} s`);
  L.push(`- Wyświetlenia: ${n(r.views)} | polubienia: ${n(r.likes)} | komentarze: ${n(r.comments_count)} | pomiar: ${r.measured_at ?? "brak"}`);
  L.push(`- Ranking kanału: ${r.channel_views_rank ?? "brak"} z ${r.channel_shorts_ranked ?? "?"} | TOP 5% kanału: ${r.top_5_percent_channel ?? "brak"} | krotność mediany kanału: ${r.views_vs_channel_median ?? "brak"} | ranking zestawu: ${r.set_views_rank ?? "brak"} z ${r.set_size ?? "?"}`);
  if (r.views_gain != null) L.push(`- Przyrost od ${r.views_prev_at}: ${r.views_gain}, ${r.views_gain_per_day ?? "?"}/dobę`);
  L.push("", "### Transkrypt z czasami", "");
  if (r.transcript_timed?.length) L.push(...r.transcript_timed.map((x) => `[${clock(x.start_s)}] ${x.text}`));
  else L.push(`(brak czasów — status: ${r.transcript_timed_status})`, "", r.transcript ?? "");
  L.push("", `Status czasów transkryptu: ${r.transcript_timed_status}`, "", "### Zdjęcia w rozmowie (opis modelu + rzeczywiste obrazy)", "");
  const v = r.vision;
  if (!v) L.push(`(brak wyniku wizji: ${r.vision_status})`, "");
  else {
    L.push(`Model: ${v.model}, fps ${v.fps}, przebieg \`${v.run_id}\`. Zdjęć wykrytych przez model: ${v.images.length}. ${v.limits_pl}`, "");
    for (const im of v.images) {
      const m = man.find((x) => x.video_id === r.video_id && x.image_id === im.id);
      L.push(`#### Zdjęcie ${im.id} (wykryte przez model)`, "");
      L.push(`- Czas wg modelu: ${im.first_visible ?? "?"} – ${im.last_visible ?? "?"}${m?.measured_first_s != null ? ` | czas zmierzony na klatkach: ${clock(m.measured_first_s)} – ${clock(m.measured_last_s)}` : ""}`);
      L.push(`- Nadawca: ${im.sent_by ?? "brak"} | opis (Gemini, dodatek do obrazu): ${im.description_pl ?? "brak"}${im.text_in_image ? ` | tekst na zdjęciu: ${im.text_in_image}` : ""}`);
      const ml = (a) => (a && a.length ? a.map((x) => `${x.t ?? "?"} ${x.sender ?? "?"}: „${x.text}"`).join(" | ") : "brak");
      L.push(`- Wiadomości przed: ${ml(im.messages_before)}`, `- Wiadomości po: ${ml(im.messages_after)}`);
      for (const x of (im.related_messages || [])) L.push(`- Powiązana wiadomość: ${x.t ?? "?"} ${x.sender ?? "?"}: „${x.text}" — ${x.link_status_pl}`);
      if (!(im.related_messages || []).length) L.push("- Powiązana wiadomość: model nie wskazał żadnej");
      if (im.uncertainty_pl) L.push(`- Niepewność wg modelu: ${im.uncertainty_pl}`);
      L.push("");
      if (!m) { L.push("**Obrazy: brak — zrzutów dla tego zdjęcia nie wykonano.**", ""); missing++; }
      else {
        if (!ctxOk(m) || !cropOk(m)) unconfirmed++;
        if (m.source_resolution) L.push(`Rozdzielczość źródła: ${m.source_resolution}; wycinek zdjęcia: ${m.photo_resolution} (natywne PNG, bez skalowania i bez poprawiania). ${m.quality_note ?? ""}`, "");
        L.push(`${ccLine(m)} | ciasny wycinek: ${cropOk(m) ? "potwierdzony" : "niepotwierdzony"} | status programu: ${m.status ?? "?"}${m.note ? ` — ${m.note}` : ""}`, "");
        if (m.status === "WYMAGA_CZLOWIEKA") L.push(`**WYMAGA CZŁOWIEKA:** ${m.human_required}`, "");
        if (m.messages_needed?.length) L.push(`Wiadomości odnoszące się do zdjęcia (z wyniku modelu i transkryptu; czas = kiedy mają być już na ekranie): ${m.messages_needed.map((x) => `${clock(x.t)} ${x.sender ?? "?"}: „${x.text}"`).join(" | ")}`, "");
        // 1) ciasny wycinek samego zdjęcia; 2) screeny kontekstu w kolejności czasu (prawdziwe, osobne klatki — nic nie jest doklejane)
        const items = [];
        if (cropOk(m)) items.push(["Wycinek zdjęcia (ciasny kadr)", m.photo_file, null]);
        else if (m.crop_diag?.file) items.push(["Wycinek NIEPOTWIERDZONY — klatka diagnostyczna z proponowanymi granicami (zielona: karta, czerwona: wycinek)", m.crop_diag.file, null]);
        else if (m.missing_diag?.file) items.push(["ZDJĘCIA NIE ZNALEZIONO — klatka diagnostyczna z chwili wskazanej przez model (to NIE jest screen rozmowy ze zdjęciem; służy do oceny wzrokowej)", m.missing_diag.file, null]);
        else L.push("Wycinek zdjęcia: niepotwierdzony, brak klatki diagnostycznej.", "");
        if (m.context_shots?.length) for (const s of m.context_shots) items.push([`Screen kontekstu ${s.order ?? "?"} — ${({ zdjecie_i_reakcja: "zdjęcie i odnoszące się do niego wiadomości w jednej klatce", zdjecie_widoczne: "zdjęcie widoczne (reakcja pojawia się później)", w_trakcie: "klatka pośrednia", reakcja: "reakcja po zniknięciu zdjęcia" })[s.role] ?? s.role} (czas ${s.t_s != null ? clock(s.t_s) : "?"}${s.photo_visible === false ? ", zdjęcia już nie widać" : ""})`, s.file, s]);
        else items.push(["Screen rozmowy (starszy format, bez kontekstu)", m.conversation_file, null]);
        for (const [label, f, s] of items) {
          if (!f) { L.push(`${label}: brak (${s?.error ?? (label.startsWith("Wycinek") ? "zdjęcie nie wykryte na klatkach" : "błąd zrzutu")})`, ""); missing++; continue; }
          const src = path.join(framesDir, f);
          if (!fs.existsSync(src)) { L.push(`${label}: brak pliku ${f}`, ""); missing++; continue; }
          fs.mkdirSync(path.dirname(path.join(outDir, f)), { recursive: true });
          fs.copyFileSync(src, path.join(outDir, f)); copied++;
          L.push(`${label}:`, "", `![${r.video_id} zdjęcie ${im.id} — ${label.split(" (")[0]}](${f})`, "");
        }
        if (m.context_v === 2 && m.context_shots?.length > 1) L.push("Uwaga: zdjęcie i pełna reakcja nie mieściły się w jednej klatce — kolejne screeny to osobne, rzeczywiste klatki w kolejności czasu (nic nie jest doklejane).", "");
      }
    }
    if (v.messages?.length) { L.push(`Wiadomości odczytane z ekranu (model, ${v.messages.length}):`, "", ...v.messages.map((x) => `- [${x.t ?? "?"}] ${x.sender ?? "?"}: ${x.text}`), ""); }
  }
  L.push("### Komentarze (do 5, kolejność trafności wg YouTube)", "");
  if (r.top_comments_relevance?.length) L.push(...r.top_comments_relevance.map((c, k) => `${k + 1}. (${c.likes ?? "?"} polubień) ${c.text}`));
  else L.push(`(brak: ${r.comments_status})`);
  L.push("", "---", "");
});
const inRecs = man.filter((m) => recs.some((r) => r.video_id === m.video_id));
const total = inRecs.length, cnt = {}; for (const k of Object.keys(CTX)) cnt[k] = inRecs.filter((m) => catOf(m) === k).length;
const anyPhoto = total - cnt.BRAK > 0, allV = total > 0 && cnt.PELNY_ZWERYFIKOWANY === total, allFull = total > 0 && cnt.PELNY_ZWERYFIKOWANY + cnt.PELNY_NIEZWERYFIKOWANY === total;
const summaryLine = `pełny zweryfikowany: ${cnt.PELNY_ZWERYFIKOWANY} | pełny NIEZWERYFIKOWANY: ${cnt.PELNY_NIEZWERYFIKOWANY} | częściowy zweryfikowany: ${cnt.CZESCIOWY_ZWERYFIKOWANY} | częściowy niezweryfikowany: ${cnt.CZESCIOWY_NIEZWERYFIKOWANY} | brak: ${cnt.BRAK} (z ${total})`;
const head = !anyPhoto ? ["# NIEPOWODZENIE — brak screenów ze zdjęciem", ""] : allV ? [`# KOMPLET ZWERYFIKOWANY — ${total} z ${total} zdjęć: pełny kontekst sprawdzony wzrokowo`, ""] : allFull ? [`# KONTEKST NIEZWERYFIKOWANY — program uznał kontekst za pełny dla ${total} z ${total}, ale treść ${cnt.PELNY_NIEZWERYFIKOWANY} kadrów nie została sprawdzona`, ""] : [`# NIEPEŁNA — pełny kontekst (zweryfikowany) tylko dla ${cnt.PELNY_ZWERYFIKOWANY} z ${total} zdjęć`, ""];
L.unshift(...head, `Stan kontekstu: ${summaryLine}`, "", "Program nie czyta tekstu na klatkach: „pełny niezweryfikowany” oznacza tylko, że według czasów powinien być pełny. Szczegóły i lista braków: AUDYT_KONTEKSTU.md (ten sam stan co manifest).", "");
fs.writeFileSync(path.join(outDir, "paczka.md"), L.join("\n"));
// AUDYT_KONTEKSTU.md — generowany z manifestu (jedno źródło prawdy)
const A = [`# Audyt kontekstu — stan z manifestu`, "", `Stan: ${summaryLine}`, "", "| Zdjęcie | Kontekst | Brakuje w kadrach | Sprawdzono | Pliki | Ostatnia próba |", "|---|---|---|---|---|---|"];
for (const m of inRecs) { const c = catOf(m), cc = m.content_check; A.push(`| ${m.video_id}#${m.image_id} | ${CTX_LABEL[c]} | ${cc && c.endsWith("_ZWERYFIKOWANY") && cc.missing?.length ? cc.missing.map((x) => `„${x}"`).join("; ") : c === "BRAK" ? "brak screena ze zdjęciem" : c.endsWith("NIEZWERYFIKOWANY") ? "nie sprawdzono" : "—"} | ${cc && c.endsWith("_ZWERYFIKOWANY") ? `${cc.checked_by} ${cc.checked_at}` : "nie"} | ${(m.context_shots || []).filter((s) => exists(s.file)).map((s) => s.file.split("/").pop()).join(", ") || "—"} | ${m.last_attempt ? `${m.last_attempt.attempt_no ? "nr " + m.last_attempt.attempt_no : "ostatnia"}: ${m.last_attempt.status ?? "?"}${m.last_attempt.adopted ? " (przyjęta)" : " (gorsza — nie przyjęta)"}` : "—"} |`); }
A.push("", "Zasady: „zweryfikowany” = treść kadrów obejrzana i zapisana przez audyt.mjs dla dokładnie tych plików (zmiana plików unieważnia ocenę). Gorsza ponowna próba nie zastępuje lepszego zapisanego wyniku.");
fs.writeFileSync(path.join(outDir, "AUDYT_KONTEKSTU.md"), A.join("\n"));
for (const st of ["KOMPLET_KONTEKST.txt", "KOMPLET.txt", "NIEPELNA.txt", "NIEPOWODZENIE.txt", "STATUS.txt", "KOMPLET_ZWERYFIKOWANY.txt", "NIEZWERYFIKOWANA.txt"]) { const f = path.join(outDir, st); if (fs.existsSync(f)) { fs.mkdirSync(path.join(outDir, "_stare_statusy"), { recursive: true }); fs.renameSync(f, path.join(outDir, "_stare_statusy", `${Date.now()}_${st}`)); } }
fs.writeFileSync(path.join(outDir, !anyPhoto ? "NIEPOWODZENIE.txt" : allV ? "KOMPLET_ZWERYFIKOWANY.txt" : allFull ? "NIEZWERYFIKOWANA.txt" : "NIEPELNA.txt"), summaryLine + `; rolek: ${recs.length}\n`);
fs.writeFileSync(path.join(outDir, "dane.json"), JSON.stringify(recs, null, 1));
fs.writeFileSync(path.join(outDir, "frames_manifest.json"), JSON.stringify(man, null, 1));
console.log(`Paczka: ${outDir}\n  rolek: ${recs.length}, obrazów skopiowanych: ${copied}, brakujących: ${missing}`);
console.log(`STAN: ${summaryLine}`);
process.exit(!anyPhoto ? 1 : allV ? 0 : allFull ? 3 : 2);
