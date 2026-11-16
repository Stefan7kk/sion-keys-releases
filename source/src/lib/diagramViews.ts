/** Suggested notation for a detected chord. These are playable readings, not transcriptions. */

const PC: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};
const INTERVALS: Record<string, number[]> = {
  "": [0, 4, 7], maj: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7],
  maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], min7: [0, 3, 7, 10], 7: [0, 4, 7, 10],
  maj9: [0, 4, 7, 11, 14], min9: [0, 3, 7, 10, 14], 9: [0, 4, 7, 10, 14],
  11: [0, 4, 7, 10, 14, 17], 13: [0, 4, 7, 10, 14, 17, 21],
  sus2: [0, 2, 7], sus4: [0, 5, 7], "sus4(b7)": [0, 5, 7, 10],
  aug: [0, 4, 8], dim: [0, 3, 6], dim7: [0, 3, 6, 9], hdim7: [0, 3, 6, 10],
};
const BASS_INTERVALS: Record<string, number> = { "2": 2, b3: 3, "3": 4, "5": 7, b7: 10 };
const SHARP_LETTER = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const FLAT_LETTER = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];
const SHARP_ACC = ["", "#", "", "#", "", "", "#", "", "#", "", "#", ""] as const;
const FLAT_ACC = ["", "b", "", "b", "", "", "b", "", "b", "", "b", ""] as const;
const F5 = 5 * 7 + 3;

export const GUITAR_STRINGS = ["E", "A", "D", "G", "B", "e"];
export const BASS_STRINGS = ["E", "A", "D", "G"];
export const TUNINGS = { Guitar: [40, 45, 50, 55, 59, 64], Bass: [28, 33, 38, 43] };

const voicingCache = new Map<string, number[] | null>();

/** Compact fingering for the chord. Frets are relative to the nut, or to a capo when the chord name was already capo-shaped. */
export function frettedVoicing(name: string, instrument: keyof typeof TUNINGS): number[] | null {
  const key = instrument + name;
  if (voicingCache.has(key)) return voicingCache.get(key)!;
  const chord = chordPitchClasses(name);
  if (!chord) return null;
  const tuning = TUNINGS[instrument];
  const tones = new Set(chord.notes.map(n => n % 12));
  tones.add(chord.bass);
  let best: number[] | null = null, bestScore = -Infinity;
  for (let base = 1; base <= 12; base++) {
    const choices = tuning.map(open => [-1, 0, base, base + 1, base + 2, base + 3]
      .filter(f => f < 0 || tones.has((open + f) % 12)));
    const visit = (frets: number[]) => {
      if (frets.length < tuning.length) {
        for (const fret of choices[frets.length]) visit([...frets, fret]);
        return;
      }
      const pitches = frets.flatMap((f, i) => f < 0 ? [] : [tuning[i] + f]);
      const covered = new Set(pitches.map(n => n % 12));
      if (covered.size < Math.min(3, tones.size) || Math.min(...pitches) % 12 !== chord.bass) return;
      const positive = frets.filter(f => f > 0);
      const lowest = Math.min(...positive);
      const first = frets.indexOf(lowest), last = frets.lastIndexOf(lowest);
      const canBarre = first >= 0 && frets.slice(first, last + 1).every(f => f >= lowest);
      const fingers = positive.filter(f => f !== lowest).length + (canBarre ? 1 : positive.filter(f => f === lowest).length);
      if (fingers > 4) return;
      const score = covered.size * 100 - (positive.length ? Math.max(...positive) : 0) * 2 - fingers * 2 + pitches.length;
      if (score > bestScore) { bestScore = score; best = frets; }
    };
    visit([]);
  }
  voicingCache.set(key, best);
  return best;
}

export interface FretboardPlan {
  /** Lowest-fret barre across at least four strings, when the shape supports one. */
  barre: { fret: number; first: number; last: number } | null;
  /** Suggested finger (1–4) per string; barre strings share finger 1. Null = open or muted. */
  fingers: (number | null)[];
}

/**
 * Suggested fingering for a fretted shape: the barre takes finger 1 and the
 * remaining fretted strings take 2–4 in ascending fret order. A teaching
 * suggestion, not something read off the recording.
 */
export function fretboardPlan(frets: number[]): FretboardPlan {
  const fingers: (number | null)[] = frets.map(() => null);
  const played = frets.map((f, i) => (f > 0 ? i : -1)).filter(i => i >= 0);
  let barre: FretboardPlan["barre"] = null;
  if (played.length) {
    const lowest = Math.min(...played.map(i => frets[i]));
    const first = frets.indexOf(lowest), last = frets.lastIndexOf(lowest);
    if (played.length >= 2 && last - first + 1 >= 4 && frets.slice(first, last + 1).every(f => f >= lowest)) {
      barre = { fret: lowest, first, last };
      for (let i = first; i <= last; i++) if (frets[i] === lowest) fingers[i] = 1;
    }
    let next = barre ? 2 : 1;
    const others = played.filter(i => fingers[i] == null).sort((a, b) => frets[a] - frets[b] || a - b);
    for (const i of others) {
      if (next > 4) break;
      fingers[i] = next++;
    }
  }
  return { barre, fingers };
}

export interface StaffTone {
  /** Diatonic steps below the treble F5 line. Higher notes are negative. */
  stepsBelowF5: number;
  accidental: "" | "#" | "b";
}

export interface TabString {
  name: string;
  fret: number | "x";
}

export function usesFlats(name: string): boolean {
  return /[b♭]/.test(name);
}

export function chordPitchClasses(name: string): { bass: number; notes: number[] } | null {
  const match = /^([A-G][#b]?):?([^/]*)(?:\/(.+))?$/.exec(name);
  if (!match) return null;
  const root = PC[match[1]];
  const intervals = INTERVALS[match[2]];
  const bass = match[3]
    ? PC[match[3]] ?? (BASS_INTERVALS[match[3]] != null ? (root + BASS_INTERVALS[match[3]]) % 12 : undefined)
    : root;
  if (root == null || !intervals || bass == null) return null;
  const notes = intervals.map(interval => (root + interval) % 12);
  return { bass, notes: [...new Set(notes)] };
}

/** Chord tones written in a comfortable treble register. Not a recorded performance. */
export function staffTones(name: string): StaffTone[] | null {
  const chord = chordPitchClasses(name);
  if (!chord) return null;
  const flats = usesFlats(name);
  const letters = flats ? FLAT_LETTER : SHARP_LETTER;
  const accidentals = flats ? FLAT_ACC : SHARP_ACC;
  const bass = chord.bass;
  const stacked = [...new Set([bass, ...chord.notes.map(note => bass + (note - bass + 24) % 12)])].sort((a, b) => a - b);
  return stacked.map(pitch => {
    const midi = pitch + 60;
    const pc = midi % 12;
    const octave = Math.floor(midi / 12) - 1;
    return { stepsBelowF5: F5 - (octave * 7 + letters[pc]), accidental: accidentals[pc] };
  });
}

/** High string first, matching ordinary tab. Frets stay relative to a capo. */
export function tabStrings(frets: number[] | null, namesLowToHigh: string[]): TabString[] | null {
  if (!frets || frets.length !== namesLowToHigh.length) return null;
  return frets.map((fret, index) => ({
    name: namesLowToHigh[index],
    fret: fret < 0 ? "x" as const : fret,
  })).reverse();
}
