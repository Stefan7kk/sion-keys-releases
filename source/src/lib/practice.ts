/** Practice names for chords. These change only what is printed, not the detected chord. */

const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];const PC: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};
const DEGREE = ["1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7"];
const ROMAN = ["I", "bII", "II", "bIII", "III", "IV", "bV", "V", "bVI", "VI", "bVII", "VII"];

export type NumberStyle = "off" | "nashville" | "roman";

export interface ChordParts {
  root: string;
  quality: string;
  bass?: string;
  colon: boolean;
}

export function prefersFlats(tonic: string | undefined): boolean {
  return !!tonic && tonic.includes("b");
}

export function pitchClass(name: string | undefined): number | null {
  if (!name) return null;
  return PC[name] ?? null;
}

export function splitChord(display: string): ChordParts | null {
  if (!display || display === "N.C.") return null;
  const match = /^([A-G](?:#|b)?)(?::([^/]+)|([^/]*))?(?:\/(.+))?$/.exec(display);
  if (!match || PC[match[1]] == null) return null;
  return { root: match[1], quality: match[2] ?? match[3] ?? "", bass: match[4], colon: match[2] != null };
}

function spell(pc: number, flats: boolean): string {
  return (flats ? FLAT : SHARP)[((pc % 12) + 12) % 12];
}

function joinChord(parts: ChordParts, root: string, bass?: string): string {
  let body: string;
  if (parts.colon) body = `${root}:${parts.quality || "maj"}`;
  else if (parts.quality === "maj") body = root;
  else body = `${root}${parts.quality}`;
  return bass ? `${body}/${bass}` : body;
}

/** The chord shape under a capo. Capo 0 leaves the name unchanged. */
export function capoShape(display: string, capo: number, flats: boolean): string {
  const frets = Math.max(0, Math.min(11, Math.round(capo) || 0));
  if (!frets) return display;
  const parts = splitChord(display);
  if (!parts) return display;
  const root = spell(PC[parts.root] - frets, flats);
  const bass = parts.bass && PC[parts.bass] != null ? spell(PC[parts.bass] - frets, flats) : parts.bass;
  return joinChord(parts, root, bass);
}

function minorQuality(quality: string): boolean {
  return quality === "m" || quality === "min" || quality === "m7" || quality === "min7" || /^m(?!aj)/.test(quality);
}

function qualitySuffix(quality: string, style: "nashville" | "roman"): string {
  if (!quality || quality === "maj" || quality === "min" || quality === "m") return "";
  if (quality === "min7" || quality === "m7") return style === "roman" ? "7" : "m7";
  return quality;
}

/** Number the sounding chord from the tonic. Capo does not move the 1. */
export function numberedChord(display: string, tonic: number, style: "nashville" | "roman"): string | null {
  const parts = splitChord(display);
  if (!parts || !Number.isFinite(tonic)) return null;
  const degree = (PC[parts.root] - tonic + 12) % 12;
  const minor = minorQuality(parts.quality);
  const suffix = qualitySuffix(parts.quality, style);
  let numeral = style === "roman" ? ROMAN[degree] : DEGREE[degree];
  if (style === "roman" && minor) numeral = numeral.toLowerCase();
  if (style === "nashville" && minor && !suffix.startsWith("m")) numeral += "m";
  let bass = "";
  if (parts.bass) {
    if (PC[parts.bass] != null) {
      const bassDegree = (PC[parts.bass] - tonic + 12) % 12;
      bass = "/" + (style === "roman" ? ROMAN[bassDegree] : DEGREE[bassDegree]);
    } else bass = `/${parts.bass}`;
  }
  return numeral + suffix + bass;
}

export function practiceName(display: string, capo: number, flats: boolean, tonic: number | null, style: NumberStyle): string {
  if (style !== "off" && tonic != null) {
    const numbered = numberedChord(display, tonic, style);
    if (numbered) return numbered;
  }
  return capoShape(display, capo, flats);
}

/**
 * Move a written chord to another key. Only the printed name changes; the
 * recording and its timestamps are untouched.
 */
export function transposeChordLabel(display: string, semitones: number, flats = false): string {
  if (!semitones || !Number.isInteger(semitones)) return display;
  if (display === "N.C.") return display;
  const shift = (root: string, accidental: string) => {
    // The accidental in the label carries its own pitch; the flat or sharp
    // array only decides how a plain root is spelled.
    const acc = accidental === "b" || accidental === "♭" ? -1 : accidental ? 1 : 0;
    const names = (accidental ? acc < 0 : flats) ? FLAT : SHARP;
    const pitch = (PC[root] ?? 0) + acc + semitones;
    return names[((pitch % 12) + 12) % 12];
  };
  return display
    .replace(/^([A-G])([#b♯♭]?)/, (_, root, accidental) => shift(root, accidental))
    .replace(/\/([A-G])([#b♯♭]?)$/, (_, root, accidental) => "/" + shift(root, accidental));
}

/** Move a key name to another key. */
export function transposeKeyName(tonic: string, semitones: number, flats = false): string {
  if (!semitones || !Number.isInteger(semitones)) return tonic;
  const names = flats ? FLAT : SHARP;
  const base = PC[tonic] ?? 0;
  return names[((base + semitones) % 12 + 12) % 12];
}
