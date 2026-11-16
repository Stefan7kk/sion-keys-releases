import { languageDirection, type Language } from "./languages";
import { localizedKey, translate } from "./i18n";

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function formatScore(score: number | null | undefined, kind: string): string {
  if (score == null || Number.isNaN(score)) return "—";
  // Never show as "% probability"
  if (kind === "profile_correlation" || kind === "template_similarity") {
    return score.toFixed(2);
  }
  return score.toFixed(2);
}

export function chordToneClass(seg: { label: string; kind: string }): string {
  if (seg.kind === "no_chord" || seg.label === "N.C.") return "chord-nc";
  if (seg.label.endsWith(":min") || seg.label.endsWith(":min7")) return "chord-min";
  return "chord-maj";
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function resultToJson(result: {
  key: unknown;
  chords: unknown;
  rawChords: unknown;
  originalChords?: unknown;
  source: unknown;
  meta: unknown;
}): string {
  return JSON.stringify(
    {
      source: result.source,
      key: result.key,
      chords: result.chords,
      rawChords: result.rawChords,
      originalChords: result.originalChords,
      meta: result.meta,
    },
    null,
    2,
  );
}

export function resultToCsv(chords: Array<{ start: number; end: number; display: string; label: string; score: number | null; scoreKind: string; kind: string }>): string {
  const header = "start_sec,end_sec,display,label,score,score_kind,kind";
  const rows = chords.map((c) =>
    [c.start, c.end, csvEsc(c.display), csvEsc(c.label), c.score ?? "", csvEsc(c.scoreKind), csvEsc(c.kind)].join(","),
  );
  return [header, ...rows].join("\n");
}

function csvEsc(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}


export function printableChart(result: import("./types").AnalysisResult, language: Language = "en"): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
  const t = (key: string) => escape(translate(language, key));
  const direction = languageDirection(language);
  const title = escape(result.source.name);
  const source = result.source.url ? `<bdi dir="ltr">${escape(result.source.url)}</bdi>` : t("Local audio");
  const rows = result.chords.map(chord => `<tr>
    <td dir="ltr">${formatTime(chord.start)}–${formatTime(chord.end)}</td>
    <td><bdi dir="ltr">${escape(chord.display)}</bdi></td>
    <td>${chord.scoreKind === "manual" ? t("Edited") : chord.kind === "uncertain" ? t("Uncertain") : chord.kind === "no_chord" ? t("No chord") : ""}</td>
  </tr>`).join("");
  return `<!doctype html><html lang="${escape(language)}" dir="${direction}"><meta charset="utf-8"><title>${title} — ${t("Chord chart")}</title>
    <style>
      body{font:16px system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#162433}
      h1{margin-bottom:.4rem} p{margin:.35rem 0;overflow-wrap:anywhere}
      table{width:100%;border-collapse:collapse;margin-top:1rem} th,td{text-align:start;padding:.45rem .65rem;border-bottom:1px solid #ccd4dc}
      td:first-child{font-variant-numeric:tabular-nums} td:nth-child(2){font-weight:600} tr{break-inside:avoid}
      @media print{body{margin:0;padding:0;color:#000}}
    </style><h1><bdi>${title}</bdi></h1><p>${t("Key")}: <bdi>${escape(localizedKey(language, result.key.label))}</bdi>${result.key.uncertain ? ` (${t("uncertain")})` : ""}</p><p>${t("Source")}: ${source}</p>
    <table><thead><tr><th>${t("Time")}</th><th>${t("Chord")}</th><th>${t("Notes")}</th></tr></thead><tbody>${rows}</tbody></table></html>`;
}
