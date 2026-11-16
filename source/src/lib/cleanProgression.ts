import type { ChordSegment } from "./types";
import { chordPitchClasses } from "./diagramViews.ts";
import { splitChord } from "./practice.ts";

const touches = (left: ChordSegment, right: ChordSegment) => Math.abs(left.end - right.start) < .001;
const ordinary = (chord: ChordSegment) => chord.kind === "chord" && chord.scoreKind !== "manual";
const QUALITY_ALIASES: Record<string, string> = { maj: "", min: "m", min7: "m7" };

function rootPosition(display: string): string {
  const parts = splitChord(display);
  if (!parts?.bass) return display;
  const pitches = chordPitchClasses(display);
  if (!pitches?.notes.includes(pitches.bass)) return display;

  return parts.root + (QUALITY_ALIASES[parts.quality] ?? parts.quality);
}

export function cleanProgression(chords: ChordSegment[], raw: ChordSegment[] = []): ChordSegment[] {
  const output: ChordSegment[] = [];
  let evidenceIndex = 0;
  for (let i = 0; i < chords.length; i++) {
    const source = chords[i];
    const display = ordinary(source) ? rootPosition(source.display) : source.display;
    const current = display === source.display ? source : { ...source, display };
    const previous = output.at(-1);
    const next = chords[i + 1];
    if (previous && ordinary(previous) && ordinary(current) && touches(previous, current)
      && previous.display === current.display) {
      output[output.length - 1] = { ...previous, end: current.end };
      continue;
    }
    if (previous && next && ordinary(previous) && ordinary(next) && previous.display === rootPosition(next.display)
      && touches(previous, current) && touches(current, next) && current.display !== "N.C."
      && current.kind === "uncertain" && current.scoreKind !== "manual"
      && current.end - current.start <= .30
      && previous.end - previous.start >= .36 && next.end - next.start >= .36) {
      while (evidenceIndex < raw.length && raw[evidenceIndex].end <= current.start) evidenceIndex++;
      const overlapping: ChordSegment[] = [];
      for (let j = evidenceIndex; j < raw.length && raw[j].start < current.end; j++) {
        if (raw[j].end > current.start) overlapping.push(raw[j]);
      }
      if (overlapping.some(ordinary)
        && overlapping.every(chord => rootPosition(chord.display) === previous.display
          && chord.kind !== "no_chord" && chord.scoreKind !== "manual")) {
        output[output.length - 1] = { ...previous, end: next.end };
        i++;
        continue;
      }
    }
    output.push(current);
  }
  return output;
}
