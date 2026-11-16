import type { AnalysisResult, ChordSegment } from "./types";

export type LyricWordAnchor = [word: number, start: number, end: number];

export type LyricLine = { at: number; end?: number; text: string; sourceLine?: number };
export type LyricTimingEdits = Record<number, number>;

export function validLyricTiming(
  baseline: readonly (LyricLine | undefined)[], edits: LyricTimingEdits, duration: number,
): boolean {
  if (Object.entries(edits).some(([index, at]) =>
    !/^(0|[1-9]\d*)$/.test(index) || Number(index) >= baseline.length || !Number.isFinite(at) || at < 0 || at >= duration)) return false;
  let previous = -1;
  return baseline.every((line, index) => {
    const at = edits[index] ?? line?.at;
    if (at === undefined) return true;
    if (at <= previous) return false;
    previous = at;
    return true;
  });
}
export type SongbookRow = { text: string; section?: boolean; timing?: { start: number; end: number }; chords: { at: number; label: string; detected?: number }[] };
export type SongLyrics = { lines: LyricLine[]; plain: string; provider: string; canExport?: boolean; chart?: SongbookRow[] };
export type LyricsLookup = { source?: AnalysisResult["source"]; lyrics: SongLyrics | null; pending?: boolean; unavailable?: boolean };
export type TimedSheetRow = { start: number; end: number; text: string; chords: ChordSegment[] };

function recordingLabel(value: string) {
  return value.normalize("NFC").toLowerCase().replaceAll("i\u0307", "i")
    .replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function recordingMismatch(
  candidate: { title: string; artist: string; duration: number },
  recording: { title: string; artist: string; duration: number },
) {
  const title = recordingLabel(candidate.title);
  const recordingTitle = recordingLabel(recording.title);
  const artist = recordingLabel(candidate.artist);
  const recordingArtist = recordingLabel(recording.artist);
  const sameTitle = title && (title === recordingTitle || [artist, recordingArtist].some(name =>
    name && (recordingTitle === `${name} ${title}` || recordingTitle === `${title} ${name}`)));
  const artistDiffers = Boolean(artist && recordingArtist && artist !== recordingArtist);
  const durationDiffers = candidate.duration > 0 && recording.duration > 0
    && Math.abs(candidate.duration - recording.duration) > Math.max(8, recording.duration * 0.05);
  return Boolean(sameTitle && (artistDiffers || durationDiffers));
}

export function timedSheetRows(lines: LyricLine[], chords: ChordSegment[], duration: number): TimedSheetRow[] {
  const rows: TimedSheetRow[] = [];
  const valid = lines.filter(line => Number.isFinite(line.at) && line.at >= 0 && line.at < duration)
    .sort((a, b) => a.at - b.at);
  for (const line of valid) {
    const end = line.end !== undefined && Number.isFinite(line.end) && line.end > line.at
      ? Math.min(line.end, duration) : duration;
    const previous = rows.at(-1);
    if (previous?.start === line.at) {
      previous.text += "\n" + line.text;
      previous.end = Math.max(previous.end, end);
    } else {
      if (previous) previous.end = Math.min(previous.end, line.at);
      rows.push({ start: line.at, end, text: line.text, chords: [] });
    }
  }
  const first = rows[0];
  if (!first) return [];
  let chordIndex = 0;
  const leadIn: TimedSheetRow[] = [];
  for (let index = 0; index < chords.length && chords[index].start < first.start; index += 4) {
    const group = chords.slice(index, index + 4).filter(chord => chord.start < first.start);
    leadIn.push({ start: group[0].start, end: Math.min(first.start, group.at(-1)!.end), text: "", chords: group });
  }
  for (const row of rows) {
    while (chordIndex < chords.length && chords[chordIndex].end <= row.start) chordIndex++;
    for (let index = chordIndex; index < chords.length && chords[index].start < row.end; index++) {
      const chord = chords[index];
      if (chord.end > row.start) row.chords.push(chord);
    }
  }
  return [...leadIn, ...rows];
}

export function timedSheetPosition(rows: Pick<TimedSheetRow, "start" | "end">[], time: number) {
  let follow = -1;
  for (let index = 0; index < rows.length && rows[index].start <= time; index++) {
    follow = index;
  }
  // Keep a reading position through instrumental and untimed gaps. Only
  // highlight a row when the audio is actually within its timed interval.
  return {
    active: follow >= 0 && time < rows[follow].end ? follow : -1,
    follow: rows.length ? Math.max(0, follow) : -1,
  };
}

// A chart symbol can match every repeat. Stay on the chord that is sounding.
// Choosing the nearer onset jumps to the next repeat in the middle of a long hold.
export function activeOccurrence(indices: number[] | undefined, detected: { start: number; end: number }[] | undefined, time: number): number | undefined {
  if (!indices?.length) return undefined;
  if (!detected?.length) return indices[0];
  let containing: number | undefined;
  let last: number | undefined;
  let next: number | undefined;
  for (const index of indices) {
    const chord = detected[index];
    if (!chord) continue;
    if (chord.start <= time && time < chord.end &&
      (containing === undefined || chord.start >= detected[containing].start)) containing = index;
    if (chord.start <= time) last = index;
    else if (next === undefined) next = index;
  }
  return containing ?? last ?? next ?? indices[0];
}

export function chordWordIndex(chord: ChordSegment, line: TimedSheetRow, anchors: LyricWordAnchor[]) {
  const onset = Math.max(chord.start, line.start);
  for (const [word, start, end] of anchors) {
    if (!Number.isInteger(word) || word < 0 || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) continue;
    if (onset >= start && onset < end) return word;
    // A chord struck just ahead of a sung word belongs over that word.
    if (start > onset && start - onset <= .18) return word;
  }
  return -1;
}

const pitchClasses: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function chordSignature(label: string): { pc: number; family: string } | null {
  const root = /^([A-G])([#b♯♭]?)/.exec(label);
  if (!root) return null;
  const accidental = root[2];
  const pc = (pitchClasses[root[1]] + (accidental === "b" || accidental === "♭" ? -1 : accidental ? 1 : 0) + 12) % 12;
  const rest = label.slice(root[0].length).toLowerCase().replace(/\/[a-g][#b♯♭]?$/, "").replace(/:/g, "");
  const family = rest.includes("sus") ? "sus" : rest.includes("dim") ? "dim" : rest.includes("aug") ? "aug"
    : /m(?!aj)/.test(rest) ? "min" : "maj";
  return { pc, family };
}
export type ChartSync = {
  transpose: number; matched: number; total: number;
  map: Record<string, number[]>;
  ranges: { row: number; start: number; end: number }[];
};
type ChartSymbol = { row: number; chord: number; pc: number; family: string };
type DetectedChord = { index: number; pc: number; family: string; start: number; end: number };
const LOOKAHEAD = 4;
const MAX_GAP_SEC = 10;
const MAX_SPAN_SEC = 40;
// A section occurrence may miss isolated symbols (passing chords, undetected onsets)
// but never two in a row, which would mean the walk slid into unrelated music.
function walkSection(symbols: ChartSymbol[], det: DetectedChord[], from: number, transpose: number) {
  type Pair = { key: string; orig: number; at: number };
  let best: { pairs: Pair[]; score: number } | null = null;
  const visit = (s: number, j: number, last: number | null, consecutiveMisses: number,
    pairs: Pair[], misses: number) => {
    if (s === symbols.length) {
      if (pairs.length < Math.min(3, symbols.length) || pairs.length / symbols.length < 0.75) return;
      const first = det[pairs[0].at], lastChord = det[pairs.at(-1)!.at];
      if (lastChord.start - first.start > MAX_SPAN_SEC) return;
      const score = pairs.length - misses * 0.1;
      if (!best || score > best.score) best = { pairs, score };
      return;
    }
    const symbol = symbols[s];
    const target = (symbol.pc + transpose) % 12;
    for (let k = j; k < Math.min(j + LOOKAHEAD, det.length); k++) {
      const chord = det[k];
      if (chord.pc !== target || chord.family !== symbol.family) continue;
      if (last !== null && chord.start - last > MAX_GAP_SEC) break;
      if (!pairs.length && k - from > 1) break;
      visit(s + 1, k + 1, chord.start, 0, [...pairs, { key: `${symbol.row}:${symbol.chord}`, orig: chord.index, at: k }], misses);
      break;
    }
    if (consecutiveMisses < 1) visit(s + 1, j, last, consecutiveMisses + 1, pairs, misses + 1);
  };
  visit(0, from, null, 0, [], 0);
  return best as { pairs: Pair[]; score: number } | null;
}
export function matchChartToDetected(rows: SongbookRow[], chords: ChordSegment[]): ChartSync | null {
  const detected: (DetectedChord | null)[] = chords.map((chord, index) => {
    const sig = chord.kind === "chord" ? chordSignature(chord.display) : null;
    return sig ? { index, ...sig, start: chord.start, end: chord.end } : null;
  });
  const det = detected.filter((chord): chord is DetectedChord => chord !== null);
  const sections: { symbols: ChartSymbol[] }[] = [];
  const chart: ChartSymbol[] = [];
  rows.forEach((row, rowIndex) => {
    if (row.section) { sections.push({ symbols: [] }); return; }
    if (!sections.length) sections.push({ symbols: [] });
    row.chords.forEach((chord, chordIndex) => {
      const sig = chordSignature(chord.label);
      if (!sig) return;
      const symbol = { row: rowIndex, chord: chordIndex, ...sig };
      sections.at(-1)!.symbols.push(symbol);
      chart.push(symbol);
    });
  });
  const usable = sections.filter(section => section.symbols.length);
  if (chart.length < 4 || !det.length || !usable.length) return null;
  let transposeBest = 0, transposeMatched = -1;
  for (let transpose = 0; transpose < 12; transpose++) {
    let pointer = 0, matched = 0;
    for (const item of chart) {
      const target = (item.pc + transpose) % 12;
      for (let j = pointer; j < Math.min(pointer + 8, detected.length); j++) {
        const sig = detected[j];
        if (sig && sig.pc === target && sig.family === item.family) { pointer = j + 1; matched++; break; }
      }
    }
    if (matched > transposeMatched) { transposeMatched = matched; transposeBest = transpose; }
  }
  const map: Record<string, number[]> = {};
  const ranges: { row: number; start: number; end: number }[] = [];
  let pointer = 0;
  while (pointer < det.length) {
    let best: { section: number; pairs: { key: string; orig: number; at: number }[]; score: number } | null = null;
    usable.forEach((section, sectionIndex) => {
      const walk = walkSection(section.symbols, det, pointer, transposeBest);
      if (walk && (!best || walk.score > best.score)) best = { section: sectionIndex, ...walk };
    });
    const occurrence = best as { section: number; pairs: { key: string; orig: number; at: number }[]; score: number } | null;
    if (!occurrence) { pointer++; continue; }
    const byRow = new Map<number, number[]>();
    for (const pair of occurrence.pairs) {
      (map[pair.key] ??= []).push(pair.orig);
      const row = Number(pair.key.split(":")[0]);
      byRow.set(row, [...(byRow.get(row) ?? []), pair.orig]);
    }
    const rowStarts = [...byRow.entries()].map(([row, indices]) => ({
      row, start: Math.min(...indices.map(index => chords[index].start)),
    })).sort((a, b) => a.start - b.start);
    const last = occurrence.pairs.at(-1)!.orig;
    rowStarts.forEach((entry, i) => ranges.push({
      row: entry.row, start: entry.start,
      end: i + 1 < rowStarts.length ? rowStarts[i + 1].start : chords[last].end,
    }));
    pointer = occurrence.pairs.at(-1)!.at + 1;
  }
  const matched = Object.keys(map).length;
  if (matched < 4 || matched / chart.length < 0.75) return null;
  return { transpose: transposeBest, matched, total: chart.length, map, ranges };
}
export function transposeSongbookChord(label: string, semitones: number) {
  if (!semitones || !Number.isInteger(semitones)) return label;
  const shift = (root: string, accidental: string) => {
    const flat = accidental === "b" || accidental === "♭";
    const notes = flat ? ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"]
      : ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const pitch = pitchClasses[root] + (flat ? -1 : accidental ? 1 : 0) + semitones;
    return notes[((pitch % 12) + 12) % 12];
  };
  return label.replace(/^([A-G])([#b♯♭]?)/, (_, root, accidental) => shift(root, accidental))
    .replace(/\/([A-G])([#b♯♭]?)$/, (_, root, accidental) => "/" + shift(root, accidental));
}
