import { chordWordIndex, transposeSongbookChord, type LyricWordAnchor, type SongbookRow } from "./lyrics";
import { prepareLyricLine, singingLyrics } from "./singingLyrics";
import type { ChordSegment } from "./types";

type TimedLine = { at: number; end?: number; text: string; sourceLine?: number };
type PlacedChord = ChordSegment & { printed?: string };
export type InstrumentalSpan = { at: number; end: number };

const wordColumn = (text: string, word: number) => {
  const pattern = /[\p{L}\p{M}\p{N}]+/gu;
  let seen = 0;
  for (const match of text.matchAll(pattern)) {
    if (seen === word) return match.index ?? 0;
    seen++;
  }
  return 0;
};

const normalize = (line: string) => line.normalize("NFC").toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();

function sectionTag(heading: string | undefined, kind: string | undefined, number: number | undefined, counts: Record<string, number>) {
  const inner = (heading ?? "").trim().replace(/^\[|\]$/g, "");
  const short = /^([VBCP])(\d*)$/i.exec(inner);
  if (short) return `[${short[1].toUpperCase()}${short[2] || "1"}]`;
  const named = /^(verse|chorus|refrain|bridge|pre[- ]?chorus|intro|outro)\s*(\d*)$/i.exec(inner);
  let code = "";
  let explicit = "";
  if (named) {
    const word = named[1].toLowerCase();
    code = word.startsWith("pre") ? "P" : word.startsWith("verse") ? "V" : word.startsWith("bridge") ? "B"
      : word.startsWith("intro") ? "Intro" : word.startsWith("outro") ? "Outro" : "C";
    explicit = named[2];
  } else if (kind === "Verse") code = "V";
  else if (kind === "Chorus") code = "C";
  else if (kind === "Section") code = "S";
  else if (inner) return `[${inner}]`;
  if (!code) return undefined;
  if (code === "Intro" || code === "Outro") return `[${code}]`;
  if (explicit) return `[${code}${explicit}]`;
  if (number) return `[${code}${number}]`;
  counts[code] = (counts[code] ?? 0) + 1;
  return `[${code}${counts[code]}]`;
}

// Every lyric text becomes the same lead-sheet: a section tag, then each line
// with the chords that start during it sitting on the word where they change.
export function songbookFromLyrics(
  text: string,
  lines: TimedLine[],
  chords: PlacedChord[],
  words?: Map<number, LyricWordAnchor[]>,
  duration = Infinity,
  stripManualChordRows = true,
): SongbookRow[] {
  const sections = singingLyrics(text, stripManualChordRows);
  if (!sections.length) return [];
  const timed = lines.filter(line => Number.isFinite(line.at) && line.at >= 0)
    .sort((a, b) => a.at - b.at);
  const bySourceLine = new Map(timed.flatMap((line, index) => line.sourceLine === undefined ? [] : [[line.sourceLine, index] as const]));
  const sourceLines = bySourceLine.size ? text.split(/\r?\n/).map(raw => normalize(prepareLyricLine(raw, stripManualChordRows) ?? "")) : [];
  const named = chords.map((chord, index) => ({ chord, index })).filter(({ chord }) =>
    chord.kind !== "no_chord" && Boolean(chord.display) && !/^n\.?c\.?$/i.test(chord.display));
  const counts: Record<string, number> = {};
  let cursor = 0;
  let sourceCursor = 0;
  const rows: SongbookRow[] = [];
  for (const section of sections) {
    const onlyBlock = sections.length === 1 && !section.heading && !section.kind;
    const tag = sectionTag(section.heading, section.kind, section.number, counts) ?? (onlyBlock ? "[V1]" : undefined);
    if (tag) rows.push({ text: tag, section: true, chords: [] });
    for (const line of section.lines) {
      if (!line.trim()) continue;
      const key = normalize(line);
      let match: TimedLine | undefined;
      let matchIndex = -1;
      if (bySourceLine.size) {
        const sourceIndex = sourceLines.indexOf(key, sourceCursor);
        if (sourceIndex >= 0) {
          sourceCursor = sourceIndex + 1;
          matchIndex = bySourceLine.get(sourceIndex) ?? -1;
          match = timed[matchIndex];
        }
      } else {
        for (let index = cursor; index < timed.length; index++) {
          if (normalize(timed[index].text) !== key) continue;
          matchIndex = index;
          match = timed[index];
          cursor = index + 1;
          break;
        }
      }
      const row: SongbookRow = { text: line, chords: [] };
      if (match) {
        const nextAt = timed.slice(matchIndex + 1).find(line => line.at > match!.at)?.at;
        const end = Math.min(match.end !== undefined && match.end > match.at ? match.end : Infinity,
          nextAt ?? Infinity, duration);
        if (Number.isFinite(end) && end > match.at) row.timing = { start: match.at, end };
        const anchors = words?.get(match.at);
        let held: SongbookRow["chords"][number] | undefined;
        for (const { chord, index } of row.timing ? named : []) {
          if (chord.end <= match.at || chord.start >= end) continue;
          if (chord.start < match.at) {
            held = { at: 0, label: chord.printed || chord.display, detected: index };
            continue;
          }
          let at = -1;
          if (anchors?.length) {
            const word = chordWordIndex(chord, { start: match.at, end, text: line, chords: [] }, anchors);
            if (word >= 0) at = wordColumn(line, word);
          }
          if (at < 0 && chord.start - match.at <= .18) at = 0;
          if (at >= 0) row.chords.push({ at, label: chord.printed || chord.display, detected: index });
        }
        // Keep a held chord when it is the only cue for the opening word.
        // If the harmony changes on that same word, show the actual change.
        if (held && !row.chords.some(chord => chord.at === 0)) row.chords.unshift(held);
      }
      rows.push(row);
    }
  }
  return rows.some(row => !row.section && row.text.trim()) ? rows : [];
}

export function withInstrumentalRows(
  rows: SongbookRow[], spans: InstrumentalSpan[], chords: PlacedChord[], duration: number,
): SongbookRow[] {
  if (!rows.length || !spans.length) return rows;
  const result = [...rows];
  for (const { at, end } of [...spans].sort((a, b) => a.at - b.at)) {
    if (!Number.isFinite(at) || !Number.isFinite(end) || at < 0 || end <= at || end > duration + .01) continue;
    if (result.some(row => row.timing && row.timing.start < end - .01 && row.timing.end > at + .01)) continue;
    let column = 0;
    let start = end;
    const placements = chords.flatMap((chord, detected) => {
      if (chord.kind !== "chord" || chord.start >= end || chord.end <= at || !chord.display) return [];
      start = Math.min(start, Math.max(at, chord.start));
      const label = chord.printed || chord.display;
      const placement = { at: column, label, detected };
      column += Array.from(label).length + 2;
      return [placement];
    });
    if (!placements.length) continue;
    let next = result.findIndex(row => row.timing && row.timing.start >= end - .01);
    if (next === -1) next = result.length;
    else while (next > 0 && result[next - 1].section) next--;
    result.splice(next, 0, { text: "Solo", chords: placements, timing: { start, end: Math.min(duration, end) } });
  }
  return result;
}

export type LeadLine = { tag: string; chords: string; text: string };
export const SECTION_KINDS = [
  { code: "V", name: "Verse" },
  { code: "C", name: "Chorus" },
  { code: "B", name: "Bridge" },
  { code: "P", name: "Pre-Chorus" },
  { code: "I", name: "Intro" },
  { code: "O", name: "Outro" },
] as const;

export function sectionKind(tag: string) {
  const inner = tag.trim().replace(/^\[|\]$/g, "");
  const short = /^([VCBPIO])(\d+)$/i.exec(inner);
  if (short) {
    const code = short[1].toUpperCase();
    const kind = SECTION_KINDS.find(item => item.code === code);
    return kind ? { code, name: kind.name, number: Number(short[2]) } : null;
  }
  if (/^intro$/i.test(inner)) return { code: "I", name: "Intro", number: 1 };
  if (/^outro$/i.test(inner)) return { code: "O", name: "Outro", number: 1 };
  return null;
}

export function sectionLabel(tag: string) {
  const kind = sectionKind(tag);
  if (!kind) return "";
  return /\d/.test(tag) ? `${kind.name} ${kind.number}` : kind.name;
}

// The next Verse after [V1] is [V2]. The same count applies to every section type.
export function nextSectionTag(blocks: { tag: string }[], code: string) {
  const used = new Set(blocks.flatMap(block => {
    const kind = sectionKind(block.tag);
    return kind?.code === code ? [kind.number] : [];
  }));
  let number = 1;
  while (used.has(number)) number++;
  return `[${code}${number}]`;
}
const chordPattern = /[A-G][#b♯♭]?(?::)?(?:maj|min|m|dim|aug|sus|add)?\d*(?:\/(?:[A-G][#b♯♭]?|\d+))?/g;

function chordSpans(line: string) {
  return [...line.matchAll(new RegExp(chordPattern.source, "g"))];
}

function isChordLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let rest = trimmed;
  for (const match of chordSpans(trimmed)) rest = rest.replace(match[0], "");
  return !/[^\s]/.test(rest);
}

function readableTag(line: string) {
  return sectionTag(line, undefined, undefined, {}) ?? line.trim();
}

// A lead sheet is section, then the chord line, then the lyric line.
export function parseLeadSheet(text: string): LeadLine[] {
  const lines = text.split(/\r?\n/);
  const blocks: LeadLine[] = [];
  const take = (tag: string, chords: string, text: string) => {
    const last = blocks.at(-1);
    if (last?.tag && !last.chords && !last.text && !tag) {
      last.chords = chords;
      last.text = text;
      return;
    }
    blocks.push({ tag, chords, text });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      blocks.push({ tag: readableTag(trimmed), chords: "", text: "" });
      continue;
    }
    const next = lines[index + 1] ?? "";
    const nextTrimmed = next.trim();
    if (isChordLine(line) && nextTrimmed && !/^\[[^\]]+\]$/.test(nextTrimmed) && !isChordLine(next)) {
      take("", line.replace(/\s+$/, ""), nextTrimmed);
      index++;
      continue;
    }
    if (isChordLine(line)) take("", line.replace(/\s+$/, ""), "");
    else take("", "", trimmed);
  }
  return blocks.length ? blocks : [{ tag: "", chords: "", text: "" }];
}

export function formatLeadSheet(blocks: LeadLine[]) {
  return blocks.flatMap(block => {
    const lines: string[] = [];
    if (block.tag) lines.push(block.tag);
    if (block.chords.trim() || block.text.trim()) {
      if (block.chords.trim()) lines.push(block.chords.replace(/\s+$/, ""));
      lines.push(block.text);
    }
    return lines;
  }).join("\n");
}

export function leadSheetChart(text: string): SongbookRow[] {
  const rows: SongbookRow[] = [];
  for (const block of parseLeadSheet(text)) {
    if (block.tag) rows.push({ text: block.tag, section: true, chords: [] });
    if (!block.chords.trim() && !block.text.trim()) continue;
    rows.push({
      text: block.text,
      chords: chordSpans(block.chords).map(match => ({ at: match.index ?? 0, label: match[0] })),
    });
  }
  return rows.some(row => !row.section && (row.text.trim() || row.chords.length)) ? rows : [];
}

export function chartToLead(rows: SongbookRow[], transpose = 0): LeadLine[] {
  const blocks: LeadLine[] = [];
  let tag = "";
  const pushTag = () => {
    if (!tag) return;
    blocks.push({ tag, chords: "", text: "" });
    tag = "";
  };
  for (const row of rows) {
    if (row.section) {
      pushTag();
      tag = row.text.trim();
      continue;
    }
    let chordLine = "";
    for (const chord of [...row.chords].sort((a, b) => a.at - b.at)) {
      const label = transposeSongbookChord(chord.label, transpose);
      const at = Math.max(chordLine.length ? chordLine.length + 1 : 0, chord.at);
      chordLine += " ".repeat(Math.max(0, at - chordLine.length)) + label;
    }
    blocks.push({ tag, chords: chordLine, text: row.text });
    tag = "";
  }
  pushTag();
  return blocks.length ? blocks : [{ tag: "", chords: "", text: "" }];
}
