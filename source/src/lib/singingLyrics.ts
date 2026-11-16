// The synced songbook chart is the user-requested default; singing-only mode stays available here.
export const LYRICS_ONLY_SHEET = false;

type SingingSection = { heading?: string; kind?: "Verse" | "Chorus" | "Section"; number?: number; lines: string[] };
const sectionName = /^(?:verse|chorus|refrain|bridge|pre[- ]?chorus|post[- ]?chorus|intro|outro|interlude|instrumental|solo|tag|coda|куплет|припев|бридж|въведение|финал|nakarat|kıta|köprü|giriş|çıkış|estrofa|estribillo|puente|verso|refrão|couplet|pont|strophe|приспів)(?:\s*\d+)?(?:\s*[:–-]\s*.+)?$/iu;
const shortNames: Record<string, string> = { V: "Verse", B: "Bridge", C: "Chorus", P: "Pre-chorus" };
const chordToken = "[A-G][#b♯♭]?(?::)?(?:maj|min|m|dim|aug|sus|add|hdim|ø|M)?\\d*(?:\\([^)]*\\))?(?:/(?:[A-G][#b♯♭]?|b?\\d+))?";
const inlineChord = new RegExp("\\[" + chordToken + "\\]", "g");
const chordRow = new RegExp("^" + chordToken + "(?:\\s+" + chordToken + ")*$");

function sectionHeading(line: string) {
  const marker = /^\[([^\]]+)\]$|^\(([^)]+)\)$/.exec(line);
  const title = (marker?.[1] ?? marker?.[2] ?? line).trim().replace(/:\s*$/, "");
  if (sectionName.test(title)) return title;
  const short = marker?.[1] && /^([VBCP])\s*(\d*)$/i.exec(title);
  return short ? [shortNames[short[1].toUpperCase()], short[2]].filter(Boolean).join(" ") : undefined;
}

export function hasLyricSectionLabels(text: string) {
  return text.split(/\r?\n/).some(line => sectionHeading(line.trim()) !== undefined);
}

const normalizeLine = (line: string) => line.normalize("NFC").toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();

function repeatedChorus(lines: string[]) {
  const normalized = lines.map(normalizeLine);
  let chorus = { length: 0, starts: [] as number[] };
  for (let length = 2; length <= 6; length++) {
    const groups = new Map<string, number[]>();
    for (let start = 0; start + length <= lines.length; start++) {
      const phrase = normalized.slice(start, start + length);
      if (phrase.includes("") || new Set(phrase).size < 2) continue;
      const signatures = [phrase.join("\n")];
      if (length >= 3) {
        phrase.forEach((line, index) => {
          const words = line.split(" ");
          if (words.length < 6) return;
          const edges = words.slice(0, 3).concat(words.at(-1)!).join(" ");
          signatures.push(phrase.map((part, i) => i === index ? "~" + edges : part).join("\n"));
        });
      }
      for (const signature of signatures) {
        const starts = groups.get(signature) ?? [];
        if (start >= (starts.at(-1) ?? -length) + length) starts.push(start);
        groups.set(signature, starts);
      }
    }
    for (const starts of groups.values()) {
      if (starts.length >= 2 && length * starts.length >= chorus.length * chorus.starts.length) {
        chorus = { length, starts };
      }
    }
  }
  return chorus;
}

export function prepareLyricLine(raw: string, stripManualChordRows: boolean): string | null {
  const line = raw.trim().replace(/^(?:\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\])+\s*/, "");
  if (!line || sectionHeading(line)) return line;
  if (stripManualChordRows && chordRow.test(line)) return null;
  return line.replace(inlineChord, "").trim();
}

export function singingLyrics(text: string, stripManualChordRows = false): SingingSection[] {
  const lines = text.split(/\r?\n/).flatMap(raw => {
    const line = prepareLyricLine(raw, stripManualChordRows);
    return line === null ? [] : [line];
  });

  const result: SingingSection[] = [];
  if (lines.some(sectionHeading)) {
    let section: SingingSection = { lines: [] };
    const finish = () => {
      while (section.lines.at(-1) === "") section.lines.pop();
      if (section.lines.length) result.push(section);
    };
    for (const line of lines) {
      const heading = sectionHeading(line);
      if (heading) {
        finish();
        section = { heading, lines: [] };
      } else if (line || section.lines.length) {
        section.lines.push(line);
      }
    }
    finish();
    return result;
  }

  const stanzas = lines.join("\n").split(/\n{2,}/).map(block => block.trim()).filter(Boolean)
    .map(block => block.split("\n"));
  const chorus = repeatedChorus(lines);
  if (stanzas.length > 1) {
    // Providers often keep stanzas but omit headings. Compare whole stanzas so
    // a changed pickup or ad-lib does not split the first line from its chorus.
    const normalized = stanzas.length <= 300 ? stanzas.map(stanza => stanza.map(normalizeLine)) : [];
    let repeatedStanzas: number[] = [];
    for (const stanza of normalized) {
      if (stanza.length < 2 || stanza.length > 8 || new Set(stanza).size < 2) continue;
      const matches = normalized.flatMap((other, i) => {
        const equalLines = other.filter((line, j) => line === stanza[j]).length;
        return other.length === stanza.length && equalLines >= Math.max(2, Math.ceil(stanza.length * .7)) ? [i] : [];
      });
      if (matches.length >= 2 && (matches.length > repeatedStanzas.length ||
        (matches.length === repeatedStanzas.length && matches[0] < repeatedStanzas[0]))) repeatedStanzas = matches;
    }
    let verse = 0;
    let section = 0;
    if (repeatedStanzas.length || !chorus.length) return stanzas.map((words, index) => {
      if (repeatedStanzas.includes(index)) return { kind: "Chorus", lines: words };
      const beforeChorus = index < repeatedStanzas[0] || (repeatedStanzas.includes(index - 1) && repeatedStanzas.includes(index + 1));
      if (beforeChorus && words.length >= 2 && words.length <= 8 && verse < 2)
        return { kind: "Verse", number: ++verse, lines: words };
      return { kind: "Section", number: ++section, lines: words };
    });
  }

  let verse = 0;
  let section = 0;
  const addStanzas = (start: number, end: number, beforeChorus: boolean) => {
    const stanzas = lines.slice(start, end).join("\n").split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
    for (const part of stanzas) {
      const words = part.split("\n");
      const probableVerse = beforeChorus && stanzas.length === 1 && words.length >= 2 && words.length <= 8 && verse < 2;
      result.push(probableVerse ? { kind: "Verse", number: ++verse, lines: words }
        : { kind: "Section", number: ++section, lines: words });
    }
  };
  let next = 0;
  for (const start of chorus.starts) {
    addStanzas(next, start, true);
    next = start + chorus.length;
    result.push({ kind: "Chorus", lines: lines.slice(start, next) });
  }
  addStanzas(next, lines.length, false);
  if (result.length === 1 && !chorus.length) return [{ lines: result[0].lines }];
  return result;
}

