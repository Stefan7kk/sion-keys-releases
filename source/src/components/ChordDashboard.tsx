import { chordWordIndex, matchChartToDetected, timedSheetPosition, timedSheetRows, transposeSongbookChord, validLyricTiming, type LyricLine, type LyricTimingEdits, type LyricWordAnchor, type TimedSheetRow } from "../lib/lyrics";
import { songbookFromLyrics, chartToLead, formatLeadSheet, leadSheetChart, nextSectionTag, parseLeadSheet, SECTION_KINDS, sectionKind, sectionLabel, withInstrumentalRows, type InstrumentalSpan, type LeadLine } from "../lib/songbook";
import { LYRICS_ONLY_SHEET, prepareLyricLine, singingLyrics } from "../lib/singingLyrics";
import { lyricsIdentity, lyricsOperation, savedLyricsLanguage, type SmartLookup } from "../lib/smartLyrics";
import { LyricsControls, type LyricsAction, type LyricsControlsHandle } from "./LyricsControls";
import { SongbookChart } from "./SongbookChart";
import { languageDirection, languages, type Language } from "../lib/languages";
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { DailyVerse } from "./DailyVerse";
import type { AnalysisResult, AppStatus, ChordSegment } from "../lib/types";
import { isLikelyYoutubeUrl, youtubeVideoId } from "../lib/engine";
import { formatScore, formatTime } from "../lib/format";
import { visibleSummaryChords } from "../lib/summaryChords";
import { cleanProgression } from "../lib/cleanProgression";
import { actionForKey, chordShortcutStart, type ShortcutAction, type Shortcuts } from "../lib/shortcuts";
import { PLAYHEAD_LEAD_SECONDS, activeAt, chordLaneFrame, detailFrame, formatTimeFine, laneGaps, visibleLaneChords, visibleLaneSpan } from "../lib/timeline";
import { capoShape, pitchClass, practiceName, prefersFlats, transposeChordLabel, transposeKeyName, type NumberStyle } from "../lib/practice";
import { BASS_STRINGS, fretboardPlan, frettedVoicing, GUITAR_STRINGS, staffTones, tabStrings, TUNINGS } from "../lib/diagramViews";
import { clickGrouping, PracticeMetronome } from "../lib/practiceClick";
import { translate, localizedKey, localizeMessage, localizedKind, localizedScoreKind } from "../lib/i18n";
import { Icon } from "./Icon";
import { ChordWave } from "./ChordWave";
import { YoutubeInput } from "./YoutubeInput";
import { contributeLyrics, type LyricContribution, type LyricsVerification } from "../lib/sharedLibrary";

const NA = "—";
const EMPTY_CHORDS: ChordSegment[] = [];
const CHORD_MODE_KEY = "hearthkeys-chord-display";
type LibraryMatch = { id: string; title: string; plain: string; provider: string };
type GenerateResult = {
  state: string; language?: string; lines?: { at: number; end: number; text: string }[];
  words?: { text: string; at: number; end: number; probability?: number }[][];
  instrumentals?: InstrumentalSpan[];
  upgradedSaved?: boolean;
};
function generatedLyricBody(result: GenerateResult) {
  return result.lines?.map((line, index, lines) =>
    (result.language === "bg" && index > 0 && line.at - lines[index - 1].end >= 3 ? "\n" : "") + line.text).join("\n") ?? "";
}
const lyricDraftLines = (blocks: LeadLine[]) => blocks.map(block => block.text.trim())
  .filter(line => line && line !== "Solo");
const lyricDraftWords = (lines: string[]) => lines.join(" ").normalize().toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
const PC: Record<string, number> = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
type Instrument = "Piano" | "Guitar" | "Bass";
type DiagramView = "primary" | "secondary";
const DIAGRAM_VIEWS: Record<Instrument, readonly [string, string]> = {
  Piano: ["Keyboard", "Sheet Music"],
  Guitar: ["Chord Shapes", "Guitar TAB"],
  Bass: ["Fretboard", "Bass TAB"],
};
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5] as const;
type ShownChord = ChordSegment & { shape: string; printed: string };

const CHORD_INTERVALS: Record<string, number[]> = {
  "": [0, 4, 7], maj: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7],
  maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], min7: [0, 3, 7, 10], 7: [0, 4, 7, 10],
  maj9: [0, 4, 7, 11, 14], min9: [0, 3, 7, 10, 14], 9: [0, 4, 7, 10, 14],
  11: [0, 4, 7, 10, 14, 17], 13: [0, 4, 7, 10, 14, 17, 21],
  sus2: [0, 2, 7], sus4: [0, 5, 7], "sus4(b7)": [0, 5, 7, 10],
  aug: [0, 4, 8], dim: [0, 3, 6], dim7: [0, 3, 6, 9], hdim7: [0, 3, 6, 10],
};
const BASS_INTERVALS: Record<string, number> = { "2": 2, b3: 3, "3": 4, "5": 7, b7: 10 };
const SHARP_NOTES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLAT_NOTES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];

function chordNotes(name: string) {
  const match = /^([A-G][#b]?):?([^/]*)(?:\/(.+))?$/.exec(name);
  if (!match) return null;
  const root = PC[match[1]];
  const intervals = CHORD_INTERVALS[match[2]];
  const bass = match[3] ? PC[match[3]] ?? (BASS_INTERVALS[match[3]] != null ? (root + BASS_INTERVALS[match[3]]) % 12 : undefined) : root;
  if (root == null || !intervals || bass == null) return null;
  return { bass, notes: intervals.map(interval => {
    if (match[3]) {
      const pitch = (root + interval) % 12;
      return pitch < bass ? pitch + 12 : pitch;
    }
    return root + interval;
  }) };
}

function pianoPitches(chord: NonNullable<ReturnType<typeof chordNotes>>, bass: number) {
  return [...new Set([bass, ...chord.notes.map(note => bass + (note - bass + 24) % 12)])].sort((a, b) => a - b);
}

const WHITE_KEYS = [0, 2, 4, 5, 7, 9, 11];
const BLACK_KEYS = [1, 3, 6, 8, 10];
const PIANO_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/**
 * A keyboard drawn around the chord itself: the bass key is separated from the
 * chord tones and the notes are named, so the shape can be read at a glance.
 */
function PianoKeys({ name, language, bass }: { name: string; language: Language; bass?: number }) {
  const chord = chordNotes(name);
  if (!chord) return <span className="cd-na">{translate(language, "No voicing")}</span>;
  const root = bass ?? chord.bass;
  const pitches = pianoPitches(chord, root);
  const bottom = pitches[0];
  let start = bottom;
  while (!WHITE_KEYS.includes(start % 12)) start--;
  const whites: number[] = [];
  for (let pitch = start; whites.length < 8; pitch++) {
    if (WHITE_KEYS.includes(pitch % 12)) whites.push(pitch);
  }
  const keyWidth = 12;
  const whiteHeight = 54;
  const blackWidth = 7;
  const blackHeight = 34;
  const isBass = (pitch: number) => pitch === bottom;
  const isOn = (pitch: number) => pitches.includes(pitch);
  const label = (pitch: number) => PIANO_NOTE_NAMES[((pitch % 12) + 12) % 12];
  const width = whites.length * keyWidth;
  return <div className="cd-piano">
    <svg viewBox={`0 0 ${width} ${whiteHeight + 1}`} role="img"
      aria-label={translate(language, "{chord} piano chord", { chord: name })}>
      {whites.map((pitch, index) => {
        const on = isOn(pitch);
        const bass = on && isBass(pitch);
        return <g key={pitch}>
          <rect x={index * keyWidth} y="0" width={keyWidth} height={whiteHeight} rx="2.5"
            fill={on ? (bass ? "var(--c-accent)" : "var(--c-accent-2)") : "#f7fafd"}
            stroke="var(--piano-outline, #193149)" strokeWidth="1" />
          {on && <text x={index * keyWidth + keyWidth / 2} y={whiteHeight - 5} textAnchor="middle"
            fontSize="9" fontWeight="800" fill={bass ? "var(--piano-bass-fg, #06263a)" : "var(--piano-on-fg, #06263a)"}>{label(pitch)}</text>}
        </g>;
      })}
      {whites.flatMap((pitch, index) => {
        const next = whites[index + 1];
        if (next === undefined) return [];
        const between = pitch + 1;
        if (!BLACK_KEYS.includes(((between % 12) + 12) % 12)) return [];
        const on = isOn(between);
        const bass = on && isBass(between);
        return [<g key={`b${between}`}>
          <rect x={(index + 1) * keyWidth - blackWidth / 2} y="0" width={blackWidth} height={blackHeight} rx="2"
            fill={on ? (bass ? "var(--c-accent)" : "var(--c-accent-2)") : "#20344c"}
            stroke="var(--piano-outline, #193149)" strokeWidth="1" />
        </g>];
      })}
      <rect x="0" y={whiteHeight - 1.5} width={width} height="2" fill="var(--piano-outline, #193149)" opacity=".55" />
    </svg>
  </div>;
}

function parseChord(display: string) {
  const m = /^([A-G][#b]?)(.*)$/.exec(display);
  if (!m) return null;
  const q = m[2];
  return { root: m[1], pc: PC[m[1]], minor: q === "m" || q === "m7" };
}

function clock(sec: number | undefined) {
  if (sec == null || !Number.isFinite(sec)) return NA;
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/** Colour only: minor = teal, major on the key's 4th degree = green, other major = blue. */
function chordTone(seg: Pick<ChordSegment, "display" | "kind"> & { shape?: string }, keyPc: number | null) {
  const p = parseChord(seg.shape ?? seg.display);
  const base = !p ? "nc" : p.minor ? "teal" : keyPc != null && (p.pc - keyPc + 12) % 12 === 5 ? "green" : "blue";
  return seg.kind === "uncertain" ? `${base} unsure` : base;
}

function chordText(seg: ChordSegment & { printed?: string }) {
  const name = seg.printed ?? seg.display;
  if (seg.kind === "uncertain") return name === "N.C." ? "?" : `${name}?`;
  return name;
}

type DetectedChord = { display: string; shape: string; kind: "chord" | "uncertain" };

function DetectedChordsCard({ chords, keyPc, language, onMore }: {
  chords: DetectedChord[]; keyPc: number | null; language: Language; onMore: (chord: string) => void;
}) {
  const t = (key: string) => translate(language, key);
  const viewport = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const moreProbe = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(0);
  const number = useMemo(() => new Intl.NumberFormat(language), [language]);
  const moreLabel = (count: number) => translate(language, "+{n} more", { n: number.format(count) });
  const hidden = chords.length - visible;
  const direction = languageDirection(language);
  useLayoutEffect(() => {
    const box = viewport.current;
    const items = probe.current;
    const moreItems = moreProbe.current;
    if (!box || !items || !moreItems) return;
    const measure = () => {
      const width = box.getBoundingClientRect().width;
      const gap = Number.parseFloat(getComputedStyle(box).columnGap) || 0;
      const widths = Array.from(items.children, el => el.getBoundingClientRect().width);
      const moreWidths = [0, ...Array.from(moreItems.children, el => el.getBoundingClientRect().width)];
      const pillHeight = items.firstElementChild?.getBoundingClientRect().height ?? 0;
      const rows = box.clientHeight + .5 >= 2 * pillHeight + gap ? 2 : 1;
      setVisible(visibleSummaryChords(widths, moreWidths, width, gap, rows));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(items);
    observer.observe(moreItems);
    return () => observer.disconnect();
  }, [chords, language]);

  const pill = (chord: DetectedChord) => <span className={`cd-summary-pill ${chordTone(chord, keyPc)}`}
    data-tone={(parseChord(chord.shape)?.pc ?? 0) % 7} key={chord.display} dir="ltr">
    {chord.display}{chord.kind === "uncertain" ? "?" : ""}
  </span>;
  return <div className="cd-card cd-detected" dir={direction}>
    <h3><Icon name="sheet" size={21} /><span dir="auto">{t("Detected chords")} <small>{t("(in song)")}</small></span></h3>
    <div className="cd-summary-pills" ref={viewport}>
      {chords.slice(0, visible).map(pill)}
      {hidden > 0 && <button type="button" className="cd-summary-pill cd-summary-more" dir="auto" aria-haspopup="dialog"
        onClick={() => onMore(chords[visible].display)}>{moreLabel(hidden)}</button>}
      {!chords.length && <span className="cd-na">{NA}</span>}
    </div>
    <div className="cd-summary-measure" aria-hidden="true">
      <div ref={probe}>{chords.map(pill)}</div>
      <div ref={moreProbe}>{chords.map((chord, index) => <span className="cd-summary-pill cd-summary-more" dir="auto" key={chord.display}>{moreLabel(index + 1)}</span>)}</div>
    </div>
  </div>;
}

function segTitle(seg: ChordSegment, language: Language) {
  const what = localizedKind(language, seg.kind);
  const score = seg.score == null ? NA : seg.score.toFixed(2);
  return `${chordText(seg)} · ${formatTime(seg.start)}–${formatTime(seg.end)} · ${what} · ${localizedScoreKind(language, seg.scoreKind)} ${score} (${seg.kind}; ${seg.scoreKind})`;
}

const TICK_SECONDS = 2;
/** A readable detail view; the waveform above remains a whole-song seek overview. */
function ChordTrack({ chords, dur, time: committedTime, canPlay, playing, keyPc, onSeek, language, readTime, watchClock, compactPlayer }: {
  chords: ChordSegment[]; dur: number; time: number;
  language: Language; canPlay: boolean; playing: boolean; keyPc: number | null; onSeek: (time: number) => void;
  readTime: ChordDashboardProps["readTime"]; watchClock: ChordDashboardProps["watchClock"];
  compactPlayer?: boolean;
}) {
  const t = (key: string, params?: Record<string, string | number>) => translate(language, key, params);
  const [width, setWidth] = useState(0);
  const [playbackTime, setPlaybackTime] = useState(committedTime);
  const clock = useRef({ readTime, watchClock });
  clock.current = { readTime, watchClock };
  useLayoutEffect(() => {
    if (!canPlay || !playing) return;
    setPlaybackTime(clock.current.readTime());
    return clock.current.watchClock(setPlaybackTime);
  }, [canPlay, playing]);
  const time = canPlay && playing ? playbackTime : committedTime;
  const lane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = lane.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const { frame, active, next } = chordLaneFrame(chords, time, dur);
  const start = frame.windowStart;
  const windowSec = frame.windowSec;
  const end = start + windowSec;
  const rolling = start > 0 && Math.abs(start - (frame.t - PLAYHEAD_LEAD_SECONDS)) < 1e-6;
  const laneActive = canPlay ? active : null;
  const previousFrame = useRef({ chords, active: laneActive, time, playing: false });
  const [impact, setImpact] = useState<number | null>(null);

  useEffect(() => {
    const previous = previousFrame.current;
    previousFrame.current = { chords, active: laneActive, time, playing: canPlay && playing };
    if (!canPlay || !playing || !previous.playing || previous.chords !== chords || time < previous.time || time - previous.time > .25) {
      setImpact(null);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (laneActive?.kind === "chord" && laneActive.label !== previous.active?.label
      && laneActive.start > previous.time && laneActive.start <= time) {
      setImpact(laneActive.start);
    }
  }, [laneActive, canPlay, chords, playing, time]);

  const chordAtEdge = playing && canPlay && rolling && activeAt(chords, start)?.kind === "chord";
  const visible = visibleLaneChords(chords, start, end);
  // Any part of the window the detector did not label is drawn as an explicit
  // strip. A blank hole read as a chord that failed to render.
  const gaps = chords.length ? laneGaps(visible, start, Math.min(end, dur)) : [];
  const nextSpan = next && visibleLaneSpan(next, frame);
  const activeSpan = laneActive && visibleLaneSpan(laneActive, frame);
  const previewCurrent = !!activeSpan && activeSpan.width * width / 100 < 75;
  const previewNext = !!next && (!nextSpan || nextSpan.width * width / 100 < 75);
  const ticks: number[] = [];
  for (let tick = Math.max(0, Math.floor(start / TICK_SECONDS) * TICK_SECONDS); tick <= Math.min(dur, end); tick += TICK_SECONDS) {
    if (dur > 0 && tick >= start) ticks.push(tick);
  }
  const playheadPct = (frame.t - start) / windowSec * 100;
  const place = (at: number) => (at - start) / windowSec * 100;
  return <div className="cd-chord-track">
    <div className="cd-ruler">
      <div className="cd-ruler-strip">
        {ticks.filter(tick => tick === 0 || (place(tick) >= 2 && place(tick) <= 97)).map(tick => {
          const current = tick <= frame.t && frame.t < tick + TICK_SECONDS;
          const className = [tick === 0 && "first", current && "cd-ruler-now"].filter(Boolean).join(" ");
          return <span key={tick} data-tick={tick} className={className} style={{ left: `${place(tick)}%` }}>
            {formatTime(tick)}
          </span>;
        })}
      </div>
    </div>
    <div className="cd-segs cd-roll-lane" ref={lane}
      data-time={frame.t} data-window-start={start} data-window-sec={windowSec} data-playhead-x={width > 0 ? (frame.t - start) / windowSec * width : 0}
      style={{ "--roll-head": `${playheadPct}%` } as React.CSSProperties}>
      <div className="cd-roll-strip">
        {gaps.map(gap => {
          const span = visibleLaneSpan(gap, frame);
          return span && <span key={gap.start} className="cd-gap" data-gap-start={gap.start} data-gap-end={gap.end}
            title={t("Unavailable")} aria-hidden="true" style={{ left: span.left + "%", width: span.width + "%" }}>
            {span.width * width / 100 >= 24 ? NA : null}
          </span>;
        })}
        {visible.map(chord => {
          const span = visibleLaneSpan(chord, frame);
          if (!span) return null;
          const px = span.width * width / 100;
          const compact = px < 16;
          const onClock = laneActive === chord;
          const title = segTitle(chord, language);
          return <button type="button" key={chord.start + ":" + chord.end} data-start={chord.start} data-end={chord.end} title={title}
            aria-label={title} disabled={!canPlay} aria-current={onClock}
            onClick={() => onSeek(chord.start)}
            className={"cd-chip " + chordTone(chord, keyPc) + (onClock ? " current" : "") + (compact ? " compact" : "")}
            style={{ left: span.left + "%", width: span.width + "%" }}>
            {!compact && <span className="cd-roll-label" dir="ltr">{chordText(chord)}</span>}
          </button>;
        })}
      </div>
      {!chords.length && <span className="cd-na">{NA}</span>}
      {canPlay && <i className="cd-playhead cd-chord-playhead" style={{ left: `${playheadPct}%` }} aria-hidden="true" />}
      {playing && impact !== null && <span className="cd-roll-glow" key={impact} aria-hidden="true"
        onAnimationEnd={() => setImpact(current => current === impact ? null : current)} />}
      {playing && canPlay && <span className="cd-edge-impact" data-active={chordAtEdge} aria-hidden="true" />}
    </div>
    {!compactPlayer && <><div className="cd-scrubber">
      <span aria-hidden="true">{t("Seek")}</span>
      <input className="cd-track-scroll" type="range" aria-label={t("Seek song")}
        aria-valuetext={t("{current} of {total}", { current: formatTime(time), total: formatTime(dur) })}
        min={0} max={dur} step={0.01} value={Math.min(dur, Math.max(0, time))}
        disabled={!canPlay || dur <= 0}
        style={{ "--track-fill": `${dur > 0 ? Math.min(100, Math.max(0, time / dur * 100)) : 0}%` } as React.CSSProperties}
        onChange={event => onSeek(event.currentTarget.valueAsNumber)} />
    </div>
    <small className="cd-track-hint" dir="auto" data-preview={previewCurrent || previewNext}>
      {previewCurrent && laneActive && <><strong>{t("Current")} · {chordText(laneActive)}</strong>{"  ·  "}</>}
      {next ? <strong>{t("Next: {chord} at {time}", { chord: chordText(next), time: formatTimeFine(next.start) })}</strong> : laneActive ? t("No further chord changes") : NA}
    </small></>}
  </div>;
}

function prettyChord(name: string) {
  return name.replace(":maj", "maj").replace(":min", "m").replace(":", "");
}

function diagramNoteKey(instrument: Instrument, view: DiagramView) {
  if (view === "primary") return "Suggested voicings · not transcribed fingerings";
  return instrument === "Piano"
    ? "Chord tones on a staff. This is not a transcription of the recording."
    : "Suggested tab from the chord. This is not a transcription of the recording.";
}

function StaffNotes({ name, language }: { name: string; language: Language }) {
  const t = (key: string, params?: Record<string, string | number>) => translate(language, key, params);
  const tones = staffTones(name);
  if (!tones) return <span className="cd-na">{t("No playable shape")}</span>;
  const step = 3.15;
  const y = (stepsBelow: number) => 12 + stepsBelow * step;
  const placed = tones.map((tone, index) => {
    const previous = tones[index - 1];
    const beside = previous != null && Math.abs(previous.stepsBelowF5 - tone.stepsBelowF5) <= 1 && index % 2 === 1;
    return { ...tone, x: beside ? 62 : 50 };
  });
  const ledgers: number[] = [];
  for (const tone of tones) {
    if (tone.stepsBelowF5 < 0) for (let s = -2; s >= tone.stepsBelowF5; s -= 2) ledgers.push(s);
    if (tone.stepsBelowF5 > 8) for (let s = 10; s <= tone.stepsBelowF5; s += 2) ledgers.push(s);
  }
  return <svg className="cd-staff" viewBox="0 0 92 78" role="img" aria-label={t("{chord} piano staff", { chord: name })}>
    <text className="cd-clef" x="4" y="40">𝄞</text>
    {[0, 2, 4, 6, 8].map(s => <line key={s} x1="24" y1={y(s)} x2="86" y2={y(s)} stroke="currentColor" strokeWidth="0.8" opacity=".8" />)}
    {[...new Set(ledgers)].map(s => <line key={"l" + s} x1="42" y1={y(s)} x2="70" y2={y(s)} stroke="currentColor" strokeWidth="0.8" />)}
    {placed.map((tone, index) => <g key={index}>
      {tone.accidental && <text x={tone.x - 13} y={y(tone.stepsBelowF5) + 2.6} fontSize="9" fill="currentColor">{tone.accidental === "#" ? "♯" : "♭"}</text>}
      <ellipse cx={tone.x} cy={y(tone.stepsBelowF5)} rx="4.4" ry="3.1" fill="currentColor" />
    </g>)}
  </svg>;
}

function TabNotes({ name, frets, instrument, capo, language }: {
  name: string; frets: number[] | null; instrument: Exclude<Instrument, "Piano">; capo: number; language: Language;
}) {
  const t = (key: string, params?: Record<string, string | number>) => translate(language, key, params);
  const rows = tabStrings(frets, instrument === "Guitar" ? GUITAR_STRINGS : BASS_STRINGS);
  if (!rows) return <span className="cd-na">{t("No playable shape")}</span>;
  const gap = instrument === "Bass" ? 12 : 9;
  const top = capo > 0 ? 16 : 8;
  const height = top + gap * (rows.length - 1) + 10;
  return <svg className="cd-tab" viewBox={`0 0 92 ${height}`} role="img"
    aria-label={instrument === "Guitar" ? t("{chord} guitar tab", { chord: name }) : t("{chord} bass tab", { chord: name })}>
    {capo > 0 && <text x="4" y="9" fontSize="7" fill="currentColor">{t("Capo {n}", { n: capo })}</text>}
    {rows.map((row, index) => {
      const line = top + index * gap;
      return <g key={row.name + index}>
        <text x="2" y={line + 2.4} fontSize="7" fill="currentColor">{row.name}</text>
        <line x1="16" y1={line} x2="88" y2={line} stroke="currentColor" strokeWidth="0.7" opacity=".55" />
        <text x="50" y={line - 1.4} textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor">{row.fret}</text>
      </g>;
    })}
  </svg>;
}

function Diagram({ name, label, caption, active, sheetPosition, instrument, language, onExplore, bass, view = "primary", capo = 0 }: {
  name: string; label?: string; caption?: string; active?: boolean; instrument: Instrument; language: Language;
  onExplore?: () => void; bass?: number; view?: DiagramView; capo?: number;
  sheetPosition?: "current" | "next";
}) {
  const t = (key: string, params?: Record<string, string | number>) => translate(language, key, params);
  const v = instrument === "Piano" ? null : frettedVoicing(name, instrument);
  const chord = chordNotes(name);
  const tuning = instrument === "Piano" ? [] : TUNINGS[instrument];
  const covered = new Set(v?.flatMap((f, i) => f < 0 ? [] : [(tuning[i] + f) % 12]));
  const reduced = chord && v && chord.notes.some(n => !covered.has(n % 12));
  const fretted = v?.filter((f) => f > 0) ?? [];
  const base = fretted.length && Math.max(...fretted) > 4 ? Math.min(...fretted) : 1;
  const barreInfo = (() => {
    if (!v) return null;
    const played = v.map((f, i) => (f > 0 ? i : -1)).filter((i) => i >= 0);
    if (played.length < 2) return null;
    const lo = played[0], hi = played[played.length - 1];
    for (let fret = base; fret <= Math.max(...v); fret++) {
      const idx = v.map((f, i) => (f === fret ? i : -1)).filter((i) => i >= 0);
      if (idx.length < 2 || idx[0] !== lo || idx[idx.length - 1] !== hi || hi - lo + 1 < 4) continue;
      if (v.slice(lo, hi + 1).every((f) => f >= fret)) return { fret, idx };
    }
    return null;
  })();
  const x = (i: number) => 16 + i * 64 / ((v?.length ?? 6) - 1), y = (f: number) => 27.75 + (f - base) * 15.5;
  const Container = onExplore ? "button" : "div";
  const positionLabel = sheetPosition && t(sheetPosition === "current" ? "Current chord" : "Next chord");
  const picture = instrument === "Piano"
    ? view === "secondary" ? <StaffNotes name={name} language={language} /> : <PianoKeys name={name} language={language} bass={bass} />
    : view === "secondary" ? <TabNotes name={name} frets={v} instrument={instrument} capo={capo} language={language} />
      : v ? (
        <svg viewBox="0 0 96 102" role="img" aria-label={instrument === "Guitar" ? t("{chord} guitar chord", { chord: name }) : t("{chord} bass chord", { chord: name })}>
          <rect x="8" y="16" width="80" height="82" rx="5" fill="var(--diagram-board, #14263c)" />
          {v.map((f, i) => f > 0 ? null : (
            <g key={"i" + i} stroke="var(--diagram-indicator, #8b9bb3)" strokeWidth="2" strokeLinecap="round" fill="none">
              {f === 0
                ? <circle cx={x(i)} cy="8" r="4" />
                : <path d={`M${x(i) - 3.6} 4.4 L${x(i) + 3.6} 11.6 M${x(i) + 3.6} 4.4 L${x(i) - 3.6} 11.6`} />}
            </g>
          ))}
          {base === 1
            ? <rect x="8" y="16" width="80" height="4" rx="2" fill="var(--diagram-marker, #f4f8ff)" />
            : <text x="4" y="31" fontSize="8" fontWeight="700" textAnchor="middle" fill="var(--diagram-indicator, #8b9bb3)">{base}</text>}
          {[0, 1, 2, 3, 4, 5].map((i) => <line key={"f" + i} x1="8" y1={20 + i * 15.5} x2="88" y2={20 + i * 15.5} stroke="var(--diagram-line, #9db4cc)" strokeWidth="1.3" opacity=".8" />)}
          {v.map((_, i) => <line key={"s" + i} x1={x(i)} y1="20" x2={x(i)} y2="97.5" stroke="var(--diagram-line, #9db4cc)" strokeWidth={i === 0 ? 1.8 : 1.2} opacity=".9" />)}
          {barreInfo && <rect x={x(barreInfo.idx[0]) - 6.5} y={y(barreInfo.fret) - 6.25} width={x(barreInfo.idx[barreInfo.idx.length - 1]) - x(barreInfo.idx[0]) + 13} height="12.5" rx="6.25"
            fill="var(--diagram-marker, #f4f8ff)" stroke="var(--diagram-board, #14263c)" strokeWidth="1.5" />}
          {v.map((f, i) =>
            f > 0 ? <g key={i}>
              <circle cx={x(i)} cy={y(f)} r="6.8" fill="var(--diagram-marker, #f4f8ff)" stroke="var(--diagram-board, #14263c)" strokeWidth="1.5" />
              <text x={x(i)} y={y(f) + 3.1} textAnchor="middle" fontSize="8.6" fontWeight="800" fill="var(--diagram-marker-fg, #102033)">{f}</text>
            </g>
              : null)}
        </svg>
      ) : <span className="cd-na">{t("No playable shape")}</span>;
  return (
    <Container type={onExplore ? "button" : undefined} onClick={onExplore} data-diagram-position={sheetPosition}
      role={positionLabel && !onExplore ? "group" : undefined}
      aria-label={positionLabel ? `${positionLabel}: ${label ?? prettyChord(name)}` : undefined}
      aria-current={sheetPosition === "current" || undefined}
      className={"cd-diagram" + (instrument === "Piano" && view === "primary" ? " piano" : "") + (view === "secondary" ? " alt" : "") + (active ? " active" : "")}>
      {caption && <small className="cd-diagram-position">{caption}</small>}
      <strong title={label ?? name}>
        {sheetPosition && <span className="cd-diagram-marker">
          <Icon name="play" size={12} />
          {sheetPosition === "next" && <Icon name="play" size={12} />}
        </span>}
        {sheetPosition ? <bdi dir="ltr">{label ?? prettyChord(name)}</bdi> : label ?? prettyChord(name)}
      </strong>
      <span className="cd-diagram-art">{picture}</span>
      {reduced && view === "primary" && !onExplore && <small className="cd-diagram-position">{t("REDUCED VOICING")}</small>}
    </Container>
  );
}

/** Large suggested fretboard for the library: X/O, dots, fingers, frets and barres. */
function LibraryFretboard({ name, instrument, language }: {
  name: string; instrument: Exclude<Instrument, "Piano">; language: Language;
}) {
  const t = (key: string, params?: Record<string, string | number>) => translate(language, key, params);
  const v = frettedVoicing(name, instrument);
  const chord = chordNotes(name);
  if (!v || !chord) return <span className="cd-na">{t("No playable shape")}</span>;
  const plan = fretboardPlan(v);
  const fretted = v.filter(f => f > 0);
  const base = fretted.length && Math.max(...fretted) > 4 ? Math.min(...fretted) : 1;
  const sp = 26;
  const left = (192 - (v.length - 1) * sp) / 2;
  const xs = v.map((_, i) => left + i * sp);
  const rowH = 40, top = 48, rows = 5;
  const boardX = xs[0] - 14, boardW = xs[xs.length - 1] - xs[0] + 28;
  const height = top + rows * rowH + 8;
  const inBarre = (i: number) => !!plan.barre && plan.barre.first <= i && i <= plan.barre.last && v[i] === plan.barre.fret;
  const names = instrument === "Guitar" ? GUITAR_STRINGS : BASS_STRINGS;
  return <svg className="cd-lib-fret" viewBox={`0 0 192 ${height}`} role="img"
    aria-label={instrument === "Guitar" ? t("{chord} guitar chord", { chord: name }) : t("{chord} bass chord", { chord: name })}>
    {names.map((s, i) => <text key={s + i} x={xs[i]} y="12" textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--diagram-indicator)">{s}</text>)}
    <rect x={boardX} y="38" width={boardW} height={height - 40} rx="6" fill="var(--diagram-board, #14263c)" />
    {v.map((f, i) => f !== 0 ? null : (
      <circle key={"o" + i} cx={xs[i]} cy="29" r="5.5" fill="none" stroke="var(--diagram-indicator)" strokeWidth="2.2" />
    ))}
    {v.map((f, i) => f >= 0 ? null : (
      <path key={"x" + i} d={`M${xs[i] - 5} 24 L${xs[i] + 5} 34 M${xs[i] + 5} 24 L${xs[i] - 5} 34`}
        stroke="var(--diagram-indicator)" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    ))}
    {base === 1
      ? <rect x={boardX} y="43" width={boardW} height="5" rx="2.5" fill="var(--diagram-marker, #f4f8ff)" />
      : <text x={xs[0] - 17} y="58" textAnchor="end" fontSize="13" fontWeight="800" fill="var(--diagram-indicator)">{base}</text>}
    {Array.from({ length: rows + 1 }, (_, i) => (
      <line key={"f" + i} x1={boardX + 2} y1={top + i * rowH} x2={boardX + boardW - 2} y2={top + i * rowH}
        stroke="var(--diagram-line, #9db4cc)" strokeWidth="1.8" opacity=".85" />
    ))}
    {xs.map((x, i) => <line key={"s" + i} x1={x} y1={top} x2={x} y2={top + rows * rowH}
      stroke="var(--diagram-line, #9db4cc)" strokeWidth={i === 0 ? 2.4 : 1.6} opacity=".9" />)}
    {plan.barre && (() => {
      const y = top + (plan.barre.fret - base) * rowH + rowH / 2;
      return <g>
        <rect x={xs[plan.barre.first] - 9} y={y - 8} width={xs[plan.barre.last] - xs[plan.barre.first] + 18} height="16" rx="8"
          fill="var(--diagram-marker, #f4f8ff)" stroke="var(--diagram-board, #14263c)" strokeWidth="1.5" />
        <text x={(xs[plan.barre.first] + xs[plan.barre.last]) / 2} y={y + 4} textAnchor="middle" fontSize="12" fontWeight="800"
          fill="var(--diagram-marker-fg, #102033)">1</text>
      </g>;
    })()}
    {v.map((f, i) => f > 0 && !inBarre(i) ? (
      <g key={i}>
        <circle cx={xs[i]} cy={top + (f - base) * rowH + rowH / 2} r="9.5"
          fill="var(--diagram-marker, #f4f8ff)" stroke="var(--diagram-board, #14263c)" strokeWidth="1.5" />
        <text x={xs[i]} y={top + (f - base) * rowH + rowH / 2 + 4} textAnchor="middle" fontSize="12" fontWeight="800"
          fill="var(--diagram-marker-fg, #102033)">{plan.fingers[i] ?? f}</text>
      </g>
    ) : null)}
  </svg>;
}

/** Large six/four-line tablature in the standard tuning, read from the same shape. */
function LibraryTab({ name, instrument, capo, language }: {
  name: string; instrument: Exclude<Instrument, "Piano">; capo: number; language: Language;
}) {
  const t = (key: string, params?: Record<string, string | number>) => translate(language, key, params);
  const v = frettedVoicing(name, instrument);
  const rows = tabStrings(v, instrument === "Guitar" ? GUITAR_STRINGS : BASS_STRINGS);
  if (!rows) return <span className="cd-na">{t("No playable shape")}</span>;
  const gap = instrument === "Guitar" ? 26 : 30;
  const top = 34;
  const height = top + gap * (rows.length - 1) + 26;
  return <svg className="cd-lib-tab" viewBox={`0 0 320 ${height}`} role="img"
    aria-label={instrument === "Guitar" ? t("{chord} guitar tab", { chord: name }) : t("{chord} bass tab", { chord: name })}>
    {capo > 0 && <text x="6" y="14" fontSize="12" fontWeight="650" fill="var(--c-muted)">{t("Capo {n}", { n: capo })}</text>}
    {rows.map((row, index) => {
      const line = top + index * gap;
      return <g key={row.name + index}>
        <text x="6" y={line + 5} fontSize="14" fontWeight="700" fill="var(--c-muted)">{row.name}</text>
        <line x1="38" y1={line} x2="314" y2={line} stroke="var(--c-muted)" strokeWidth={instrument === "Bass" ? 2 : 1.5} opacity=".55" />
        {row.fret === "x"
          ? <text x="176" y={line + 5} textAnchor="middle" dominantBaseline="central" fontSize="15" fontWeight="700"
            fill="var(--c-muted)" stroke="var(--c-surface)" strokeWidth="4" paintOrder="stroke">×</text>
          : <text x="176" y={line + 5} textAnchor="middle" dominantBaseline="central" fontSize="17" fontWeight="800"
            fill="var(--c-text)" stroke="var(--c-surface)" strokeWidth="4" paintOrder="stroke">{row.fret}</text>}
      </g>;
    })}
  </svg>;
}

/** Large five-line staff of the chord tones, with accidentals and ledger lines. */
function LibraryStaff({ name, language }: { name: string; language: Language }) {
  const t = (key: string, params?: Record<string, string | number>) => translate(language, key, params);
  const tones = staffTones(name);
  if (!tones) return <span className="cd-na">{t("No playable shape")}</span>;
  const y = (s: number) => 40 + s * 9.5;
  const placed = tones.map((tone, index) => {
    const previous = tones[index - 1];
    const beside = previous != null && Math.abs(previous.stepsBelowF5 - tone.stepsBelowF5) <= 1 && index % 2 === 1;
    return { ...tone, x: beside ? 205 : 170 };
  });
  const ledgers: number[] = [];
  for (const tone of tones) {
    if (tone.stepsBelowF5 < 0) for (let s = -2; s >= tone.stepsBelowF5; s -= 2) ledgers.push(s);
    if (tone.stepsBelowF5 > 8) for (let s = 10; s <= tone.stepsBelowF5; s += 2) ledgers.push(s);
  }
  return <svg className="cd-lib-staff" viewBox="0 0 300 150" role="img" aria-label={t("{chord} piano staff", { chord: name })}>
    <text x="12" y="124" fontSize="66">𝄞</text>
    {[0, 2, 4, 6, 8].map(s => <line key={s} x1="72" y1={y(s)} x2="290" y2={y(s)} stroke="currentColor" strokeWidth="1.1" opacity=".85" />)}
    <line x1="290" y1={y(0) - 5} x2="290" y2={y(8) + 5} stroke="currentColor" strokeWidth="1.4" />
    {[...new Set(ledgers)].map(s => <line key={"l" + s} x1="152" y1={y(s)} x2="228" y2={y(s)} stroke="currentColor" strokeWidth="1.1" />)}
    {placed.map((tone, index) => <g key={index}>
      {tone.accidental && <text x={tone.x - 26} y={y(tone.stepsBelowF5) + 8} fontSize="26" fill="currentColor">{tone.accidental === "#" ? "♯" : "♭"}</text>}
      <ellipse cx={tone.x} cy={y(tone.stepsBelowF5)} rx="8.2" ry="4.9" fill="currentColor"
        transform={`rotate(-16 ${tone.x} ${y(tone.stepsBelowF5)})`} />
    </g>)}
  </svg>;
}

/** Focused view of one library chord: large notation plus compact note facts. */
function LibraryDetail({ shape, label, uncertain, instrument, view, capo, language }: {
  shape: string; label: string; uncertain: boolean; instrument: Instrument; view: DiagramView; capo: number; language: Language;
}) {
  const t = (key: string) => translate(language, key);
  const chord = chordNotes(shape);
  const [pianoBass, setPianoBass] = useState(chord?.bass);
  const shape_v = instrument === "Piano" ? null : frettedVoicing(shape, instrument);
  const pitches = instrument === "Piano"
    ? chord && pianoBass != null ? pianoPitches(chord, pianoBass) : []
    : shape_v?.flatMap((fret, string) => fret < 0 ? [] : [TUNINGS[instrument][string] + fret]).sort((a, b) => a - b) ?? [];
  const names = /^[A-G]b|\/[A-G]b$/.test(shape) ? FLAT_NOTES : SHARP_NOTES;
  const bassChoices = chord ? [...new Set([chord.bass, ...chord.notes.map(note => note % 12)])] : [];
  const tuning = instrument === "Piano" ? [] : TUNINGS[instrument];
  const covered = new Set(shape_v?.flatMap((f, i) => f < 0 ? [] : [(tuning[i] + f) % 12]) ?? []);
  const reduced = !!chord && !!shape_v && chord.notes.some(n => !covered.has(n % 12));
  const figure = instrument === "Piano"
    ? view === "secondary" ? <LibraryStaff name={shape} language={language} />
      : chord ? <PianoKeys name={shape} language={language} bass={pianoBass} /> : <span className="cd-na">{t("No voicing")}</span>
    : view === "secondary" ? <LibraryTab name={shape} instrument={instrument} capo={capo} language={language} />
      : <LibraryFretboard name={shape} instrument={instrument} language={language} />;
  return <div className="cd-lib-detail">
    <div className="cd-lib-detail-head">
      <strong><bdi>{label}</bdi></strong>
      {uncertain && <span className="cd-lib-flag">{t("Uncertain")}</span>}
      {label !== prettyChord(shape) && <small className="cd-lib-alt"><bdi>{prettyChord(shape)}</bdi></small>}
    </div>
    <div className="cd-lib-figure">{figure}</div>
    {reduced && <small className="cd-lib-reduced">{t("REDUCED VOICING")}</small>}
    {!!pitches.length && <dl className="cd-lib-facts">
      <div><dt>{t("Notes")}</dt><dd><bdi>{[...new Set(pitches.map(pitch => names[pitch % 12]))].join(" · ")}</bdi></dd></div>
      <div><dt>{t("Bass note")}</dt><dd><bdi>{names[pitches[0] % 12]}</bdi></dd></div>
    </dl>}
    {instrument === "Piano" && view === "primary" && bassChoices.length > 1 && <div className="cd-lib-bass">
      <span>{t("Bass note")}</span>
      <div className="cd-choice" role="group" aria-label={t("Bass note")}>
        {bassChoices.map(note => <button type="button" key={note} aria-pressed={pianoBass === note} onClick={() => setPianoBass(note)}>{names[note]}</button>)}
      </div>
    </div>}
    <p className="cd-voicing-note">{t(diagramNoteKey(instrument, view))}</p>
  </div>;
}

/** The library body: every detected chord in first-appearance order, one selected. */
function ChordLibrary({ items, selected, onSelect, instrument, view, capo, language }: {
  items: { display: string; shape: string; kind: "chord" | "uncertain" }[];
  selected: string | null;
  onSelect: (display: string) => void;
  instrument: Instrument; view: DiagramView; capo: number; language: Language;
}) {
  const t = (key: string) => translate(language, key);
  const entry = items.find(item => item.display === selected) ?? items[0];
  if (!entry) return <div className="cd-lib-body"><span className="cd-na">{t("Unavailable")}</span></div>;
  const cardLabel = (item: typeof items[number]) => item.display + (item.kind === "uncertain" ? "?" : "");
  return <div className="cd-lib-body">
    <div className="cd-lib-grid" role="group" aria-label={t("Detected chords")}>
      {items.map(item => <Diagram key={item.display} name={item.shape} label={cardLabel(item)}
        instrument={instrument} view={view} capo={capo} language={language}
        active={item.display === entry.display} onExplore={() => onSelect(item.display)} />)}
    </div>
    <LibraryDetail key={entry.shape + instrument + view} shape={entry.shape} label={cardLabel(entry)}
      uncertain={entry.kind === "uncertain"} instrument={instrument} view={view} capo={capo} language={language} />
  </div>;
}

export type ChordDashboardShortcuts = { run: (action: Exclude<ShortcutAction, "youtube">) => boolean };

export interface ChordDashboardProps {
  shortcutRef: Ref<ChordDashboardShortcuts>;
  shortcuts: Shortcuts;
  youtubeSearchRequested: boolean;
  onYoutubeSearchFocused: () => void;
  lyricsLookup: SmartLookup | null;
  onLyricsAction: LyricsAction;
  lightLayout?: boolean;
  language: Language;
  transpose: number;
  onTranspose: (value: number) => void;
  status: AppStatus;
  showWelcome: boolean;
  tauri: boolean;
  youtubeUrl: string;
  onYoutubeUrl: (v: string) => void;
  canAnalyzeYoutube: boolean;
  compactLayout: boolean;
  canDownloadMp3: boolean;
  mp3Busy: boolean;
  mp3QualityLabel: string;
  onBrowse: () => void;
  onFilePath: (path: string, name: string) => void;
  onAnalyzeYoutube: (url?: string) => void;
  onDownloadMp3: () => void;
  onCancel: () => void;
  time: number;
  playing: boolean;
  duration: number;
  readTime: () => number;
  watchClock: (fn: (t: number) => void) => () => void;
  onAudible: (t: number) => void;
  onSeek: (t: number) => void;
  onToggle: () => void;
  onRate: (rate: number) => void;
  onLoop: (region: { start: number; end: number } | null) => void;
  volume: number;
  onVolume: (v: number) => void;
  onReanalyze: () => void;
  onReloadSource: () => void;
  onJson: () => void;
  onCsv: () => void;
  onChart: () => void;
  onCorrectChord: (index: number, chord: ChordSegment) => void;
  onMp3: () => void;
  onClear: () => void;
}

export default function ChordDashboard(p: ChordDashboardProps) {
  const t = (key: string, params?: Record<string, string | number>) => translate(p.language, key, params);
  const { transpose, onTranspose: setTranspose } = p;
  const labels = languages[p.language];
  const r: AnalysisResult | null = p.status.kind === "ready" ? p.status.result : p.status.kind === "loading" ? p.status.held ?? null : null;
  const canPlay = p.status.kind === "ready" && !!p.status.objectUrl && !p.status.playbackError;
  const thumbnailId = r?.source.fromYoutube ? r.source.youtubeId ?? youtubeVideoId(r.source.url ?? "") : null;
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null);
  const busy = p.status.kind === "loading";
  const recoveringAudio = p.status.kind === "loading" && p.status.recoveringAudio;
  const welcome = p.showWelcome || p.status.kind === "idle";
  const standard = !p.compactLayout && !welcome;
  const compact = p.compactLayout && !welcome;
  const [speed, setSpeed] = useState(1);
  const [capo, setCapo] = useState(0);
  const [numbers, setNumbers] = useState<NumberStyle>("off");
  const [markA, setMarkA] = useState<number | null>(null);
  const [markB, setMarkB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [meter, setMeter] = useState("auto");
  const [bpm, setBpm] = useState(100);
  const [bpmTouched, setBpmTouched] = useState(false);
  const clicks = useRef<PracticeMetronome | null>(null);
  if (!clicks.current) clicks.current = new PracticeMetronome();
  const counting = useRef(false);
  const [instrument, setInstrument] = useState<Instrument>("Piano");
  const [diagramView, setDiagramView] = useState<DiagramView>("primary");
  const chooseInstrument = (option: Instrument) => {
    setInstrument(option);
    setDiagramView("primary");
  };
  const instrumentPicker = <div className="cd-choice cd-instrument-choice" role="group" aria-label={t("Chord diagram instrument")}>
    {(["Piano", "Guitar", "Bass"] as const).map(option => <button key={option} type="button"
      aria-pressed={instrument === option} title={t(option)} onClick={() => chooseInstrument(option)}>{t(option)}</button>)}
  </div>;
  const viewPicker = (footer = false) => <div className={"cd-choice cd-diagram-views" + (footer ? " cd-diagram-foot" : "")} role="group" aria-label={t("Chord diagram view")} title={footer ? t(diagramNoteKey(instrument, diagramView)) : undefined}>
    {DIAGRAM_VIEWS[instrument].map((label, index) => {
      const view: DiagramView = index === 0 ? "primary" : "secondary";
      return <button key={label} type="button" aria-pressed={diagramView === view} onClick={() => setDiagramView(view)}>{t(label)}</button>;
    })}
  </div>;
  const [editing, setEditing] = useState<number | null>(null);
  const [editError, setEditError] = useState("");
  const vol = p.volume;
  const [exportOpen, setExportOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState("");
  const [changeSongOpen, setChangeSongOpen] = useState(false);
  const replacing = !welcome && p.status.kind === "ready" && changeSongOpen;
  const [replacementUrl, setReplacementUrl] = useState("");
  const changeSongButton = useRef<HTMLButtonElement>(null);
  const changeSongCancel = useRef<HTMLButtonElement>(null);
  const uploadPanel = useRef<HTMLElement>(null);
  const closeChangeSong = () => {
    setChangeSongOpen(false);
    changeSongButton.current?.focus();
  };
  useEffect(() => {
    if (busy || welcome) setChangeSongOpen(false);
  }, [busy, welcome]);
  useEffect(() => {
    if (replacing && !p.youtubeSearchRequested && !uploadPanel.current?.contains(document.activeElement)) {
      changeSongCancel.current?.focus();
    }
  }, [replacing, p.youtubeSearchRequested]);
  useLayoutEffect(() => {
    if (p.youtubeSearchRequested && !replacing && !welcome && p.status.kind === "ready") {
      setReplacementUrl("");
      setChangeSongOpen(true);
    }
  }, [p.youtubeSearchRequested, replacing, welcome, p.status.kind]);
  const exportRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const expandedSheetRef = useRef<HTMLDivElement>(null);
  const sheetDialog = useRef<HTMLDialogElement>(null);
  const lyricsControls = useRef<LyricsControlsHandle>(null);
  const sheetTitleId = useId();
  const voicingDialog = useRef<HTMLDialogElement>(null);
  const voicingTitleId = useId();
  const [exploredChord, setExploredChord] = useState<string | null>(null);
  const [libChoice, setLibChoice] = useState<string | null>(null);
  const [libOpenTick, setLibOpenTick] = useState(0);
  // Every click re-opens: a click that repeats the current chord must still
  // re-run showModal even if a close event was missed earlier.
  const openLibrary = (printed: string) => {
    setExploredChord(printed);
    setLibChoice(printed);
    setLibOpenTick(tick => tick + 1);
  };
  useLayoutEffect(() => {
    if (exploredChord !== null && !voicingDialog.current?.open) voicingDialog.current?.showModal();
  }, [exploredChord, libOpenTick]);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [compactSheetView, setCompactSheetView] = useState<"lyrics" | "diagrams">("lyrics");
  const [editingSheet, setEditingSheet] = useState(false);
  const [verifyingLyrics, setVerifyingLyrics] = useState(false);
  const [editNotice, setEditNotice] = useState("");
  const lyricVerificationJob = useRef<string | null>(null);

  const editOriginalLines = useRef<string[]>([]);

  const showSheetDiagrams = p.compactLayout && compactSheetView === "diagrams" && !editingSheet;
  const [editBlocks, setEditBlocks] = useState<LeadLine[] | null>(null);
  const [sheetView, setSheetView] = useState<"both" | "chords" | "lyrics">("both");
  const [sectionMenu, setSectionMenu] = useState(false);
  const sheetPast = useRef<LeadLine[][]>([]);
  const sheetFuture = useRef<LeadLine[][]>([]);
  const [sheetHistory, setSheetHistory] = useState(0);
  const [followSheet, setFollowSheet] = useState(true);
  const [lyricsQuery, setLyricsQuery] = useState("");
  const [lyricsMatch, setLyricsMatch] = useState(0);
  const [lyricsMatchCount, setLyricsMatchCount] = useState(0);
  const [lyricsScale, setLyricsScale] = useState(100);
  const compactSectionsId = useId();
  const compactDiagramViewsId = useId();
  useLayoutEffect(() => {
    if (sheetExpanded && !sheetDialog.current?.open) sheetDialog.current?.showModal();
  }, [sheetExpanded]);
  const tableRef = useRef<HTMLDivElement>(null);
  const dashboardRef = useRef<HTMLDivElement>(null);
  const live = useRef(p);
  live.current = p;

  const sourceIdentity = r ? r.source.youtubeId ?? r.source.path : null;
  useEffect(() => {
    setLyricsQuery("");
    setLyricsMatch(0);
  }, [sourceIdentity]);
  useEffect(() => {
    setEditing(null);
    setFollowSheet(true);
    setLoopOn(false);
    setMarkA(null);
    setMarkB(null);
    setCapo(0);
    setNumbers("off");
    setSpeed(1);
    setBpmTouched(false);
    sheetDialog.current?.close();
    voicingDialog.current?.close();
    setLibChoice(null);
    setChangeSongOpen(false);
    live.current.onLoop(null);
    live.current.onRate(1);
  }, [sourceIdentity]);
  useEffect(() => { live.current.onRate(speed); }, [speed]);
  useEffect(() => {
    const ready = loopOn && markA != null && markB != null && markB > markA + 0.2;
    live.current.onLoop(ready ? { start: markA, end: markB } : null);
  }, [loopOn, markA, markB]);
  useEffect(() => {
    if (!bpmTouched && r?.meta.tempoBpm) setBpm(r.meta.tempoBpm);
  }, [sourceIdentity, r?.meta.tempoBpm, bpmTouched]);
  useEffect(() => {
    setMeter("auto");
  }, [sourceIdentity]);
  const meterGrid = r?.meta.meterConfidence === "strong" ? r.meta.meterBeats : undefined;
  const autoMeter = meter === "auto" && !bpmTouched && meterGrid?.length;
  const clickMeter = clickGrouping(meter === "auto" ? autoMeter ? r?.meta.timeSignature : undefined : meter);
  const clickBpm = autoMeter ? r?.meta.meterPulseBpm ?? bpm : bpm;
  const meterLabel = r?.meta.meterChanges?.length
    ? r.meta.meterChanges.map(change => change.timeSignature).join(" → ")
    : r?.meta.timeSignature
      ? (r.meta.meterConfidence === "moderate" ? "≈ " : "") + r.meta.timeSignature
      : t("Uncertain");
  useEffect(() => {
    const track = clicks.current;
    if (!track) return;
    if (!metronome || !p.playing || !(clickBpm > 0)) {
      track.stopFollow();
      return;
    }
    track.follow(() => ({ media: live.current.readTime(), rate: speed, beat: 60 / clickBpm,
      ...clickMeter, grid: autoMeter ? meterGrid : undefined }));
    return () => track.stopFollow();
  }, [metronome, p.playing, clickBpm, clickMeter.bar, clickMeter.subdivisions, autoMeter, meterGrid, speed]);
  useEffect(() => () => clicks.current?.dispose(), []);

  useEffect(() => {
    if (!p.tauri) return;
    let closed = false;
    let off: (() => void) | undefined;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const unlisten = await getCurrentWebview().onDragDropEvent(({ payload }) => {
        setDragOver(payload.type === "over" || payload.type === "enter");
        if (payload.type === "drop" && live.current.status.kind !== "loading" && payload.paths[0]) {
          const path = payload.paths[0];
          live.current.onFilePath(path, path.split(/[\\/]/).pop() || "Audio");
        }
      });
      if (closed) unlisten(); else off = unlisten;
    });
    return () => { closed = true; off?.(); };
  }, [p.tauri]);

  useEffect(() => {
    if (!exportOpen) return;
    const down = (e: MouseEvent) => { if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setExportOpen(false); };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", down); window.removeEventListener("keydown", key); };
  }, [exportOpen]);

  const keyPc = r && r.key.label !== "Uncertain" ? PC[r.key.tonic] ?? null : null;
  const tonicPc = pitchClass(r?.key.tonic);
  const flats = prefersFlats(r?.key.tonic);
  const sourceChords = r ? r.chords : EMPTY_CHORDS;
  const rawChords = r?.rawChords;
  const [cleanMode, setCleanMode] = useState(() => localStorage.getItem(CHORD_MODE_KEY) === "clean");
  const visibleChords = useMemo(() => cleanMode ? cleanProgression(sourceChords, rawChords) : sourceChords,
    [cleanMode, sourceChords, rawChords]);
  const chords = useMemo(() => visibleChords.map((chord): ShownChord => {
    const display = transposeChordLabel(chord.display, transpose, flats);
    return {
      ...chord,
      display,
      shape: capoShape(display, capo, flats),
      printed: practiceName(display, capo, flats, tonicPc, numbers),
    };
  }), [visibleChords, capo, flats, tonicPc, numbers, transpose]);
  const chordsRef = useRef(chords);
  const shownChord = useRef<number | null>(null);
  if (chordsRef.current !== chords) {
    chordsRef.current = chords;
    shownChord.current = null;
  }
  const dur = p.duration || r?.source.durationSec || 0;
  const activeIndex = canPlay ? chords.findIndex(c => p.time >= c.start && p.time < c.end) : -1;
  const active = chords[activeIndex] ?? null;
  const unique = useMemo(() => {
    const order: DetectedChord[] = [];
    const at = new Map<string, number>();
    for (const c of chords) {
      if (c.display === "N.C." || (c.kind !== "chord" && c.kind !== "uncertain")) continue;
      const index = at.get(c.printed);
      if (index == null) {
        at.set(c.printed, order.length);
        order.push({ display: c.printed, shape: c.shape, kind: c.kind === "chord" ? "chord" : "uncertain" });
      } else if (c.kind === "chord") order[index] = { display: c.printed, shape: c.shape, kind: "chord" };
    }
    return order;
  }, [chords]);
  const isNamed = (chord: ChordSegment | null) => chord != null && chord.display !== "N.C."
    && (chord.kind === "chord" || chord.kind === "uncertain");
  const activeNamed = isNamed(active);
  let previousDiagram: ShownChord | undefined;
  for (const chord of chords) {
    if (chord.start >= p.time) break;
    if (chord.end <= p.time && isNamed(chord)) previousDiagram = chord;
  }
  const nextDiagram = chords.find(chord => chord.start > p.time && isNamed(chord));
  const currentDiagramLabel = activeNamed ? active?.printed : undefined;
  const upcomingDiagramLabel = compact ? chords.find(chord => isNamed(chord) &&
    (canPlay ? chord.start > p.time : chord.end > p.time) && chord.printed !== currentDiagramLabel)?.printed : undefined;
  const diagramSlots = [
    { chord: previousDiagram, caption: t("Previous") },
    { chord: activeNamed ? active : null, caption: t("Now playing") },
    { chord: nextDiagram, caption: t("Next") },
  ];
  const renderDiagrams = () => <div className="cd-diagram-row cd-live-diagrams">
    {diagramSlots.map(({ chord, caption }, index) => <div key={index} className="cd-live-diagram-slot">
      {chord ? <Diagram name={chord.shape} caption={caption} instrument={instrument} language={p.language} active={index === 1}
        view={diagramView} capo={capo} onExplore={() => openLibrary(chord.printed)} />
        : <div className="cd-live-diagram-empty"><small className="cd-diagram-position">{caption}</small><span>{NA}</span></div>}
    </div>)}
  </div>;

  useEffect(() => {
    for (const container of [tableRef.current]) {
      const current = container?.querySelector<HTMLElement>('[aria-current="true"]');
      if (!container || !current) continue;
      const top = current.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      const header = container.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      if (top < container.scrollTop + header) container.scrollTop = Math.max(0, top - header);
      else if (top + current.offsetHeight > container.scrollTop + container.clientHeight) {
        container.scrollTop = top + current.offsetHeight - container.clientHeight;
      }
    }
  }, [activeIndex, capo, numbers]);

  const sheetRows = useMemo(() => {
    const rows: ShownChord[][] = [];
    for (let i = 0; i < chords.length; i += 4) rows.push(chords.slice(i, i + 4));
    return rows;
  }, [chords]);
  const pct = dur > 0 ? Math.min(1, p.time / dur) : 0;

  const k = r?.key;
  const keyUnknown = !k || k.label === "Uncertain";
  const relative = k?.alternative?.relation === "relative" ? k.alternative : null;
  // The transpose moves the printed key and chord names only. The recording
  // and every detected timestamp stay exactly as the engine reported them.
  const keyLabel = !keyUnknown && transpose
    ? `${transposeKeyName(k!.tonic, transpose, flats)} ${k!.mode === "minor" ? "minor" : "major"}`
    : keyUnknown ? "" : k!.label;
  const relativeLabel = relative && transpose
    ? `${transposeKeyName(relative.tonic, transpose, flats)} ${relative.mode === "minor" ? "minor" : "major"}`
    : relative?.label ?? "";
  const visibleKey = !k ? t("Unavailable") : keyUnknown || k.uncertain ? t("Uncertain") : localizedKey(p.language, keyLabel);
  const keyDetail = !keyUnknown && k.uncertain ? t("Best candidate: {key}", { key: localizedKey(p.language, keyLabel) }) :
    !keyUnknown && relative ? `${t(k.mode === "minor" ? "Relative Major:" : "Relative Minor:")} ${localizedKey(p.language, relativeLabel)}` :
    !keyUnknown ? t(k.mode === "minor" ? "Minor" : "Major") : "";
  const keyScore = typeof k?.score === "number" && Number.isFinite(k.score) ? k.score : null;
  const matchHelp = t("Key profile correlation (Krumhansl–Kessler), −1…1. It is not a probability of being correct.");
  const title = !r ? (busy ? t("Analyzing…") : p.status.kind === "error" ? t("Analysis failed") : t("No song loaded"))
    : r.source.fromYoutube ? r.source.name : r.source.name.replace(/\.[^.]+$/, "");

  const seekFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!r || dur <= 0) return;
    const b = e.currentTarget.getBoundingClientRect();
    seekPlayer(Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) * dur);
  };

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(""), 1500); } catch { setCopied(""); }
  };
  const [sheetDraft, setSheetDraft] = useState<{ key: string; value: string } | null>(null);
  const textKey = sourceIdentity ? `hearthkeys-sheet-text:${sourceIdentity}` : "";
  const cancelLyricVerification = () => {
    const job = lyricVerificationJob.current;
    lyricVerificationJob.current = null;
    if (job) void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("cancel_lyrics_alignment", { job })).catch(() => {});
  };
  useEffect(() => {
    setVerifyingLyrics(false);
    setEditNotice("");
    setEditBlocks(null);
    setEditingSheet(false);
    return () => cancelLyricVerification();
  }, [textKey]);
  const libraryKey = textKey && textKey + ":library";
  const [pickedLibrary, setPickedLibrary] = useState<{ key: string; title: string; provider: string; text?: string } | null>(null);
  const savedLibrary = useMemo(() => {
    try { return libraryKey ? JSON.parse(localStorage.getItem(libraryKey) ?? "null") as typeof pickedLibrary : null; }
    catch { return null; }
  }, [libraryKey]);
  const librarySelection = pickedLibrary?.key === libraryKey ? pickedLibrary : savedLibrary;
  const backupKey = textKey && textKey + ":generated-backup";
  const [backup, setBackup] = useState<{ key: string; text: string } | null>(null);
  const savedBackup = useMemo(() => {
    try { return backupKey ? localStorage.getItem(backupKey) ?? "" : ""; }
    catch { return ""; }
  }, [backupKey]);
  const generatedBackup = backup?.key === backupKey ? backup.text : savedBackup;
  const savedText = useMemo(() => {
    if (!textKey) return "";
    try { return localStorage.getItem(textKey) ?? ""; } catch { return ""; }
  }, [textKey]);
  const customText = sheetDraft?.key === textKey ? sheetDraft.value : savedText;
  const lookupDuration = r?.source.durationSec ?? 0;
  const lookup = r && p.lyricsLookup?.song === lyricsIdentity(r.source) ? p.lyricsLookup : null;
  const hasManualText = Boolean(customText.trim());
  const online = hasManualText ? null : lookup?.lyrics ?? null;
  const chart = online?.chart;
  const manualChart = useMemo(() => hasManualText ? leadSheetChart(customText) : [], [hasManualText, customText]);
  const hasWrittenChords = manualChart.some(row => row.chords.length);
  const syncText = hasManualText ? customText : online?.plain || online?.chart?.map(row => row.text).join("\n") || "";
  const syncSource = useMemo(() => syncText.split(/\r?\n/).flatMap((raw, sourceLine) => {
    const text = raw.trim();
    return text && !/^\[[^\]]+\]$/.test(text) ? [{ text, sourceLine }] : [];
  }), [syncText]);
  const syncLines = useMemo(() => syncSource.map(line => line.text), [syncSource]);
  const canSyncText = useMemo(() => syncLines.some(raw => prepareLyricLine(raw, hasWrittenChords)),
    [syncLines, hasWrittenChords]);
  // Previously saved timing overrides are keyed to the song, lyrics revision and version.
  const syncKey = useMemo(() => {
    if (!sourceIdentity || !syncText || lookupDuration <= 0) return "";
    let hash = 2166136261;
    for (let index = 0; index < syncText.length; index++) hash = Math.imul(hash ^ syncText.charCodeAt(index), 16777619);
    return `hearthkeys-line-sync:${JSON.stringify([sourceIdentity, lookupDuration, hasManualText ? "edited" : lookup?.selected, hash >>> 0])}`;
  }, [sourceIdentity, syncText, lookupDuration, hasManualText, lookup?.selected]);
  const [syncRevision, setSyncRevision] = useState(0);
  const manualTimes = useMemo<number[]>(() => {
    if (!syncKey) return [];
    try {
      const marks: unknown = JSON.parse(localStorage.getItem(syncKey) ?? "[]");
      return Array.isArray(marks) && marks.length === syncLines.length && marks.every((at, index) =>
        typeof at === "number" && Number.isFinite(at) && at >= 0 && at < lookupDuration &&
        (!index || at > marks[index - 1])) ? marks : [];
    } catch { return []; }
  }, [syncKey, syncLines, lookupDuration, syncRevision]);
  const timingEdits = useMemo<LyricTimingEdits>(() => {
    try {
      const stored: unknown = syncKey ? JSON.parse(localStorage.getItem(syncKey + ":adjustments") ?? "{}") : {};
      return stored && typeof stored === "object" && !Array.isArray(stored) ? stored as LyricTimingEdits : {};
    } catch { return {}; }
    // The revision changes when storage is updated without changing the lyrics.
  }, [syncKey, syncRevision]);
  type AlignmentResult = { state: string; language?: string; marks?: ([number, number] | null)[]; words?: LyricWordAnchor[][]; matched?: number; total?: number };
  const [automatic, setAutomatic] = useState<{ key: string; result: AlignmentResult } | null>(null);
  const [cancelledKey, setCancelledKey] = useState("");
  const audioPath = p.status.kind === "ready" && canPlay ? p.status.filePath : "";
  const generateKey = audioPath && sourceIdentity ? JSON.stringify([audioPath, sourceIdentity, lookupDuration]) : "";
  const generationKey = textKey && textKey + ":generated-timing";
  const [generated, setGenerated] = useState<{ key: string; duration: number; result: GenerateResult } | null>(null);
  const [generating, setGenerating] = useState(false);
  const savedGeneration = useMemo<typeof generated>(() => {
    try { return generationKey ? JSON.parse(localStorage.getItem(generationKey) ?? "null") : null; }
    catch { return null; }
  }, [generationKey]);
  const generation = generated?.key === generationKey ? generated : savedGeneration;
  const generatedResult = generation?.duration === lookupDuration ? generation.result : null;
  const heardLines = generatedResult?.lines;
  const generatedText = useMemo(() => generatedResult ? generatedLyricBody(generatedResult) : "", [generatedResult]);
  const useGeneratedTiming = !!generatedText && (generatedText === syncText || heardLines?.map(line => line.text).join("\n") === syncText) && (!manualTimes.length ||
    (manualTimes.length === heardLines?.length && manualTimes.every((at, index) => at === heardLines[index].at)));
  const libraryEvidence = useMemo(() => {
    if (!librarySelection?.title || !generatedBackup || generatedText !== generatedBackup || !heardLines) return undefined;
    const words = heardLines.flatMap((line, index) => (generatedResult?.words?.[index] ?? []).flatMap(word =>
      typeof word.probability === "number" && word.probability >= .65
        ? [[word.text, line.at + word.at, line.at + word.end, word.probability]] : []));
    return words.length && words.length <= 2500 ? words : undefined;
  }, [librarySelection?.title, generatedBackup, generatedText, heardLines, generatedResult]);
  const providerLines = online?.lines;
  const lrcLines = useMemo(() => providerLines?.filter(line => line.text.trim() && line.at >= 0 && line.at < lookupDuration) ?? [], [providerLines, lookupDuration]);
  const alignmentKey = audioPath && syncKey ? JSON.stringify([audioPath, syncKey, lrcLines.length > 0]) : "";
  const currentAlignment = alignmentKey && automatic?.key === alignmentKey ? automatic.result : null;
  const alignmentLanguage = lookup?.candidates.find(candidate => candidate.id === lookup.selected)?.language;
  const languageHint = alignmentLanguage && alignmentLanguage !== "unknown" && alignmentLanguage !== "auto"
    ? alignmentLanguage : lookup?.metadata.language;
  const [preferredLyricsLanguage] = useState(savedLyricsLanguage);
  const generationLanguage = preferredLyricsLanguage === "auto" ? languageHint : preferredLyricsLanguage;
  const [checkedGeneration, setCheckedGeneration] = useState("");
  const recoveryText = librarySelection?.title ? generatedBackup : customText;
  const preserveGenerationKey = textKey && textKey + ":preserve-generated";
  const preservedTranscript = useMemo(() => {
    try { return preserveGenerationKey ? localStorage.getItem(preserveGenerationKey) : null; }
    catch { return null; }
  }, [preserveGenerationKey, recoveryText]);
  const mayUpgradeGenerated = !librarySelection?.title && recoveryText !== preservedTranscript;
  const recoveryKey = p.tauri && generateKey && recoveryText && !lookup?.pending && !editingSheet && !generating && !verifyingLyrics
    && !manualTimes.length && !Object.keys(timingEdits).length && (mayUpgradeGenerated || !generation)
    ? JSON.stringify([generateKey, languageHint ?? null, recoveryText]) : "";
  const recoveringGeneration = !!recoveryKey && checkedGeneration !== recoveryKey;
  useEffect(() => {
    if (!recoveringGeneration) return;
    let disposed = false;
    let started = false;
    const job = crypto.randomUUID();
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        if (disposed) return;
        started = true;
        const result = await invoke<GenerateResult>("align_lyrics", { job, request: {
          path: audioPath, lines: [], duration: lookupDuration, version: "generate",
          transcribe: true, cachedOnly: !mayUpgradeGenerated,
          recoverSavedText: recoveryText, language: generatedResult?.language ?? generationLanguage,
        } });
        if (disposed || result.state !== "generated") return;
        const revisedText = generatedLyricBody(result);
        const replaced = mayUpgradeGenerated && result.upgradedSaved && revisedText !== recoveryText;
        if (replaced) {
          saveRevision(revisedText);
          saveSheetText(revisedText);
        }
        if (replaced || revisedText === recoveryText || result.lines?.map(line => line.text).join("\n") === recoveryText) {
          storeGenerated(result);
        }
      } catch {
        // Existing manual timing and normal alignment remain available.
      } finally {
        if (!disposed) setCheckedGeneration(recoveryKey);
      }
    })();
    return () => {
      disposed = true;
      if (started) void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("cancel_lyrics_alignment", { job })).catch(() => {});
    };
  }, [recoveringGeneration, recoveryKey, recoveryText, generationKey, generationLanguage, audioPath, lookupDuration, mayUpgradeGenerated]);
  useEffect(() => {
    if (LYRICS_ONLY_SHEET || generating || recoveringGeneration || useGeneratedTiming || (!lrcLines.length && lookupDuration > 600 && !hasManualText) || !alignmentKey || !p.tauri || manualTimes.length || chart?.length || (lrcLines.length || syncLines.length) < 2
      || editingSheet || verifyingLyrics || cancelledKey === alignmentKey) return;
    let disposed = false;
    let started = false;
    const job = crypto.randomUUID();
    let deadline: number | undefined;
    const timer = window.setTimeout(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        if (disposed) return;
        started = true;
        setAutomatic({ key: alignmentKey, result: { state: "running" } });
        deadline = window.setTimeout(() => {
          disposed = true;
          setAutomatic({ key: alignmentKey, result: { state: "unavailable" } });
          void invoke("cancel_lyrics_alignment", { job }).catch(() => {});
        }, 305000);
        const result = await invoke<AlignmentResult>("align_lyrics", { job, request: {
          path: audioPath, lines: lrcLines.length ? lrcLines.map(line => line.text) : syncLines, duration: lookupDuration,
          version: hasManualText ? "edited" : lookup?.selected ?? "", language: languageHint,
          ...(lrcLines.length ? { expected: lrcLines.map(line => line.at) } : {}),
          ...(libraryEvidence ? { heard: libraryEvidence } : {}),
        } });
        if (!disposed) setAutomatic({ key: alignmentKey, result });
      } catch {
        if (!disposed) setAutomatic({ key: alignmentKey, result: { state: "unavailable" } });
      } finally {
        window.clearTimeout(deadline);
      }
    }, 250);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.clearTimeout(deadline);
      setAutomatic(previous => previous?.key === alignmentKey && previous.result.state === "running"
        ? { key: alignmentKey, result: { state: "unavailable" } } : previous);
      if (started) void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("cancel_lyrics_alignment", { job })).catch(() => {});
    };
  }, [alignmentKey, p.tauri, manualTimes.length, lrcLines, syncLines, editingSheet,
    cancelledKey, audioPath, lookupDuration, hasManualText, lookup?.selected, languageHint, Boolean(chart?.length), generating, recoveringGeneration, useGeneratedTiming, libraryEvidence, verifyingLyrics]);
  const autoMarks = currentAlignment && currentAlignment.state === "aligned" ? currentAlignment.marks : null;
  const autoLines = useMemo(() => {
    if (lrcLines.length || !autoMarks || autoMarks.length !== syncLines.length) return null;
    const lines: { at: number; end: number; text: string; sourceLine: number }[] = [];
    const before = new Map<number, string>();
    const words = new Map<number, LyricWordAnchor[]>();
    let index = 0;
    const pending: string[] = [];
    for (const [sourceLineIndex, sourceLine] of syncText.split(/\r?\n/).entries()) {
      const line = sourceLine.trim();
      if (!line || /^\[[^\]]+\]$/.test(line)) {
        pending.push(sourceLine);
        continue;
      }
      const mark = autoMarks[index++];
      if (!mark) {
        pending.push(sourceLine);
        continue;
      }
      const [at, end] = mark;
      if (!Number.isFinite(at) || !Number.isFinite(end) || at < 0 || at >= end || end > lookupDuration
          || at <= (lines.at(-1)?.at ?? -1)) return null;
      if (pending.length) before.set(at, pending.splice(0).join("\n"));
      lines.push({ at, end, text: sourceLine, sourceLine: sourceLineIndex });
      const anchors = currentAlignment && currentAlignment.words?.[index - 1];
      if (anchors?.length) words.set(at, anchors);
    }
    return { lines, before, words, tail: pending.join("\n") };
  }, [autoMarks, syncLines.length, syncText, lookupDuration, currentAlignment, lrcLines.length]);
  const refinedLrc = useMemo(() => {
    if (!providerLines || !lrcLines.length || autoMarks?.length !== lrcLines.length) return providerLines;
    let index = 0;
    let previous = -1;
    return providerLines.map((line, i) => {
      const next = providerLines[i + 1]?.at ?? lookupDuration;
      const mark = line === lrcLines[index] ? autoMarks[index++] : null;
      const at = mark && mark[0] > previous && mark[0] < next &&
        Math.abs(mark[0] - line.at) >= .25 ? mark[0] : line.at;
      previous = at;
      return { ...line, at };
    });
  }, [providerLines, lrcLines, autoMarks, lookupDuration]);
  const usingAuto = !manualTimes.length && !online?.lines.length && !!autoLines?.lines.length;
  const heardAnchors = useMemo(() => {
    if (!useGeneratedTiming || !heardLines || !generatedResult?.words) return undefined;
    return new Map(heardLines.map((line, index) => {
      let wordIndex = 0;
      const anchors = (generatedResult.words?.[index] ?? []).flatMap(word => {
        const startIndex = wordIndex;
        const count = word.text.match(/[\p{L}\p{M}\p{N}]+/gu)?.length ?? 0;
        wordIndex += count;
        const at = line.at + word.at;
        const end = line.at + word.end;
        const anchor: LyricWordAnchor = [startIndex, at, end];
        return count === 1 && Number.isFinite(at) && Number.isFinite(end) && at < end ? [anchor] : [];
      });
      return [line.at, anchors] as const;
    }));
  }, [useGeneratedTiming, heardLines, generatedResult]);
  const originalAnchors = heardAnchors ?? autoLines?.words;
  const originalLines = useMemo<LyricLine[]>(() => {
    if (useGeneratedTiming && heardLines) return heardLines;
    if (manualTimes.length) return manualTimes.map((at, index) => ({ at, text: syncLines[index] ?? "" }));
    if (refinedLrc?.length) return refinedLrc;
    return autoLines?.lines ?? [];
  }, [manualTimes, syncLines, refinedLrc, autoLines, useGeneratedTiming, heardLines]);
  const timingBaseline = useMemo(() => {
    let cursor = 0;
    return syncSource.map(({ text, sourceLine }) => {
      const item = originalLines[cursor];
      if (!item || (item.sourceLine !== undefined ? item.sourceLine !== sourceLine : item.text.trim() !== text)) {
        return undefined;
      }
      cursor++;
      return item;
    });
  }, [syncSource, originalLines]);
  const hasTimingEdits = Object.keys(timingEdits).length > 0 && validLyricTiming(timingBaseline, timingEdits, lookupDuration);
  const lyricLines = useMemo(() => hasTimingEdits ? syncSource.flatMap(({ text, sourceLine }, index) => {
    const at = timingEdits[index];
    const original = timingBaseline[index];
    if (at === undefined) return original ? [{ ...original, sourceLine }] : [];
    return [{ text, sourceLine, at }];
  }) : originalLines, [hasTimingEdits, syncSource, timingEdits, timingBaseline, originalLines]);
  const lyricAnchors = useMemo(() => {
    if (!hasTimingEdits || !originalAnchors) return originalAnchors;
    const kept = new Map(originalAnchors);
    for (const index of Object.keys(timingEdits)) {
      const old = timingBaseline[Number(index)];
      if (old) kept.delete(old.at);
    }
    return kept;
  }, [hasTimingEdits, originalAnchors, timingBaseline, timingEdits]);
  const onlineRows = useMemo(() => timedSheetRows(lyricLines, chords, lookupDuration), [lyricLines, chords, lookupDuration]);
  const builtChart = useMemo(() => {
    if (chart?.length || !syncText.trim()) return null;
    if (!useGeneratedTiming && hasWrittenChords) {
      if (!hasTimingEdits) return manualChart;
      const timedRows = songbookFromLyrics(syncText, lyricLines, [], undefined, lookupDuration)
        .filter(row => !row.section);
      let index = 0;
      return manualChart.map(row => {
        const timed = timedRows[index];
        if (row.section || !timed || row.text.trim() !== timed.text.trim()) return row;
        index++;
        return timed.timing ? { ...row, timing: timed.timing } : row;
      });
    }
    const rows = songbookFromLyrics(syncText, lyricLines, chords, lyricAnchors, lookupDuration, !useGeneratedTiming);
    const instrumentals = useGeneratedTiming ? generatedResult?.instrumentals : undefined;
    return instrumentals?.length ? withInstrumentalRows(rows, instrumentals, chords, lookupDuration) : rows;
  }, [chart, syncText, lyricLines, chords, lyricAnchors, lookupDuration, manualChart, useGeneratedTiming, hasWrittenChords, hasTimingEdits, generatedResult?.instrumentals]);
  const lyricChart = useMemo(() => {
    // An imported chart is written in its own key. The transpose moves it with
    // the detected chords so the sheet keeps one key.
    const source = chart?.length ? chart : builtChart ?? undefined;
    if (!source) return undefined;
    if (!transpose || !chart?.length) return source;
    return source.map(row => ({ ...row, chords: row.chords.map(item => ({ ...item, label: transposeSongbookChord(item.label, transpose) })) }));
  }, [chart, builtChart, transpose]);
  const timed = onlineRows.length > 0;
  const showChart = !!lyricChart?.length;
  const chartTimedRows = useMemo(() => {
    let lyric = -1;
    return lyricChart?.flatMap(row => {
      if (row.section || !row.text.trim()) return [];
      lyric++;
      return row.timing ? [{ ...row.timing, lyric }] : [];
    }) ?? [];
  }, [lyricChart]);
  const anchored = chartTimedRows.length > 0;
  const chartHasSymbols = !!lyricChart?.some(row => row.chords.length > 0);
  const chartSync = useMemo(() => showChart && lyricChart && chartHasSymbols && !anchored ? matchChartToDetected(lyricChart, chords) : null,
    [showChart, lyricChart, chartHasSymbols, anchored, chords]);
  const chartLyricIndex = useMemo(() => {
    const map = new Map<number, number>();
    let count = 0;
    lyricChart?.forEach((row, index) => { if (!row.section && row.text.trim()) map.set(index, count++); });
    return map;
  }, [lyricChart]);
  const chartPosition = useMemo(() => {
    if (!chartSync || !canPlay) return { active: -1, follow: -1 };
    let active = -1, follow = -1;
    for (const range of chartSync.ranges) {
      if (range.start > p.time) break;
      follow = range.row;
      if (p.time < range.end) active = range.row;
    }
    return { active, follow };
  }, [chartSync, canPlay, p.time]);
  const anchoredLine = canPlay && anchored ? timedSheetPosition(chartTimedRows, p.time) : null;
  const chartActiveLine = anchored ? chartTimedRows[anchoredLine?.active ?? -1]?.lyric ?? -1 : chartLyricIndex.get(chartPosition.active) ?? -1;
  const chartFollowLine = anchored ? chartTimedRows[anchoredLine?.follow ?? -1]?.lyric ?? -1 : chartLyricIndex.get(chartPosition.follow) ?? -1;
  const untimedText = !timed && !showChart ? syncText : "";
  const canFollowSheet = !LYRICS_ONLY_SHEET && ((timed && !showChart) || (showChart && (!!chartSync || anchored)));
  const timedPosition = !showChart && timed && canPlay ? timedSheetPosition(onlineRows, p.time) : null;
  const activeSheetRow = showChart ? chartActiveLine : timedPosition?.active ?? -1;
  const followRow = showChart ? chartFollowLine : timedPosition?.follow ?? activeSheetRow;
  useLayoutEffect(() => {
    if (!canFollowSheet || !followSheet || editingSheet || followRow < 0) return;
    const container = sheetExpanded ? expandedSheetRef.current : sheetRef.current;
    const row = container?.querySelector<HTMLElement>("[data-sheet-follow]");
    if (!container || !row || !container.clientHeight) return;
    const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const maxScroll = container.scrollHeight - container.clientHeight;
    const top = Math.min(maxScroll, Math.max(0, container.scrollTop + offset - container.clientHeight * .25));
    const distance = Math.abs(top - container.scrollTop);
    if (distance < 4) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({ top, behavior: reducedMotion || !p.playing || distance > container.clientHeight ? "instant" : "smooth" });
  }, [followRow, canFollowSheet, followSheet, sheetExpanded, editingSheet, sourceIdentity, onlineRows, p.playing]);

  const paintRef = useRef<(t: number) => void>(() => {});
  paintRef.current = (t: number) => {
    const root = dashboardRef.current;
    if (!root) return;
    const song = live.current.duration || dur;
    const frame = detailFrame(t, song);
    const waveHead = root.querySelector<HTMLElement>(".cd-wave-playhead");
    if (waveHead && song > 0) waveHead.style.left = `${frame.t / song * 100}%`;
    const svg = root.querySelector<SVGSVGElement>(".cd-wave svg");
    const played = root.querySelector<SVGRectElement>("#cdPlayed rect");
    if (played && svg && song > 0) played.setAttribute("width", String(frame.t / song * svg.viewBox.baseVal.width));
    const activeStart = activeAt(chords, frame.t)?.start ?? -1;
    const label = `${formatTimeFine(frame.t)} / ${formatTime(song)}`;
    for (const clock of root.querySelectorAll<HTMLElement>(".cd-clock")) {
      if (clock.textContent !== label) clock.textContent = label;
    }
    if (activeStart !== shownChord.current) {
      shownChord.current = activeStart;
      live.current.onAudible(frame.t);
    }
  };
  useLayoutEffect(() => { paintRef.current(live.current.readTime()); });
  useEffect(() => {
    if (!canPlay || !p.playing) return;
    return live.current.watchClock((t) => paintRef.current(t));
  }, [canPlay, p.playing]);

  const seekFromSheet = (time: number) => {
    setFollowSheet(true);
    p.onSeek(time);
  };
  // Both render surfaces use this same resolved text and timing state.
  const hasLyrics = Boolean(untimedText || timed || showChart);
  // Generating is offered only when the providers have nothing usable for
  // this recording and the audio is at hand, so the local model can listen.
  const selectedProvider = hasManualText ? null : lookup?.selected ?? null;
  const [pendingDraft, setPendingDraft] = useState<{ key: string; original: string; provider: string | null; result: GenerateResult } | null>(null);
  type LyricRevision = {
    key: string; original: string; accepted: string; provider?: string;
    originalProvider?: string; generation?: NonNullable<typeof generated>;
    library?: NonNullable<typeof pickedLibrary>;
  };
  const [priorLyrics, setPriorLyrics] = useState<LyricRevision | null>(null);
  const priorLyricsKey = textKey && textKey + ":prior-lyrics";
  const storedPriorLyrics = useMemo<typeof priorLyrics>(() => {
    try { return priorLyricsKey ? JSON.parse(localStorage.getItem(priorLyricsKey) ?? "null") : null; }
    catch { return null; }
  }, [priorLyricsKey]);
  const previousLyrics = priorLyrics?.key === priorLyricsKey ? priorLyrics : storedPriorLyrics;
  const reviewDraft = pendingDraft?.key === generationKey && pendingDraft.original === customText
    && pendingDraft.provider === selectedProvider ? pendingDraft : null;
  const [generateNotice, setGenerateNotice] = useState("");
  const [libraryOffer, setLibraryOffer] = useState<{ key: string; transcript: string; match: LibraryMatch } | null>(null);
  const generateJob = useRef<string | null>(null);
  const generationTarget = useRef({ textKey, customText, editingSheet, selectedProvider });
  generationTarget.current = { textKey, customText, editingSheet, selectedProvider };
  useEffect(() => {
    setGenerating(false);
    setCheckedGeneration("");
    setGenerateNotice("");
    return () => {
      const job = generateJob.current;
      generateJob.current = null;
      if (job) void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("cancel_lyrics_alignment", { job })).catch(() => {});
    };
  }, [generateKey]);
  const offer = libraryOffer?.key === generateKey && libraryOffer.transcript === customText ? libraryOffer : null;
  const romanizedBulgarian = /\b(?:nqkoi|nyakoi|nyakoy)\b/i.test(customText) && /\b(?:wsichki|vsichki)\b/i.test(customText);
  const draftLanguage = preferredLyricsLanguage !== "auto" ? preferredLyricsLanguage
    : romanizedBulgarian || currentAlignment?.language === "bg" ? "bg"
    : generationLanguage && generationLanguage !== "auto" ? generationLanguage : undefined;
  const canRegenerate = hasLyrics;
  const canGenerate = Boolean(r && canPlay && p.tauri && generateKey && !editingSheet && !reviewDraft && !recoveringGeneration
    && (canRegenerate || (!lookup?.pending && lookup?.state === "ready")));
  const storeGenerated = (result: GenerateResult) => {
    const timing = { key: generationKey, duration: lookupDuration, result };
    setGenerated(timing);
    try {
      const serialized = JSON.stringify(timing);
      if (serialized.length <= 360000) localStorage.setItem(generationKey, serialized);
    } catch {}
  };
  const useTranscript = (result: GenerateResult) => {
    storeGenerated(result);
    try { localStorage.removeItem(preserveGenerationKey); } catch {}
    saveSheetText(generatedLyricBody(result));
    setGenerateNotice(t("Generated from the recording. Check the words against the song before you rely on them."));
    if (sharedRecording) {
      const lines = result.lines?.map(line => line.text.trim()).filter(Boolean) ?? [];
      const language = lyricLanguage(result.language);
      void verifyLyrics(lines, language, true).then(proof => {
        if (proof && generationTarget.current.textKey === textKey) return publishVerifiedLyrics(lines, "generated", proof, language);
      }).catch(() => {});
    }
  };
  const startGenerate = async () => {
    if (!generateKey || !audioPath || generateJob.current) return;
    const job = crypto.randomUUID();
    generateJob.current = job;
    setGenerating(true);
    setGenerateNotice("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (generateJob.current !== job) return;
      const result = await invoke<GenerateResult>("align_lyrics", { job, request: {
        path: audioPath, lines: [], duration: lookupDuration, version: "generate", transcribe: true,
        language: draftLanguage ?? generationLanguage,
        refresh: useGeneratedTiming,
      } });
      if (generateJob.current !== job || generationTarget.current.editingSheet || generationTarget.current.customText !== customText
          || generationTarget.current.selectedProvider !== selectedProvider) return;
      const lines = result.lines ?? [];
      if (result.state === "generated" && lines.length) {
        const transcript = generatedLyricBody(result);
        if (hasLyrics) setPendingDraft({ key: generationKey, original: customText, provider: selectedProvider, result });
        else useTranscript(result);
        if (lookup) {
          const match = await lyricsOperation<{ match: LibraryMatch | null }>({
            action: "match-transcript", song: lookup.song, metadata: lookup.metadata,
            transcript: transcript.slice(0, 18000), detectedLanguage: result.language,
          }).catch(() => null);
          if (generateJob.current === job && match?.match) setLibraryOffer({ key: generateKey, transcript, match: match.match });
        }
      } else if (result.state === "unavailable") {
        setGenerateNotice(t("The local transcription model is not installed. Run the lyrics alignment setup to enable it."));
      } else {
        setGenerateNotice(t("No words were recognised in this recording."));
      }
    } catch (error) {
      if (generateJob.current === job) setGenerateNotice(t("Analysis failed") + " · " + String(error));
    } finally {
      if (generateJob.current === job) {
        generateJob.current = null;
        setGenerating(false);
      }
    }
  };
  const lyricsNotice = generateNotice ? generateNotice
    : hasLyrics && recoveringAudio ? t("Preparing audio…")
    : hasLyrics && recoveringGeneration && mayUpgradeGenerated ? t("Checking lyrics against the recording…")
    : hasLyrics && currentAlignment?.state === "running" && cancelledKey !== alignmentKey ? t("Synchronizing lyrics locally…")
    : showChart && !anchored ? (chartSync ? "" : t("Not synchronized"))
    : hasTimingEdits ? t("Timing adjusted")
    : manualTimes.length ? t("Manually synchronized")
    : usingAuto ? (currentAlignment && currentAlignment.matched !== currentAlignment.total
      ? t("Partially synchronized automatically") + ` · ${currentAlignment.matched}/${currentAlignment.total}`
      : t("Automatically synchronized"))
    : timed ? "" : hasLyrics && !canPlay && r?.source.fromYoutube ? t("Reload audio to synchronize")
    : hasLyrics ? t("Not synchronized")
    : lookup?.pending ? t("Finding lyrics…")
    : lookup?.state === "rate-limited" ? t("Lyrics provider is busy. Please try again later.")
    : lookup?.unavailable ? t("Lyrics service unavailable")
    : lookup && !hasManualText ? t("No matching lyrics") : "";
  const showSync = Boolean(syncKey && canSyncText) && !editingSheet && !chart?.length;
  const reloadable = Boolean(r?.source.fromYoutube && (r.source.youtubeId || r.source.url));
  const textRows = useMemo(() => {
    let heading = "";
    return customText.split(/\r?\n/).flatMap(line => {
      if (/^\[[^\]]+\]$/.test(line.trim())) {
        heading = line.trim();
        return [];
      }
      const row = { heading, text: line };
      heading = "";
      return [row];
    });
  }, [customText]);
  const sheetText = () => {
    if (showChart && lyricChart) return lyricChart.map(row => row.section ? row.text
      : [row.chords.map(chord => transposeSongbookChord(chord.label, chartSync?.transpose ?? 0)).join("  "), row.text]
        .filter(Boolean).join("\n")).join("\n");
    if (untimedText) return untimedText;
    if (alignedText) return customText;
    if (timed) return onlineRows.map(row =>
      [row.chords.map(chordText).join("  "), row.text].filter(Boolean).join("\n")
    ).join("\n\n");
    const text = sheetRows.map((row, index) => {
      const chordLine = row.map(chordText).join("  ");
      return [textRows[index]?.heading, chordLine, textRows[index]?.text].filter(Boolean).join("\n");
    }).join("\n\n");
    return online?.plain && !online.lines.length
      ? `${text}\n\n${t("Untimed lyrics")} (${online.provider})\n${online.plain}` : text;
  };
  const singingSections = useMemo(() => LYRICS_ONLY_SHEET ? singingLyrics(syncText, hasManualText) : [],
    [syncText, hasManualText]);
  const singingStatus = singingSections.length ? "" : lookup?.pending ? t("Finding lyrics…")
    : lookup?.state === "rate-limited" ? t("Lyrics provider is busy. Please try again later.")
    : lookup?.state === "metadata-needed" ? t("Enter a song title to find lyrics.")
    : lookup?.unavailable ? t("Lyrics service unavailable")
    : lookup ? t("No matching lyrics") : NA;
  const singingHeading = (section: (typeof singingSections)[number]) => section.heading ??
    (section.kind === "Chorus" ? t("Chorus") : section.kind === "Verse" ? t("Verse {number}", { number: section.number ?? 1 })
      : section.kind === "Section" ? t("Section {number}", { number: section.number ?? 1 }) : "");
  const singingText = () => singingSections.map(section =>
    [singingHeading(section), ...section.lines].filter((line, index) => index > 0 || line).join("\n")).join("\n\n");
  const sheetPicker = <div className="cd-choice cd-sheet-choice" role="group" aria-label={t("Lyrics Sheet")}>
    <button type="button" className="cd-icon-btn cd-sheet-search" disabled={!lookup || editingSheet}
      title={t("Lyrics options")} aria-label={t("Lyrics options")}
      onClick={() => lyricsControls.current?.open()}><Icon name="search" size={15} /></button>
  </div>;
  const alignedText = useMemo(() => {
    const lines = customText.split(/\r?\n/).filter(line => line.trim() && !/^\[[^\]]+\]$/.test(line.trim()));
    const chordLine = /^(?:[A-G][#b♯♭]?(?:maj|min|m|dim|aug|sus|add)?[0-9]*(?:\/[A-G][#b♯♭]?)?)(?:\s+[A-G][#b♯♭]?(?:maj|min|m|dim|aug|sus|add)?[0-9]*(?:\/[A-G][#b♯♭]?)?)*$/;
    return lines.length > 0 && lines.length % 2 === 0 && lines.every((line, index) =>
      chordLine.test(line.trim()) === (index % 2 === 0));
  }, [customText]);
  const saveSheetText = (value: string) => {
    if (!textKey) return false;
    try {
      if (value.trim()) localStorage.setItem(textKey, value);
      else localStorage.removeItem(textKey);
    } catch { return false; }
    setSheetDraft({ key: textKey, value });
    return true;
  };
  const writeBlocks = (blocks: LeadLine[], record = true) => {
    if (verifyingLyrics) return;
    if (record && editBlocks) {
      sheetPast.current = [...sheetPast.current.slice(-49), editBlocks];
      sheetFuture.current = [];
    }
    setEditBlocks(blocks);
    setEditNotice("");
    setSheetHistory(value => value + 1);
  };
  const placeSection = (code: string) => {
    const blocks = editBlocks ?? parseLeadSheet(customText);
    const tag = nextSectionTag(blocks, code);
    const last = blocks.at(-1);
    writeBlocks(last && !last.tag && !last.chords.trim() && !last.text.trim()
      ? blocks.slice(0, -1).concat({ ...last, tag })
      : [...blocks, { tag, chords: "", text: "" }]);
    setSectionMenu(false);
  };
  const beginEdit = () => {
    const source = lyricChart?.some(row => row.chords.length)
      ? formatLeadSheet(chartToLead(lyricChart, chartSync?.transpose ?? 0))
      : customText.trim() || syncText;
    sheetPast.current = [];
    sheetFuture.current = [];
    const blocks = parseLeadSheet(source);
    editOriginalLines.current = lyricDraftLines(blocks);
    cancelLyricVerification();
    setVerifyingLyrics(false);
    setEditBlocks(blocks);
    setEditNotice("");
    setEditingSheet(true);
    setCompactSheetView("lyrics");
    setSheetExpanded(true);
  };
  const undoSheet = () => {
    if (verifyingLyrics) return;
    const previous = sheetPast.current.at(-1);
    if (!previous || !editBlocks) return;
    sheetPast.current = sheetPast.current.slice(0, -1);
    sheetFuture.current = [...sheetFuture.current, editBlocks];
    setEditBlocks(previous);
    setEditNotice("");
    setSheetHistory(value => value + 1);
  };
  const redoSheet = () => {
    if (verifyingLyrics) return;
    const next = sheetFuture.current.at(-1);
    if (!next || !editBlocks) return;
    sheetFuture.current = sheetFuture.current.slice(0, -1);
    sheetPast.current = [...sheetPast.current, editBlocks];
    setEditBlocks(next);
    setEditNotice("");
    setSheetHistory(value => value + 1);
  };
  const editorBlocks = editBlocks ?? parseLeadSheet(customText);
  const canUndo = sheetHistory >= 0 && sheetPast.current.length > 0;
  const canRedo = sheetHistory >= 0 && sheetFuture.current.length > 0;
  const sectionGroups = editorBlocks.reduce<number[][]>((groups, block, index) => {
    if (block.tag || !groups.length) groups.push([index]);
    else groups[groups.length - 1].push(index);
    return groups;
  }, []);
  const moveSection = (groupIndex: number, direction: -1 | 1) => {
    const target = groupIndex + direction;
    if (target < 0 || target >= sectionGroups.length) return;
    const order = sectionGroups.map(group => group.map(index => editorBlocks[index]));
    const [moved] = order.splice(groupIndex, 1);
    order.splice(target, 0, moved);
    writeBlocks(order.flat());
  };
  const openSheet = (view: "lyrics" | "diagrams" = "lyrics") => {
    setCompactSheetView(view);
    setSheetExpanded(true);
  };
  const saveRevision = (accepted: string, provider?: string) => {
    const revision: LyricRevision = {
      key: priorLyricsKey, original: customText, accepted, provider, originalProvider: selectedProvider ?? undefined,
      generation: generation && generatedResult ? generation : undefined,
      library: librarySelection?.title ? librarySelection : undefined,
    };
    setPriorLyrics(revision);
    try { localStorage.setItem(priorLyricsKey, JSON.stringify(revision)); } catch {}
  };
  const setLibraryCredit = (library: LyricRevision["library"]) => {
    setPickedLibrary(library ?? { key: libraryKey, title: "", provider: "" });
    try {
      if (library) localStorage.setItem(libraryKey, JSON.stringify(library));
      else localStorage.removeItem(libraryKey);
    } catch {}
  };
  const applyLyricsAction: LyricsAction = async (action, data) => {
    if (action === "import") {
      const imported = await p.onLyricsAction(action, { ...data, inspect: true });
      if (!imported || typeof imported === "string") return imported;
      if (!sameLyricTarget()) return;
      const text = imported.chart?.length ? formatLeadSheet(chartToLead(imported.chart, 0))
        : imported.plain || imported.lines.map(line => line.text).join("\n");
      const lines = lyricDraftLines(parseLeadSheet(text));
      const { proof, language } = await checkImportedLyrics(lines, imported.language);
      if (!sameLyricTarget()) return;
      if (hasLyrics) saveRevision(text);
      setLibraryCredit(undefined);
      saveSheetText(text);
      setGenerateNotice("");
      void publishVerifiedLyrics(lines, "imported", proof, language);
      return "imported";
    }
    const candidate = action === "choose" ? lookup?.candidates.find(item => item.id === data?.candidate) : undefined;
    const imported = candidate?.rights === "user-authorized-local-import" ? candidate : undefined;
    const lines = imported ? singingLyrics(imported.plain || imported.lines.map(line => line.text).join("\n"), false)
      .flatMap(section => section.lines) : [];
    const checked = imported ? await checkImportedLyrics(lines, imported.language) : null;
    if (!sameLyricTarget()) return;
    const selected = await p.onLyricsAction(action, data);
    const target = generationTarget.current;
    if (typeof selected === "string" && (action === "choose" || action === "auto")
        && (hasManualText || selected !== selectedProvider) && target.textKey === textKey
        && target.customText === customText && !target.editingSheet) {
      if (hasLyrics) saveRevision("", selected);
      setLibraryCredit(undefined);
      setGenerateNotice("");
      saveSheetText("");
      if (checked) void publishVerifiedLyrics(lines, "imported", checked.proof, checked.language);
    }
    return selected;
  };
  const matchesRevision = previousLyrics && previousLyrics.accepted === customText
    && (previousLyrics.provider ?? null) === selectedProvider;
  const canRestoreLibrary = Boolean(librarySelection?.title && librarySelection.text === customText && generatedBackup);
  const canRestorePrevious = Boolean(matchesRevision || canRestoreLibrary);
  const restorePreviousLyrics = async () => {
    if (matchesRevision) {
      if (previousLyrics.originalProvider) {
        const selected = await p.onLyricsAction("choose", { candidate: previousLyrics.originalProvider });
        if (selected !== previousLyrics.originalProvider || generationTarget.current.textKey !== textKey
            || generationTarget.current.customText !== customText) return;
      }
      if (previousLyrics.generation) {
        setGenerated(previousLyrics.generation);
        try { localStorage.setItem(generationKey, JSON.stringify(previousLyrics.generation)); } catch {}
      }
      setLibraryCredit(previousLyrics.library);
      try { localStorage.setItem(preserveGenerationKey, previousLyrics.original); } catch {}
      saveSheetText(previousLyrics.original);
      setGenerateNotice("");
      return;
    }
    if (canRestoreLibrary) {
      setPickedLibrary({ key: libraryKey, title: "", provider: "" });
      try { localStorage.removeItem(libraryKey); } catch {}
      setGenerateNotice("");
      saveSheetText(generatedBackup);
    }
  };
  const syncStatus = <>
    {reviewDraft && <div className="cd-lyrics-draft">
      <details>
        <summary>{t("Preview generated lyrics")}</summary>
        <pre dir="auto">{generatedLyricBody(reviewDraft.result)}</pre>
      </details>
      <button type="button" className="lyrics-sync-action" onClick={() => {
        saveRevision(generatedLyricBody(reviewDraft.result));
        setLibraryCredit(undefined);
        setPendingDraft(null);
        useTranscript(reviewDraft.result);
      }}>{t("Use generated draft")}</button>
      <button type="button" className="lyrics-sync-action" onClick={() => setPendingDraft(null)}>{t("Keep current lyrics")}</button>
    </div>}

    {lyricsNotice && <small className="cd-lyrics-notice" role="status">{lyricsNotice}</small>}
    {offer && <>
      <small className="cd-lyrics-notice" role="status">{t("Matching lyrics found: {title}", { title: offer.match.title })}</small>
      <button type="button" className="lyrics-sync-action" onClick={() => {
        const entry = { key: libraryKey, title: offer.match.title, provider: offer.match.provider, text: offer.match.plain };
        saveRevision(offer.match.plain);
        setBackup({ key: backupKey, text: offer.transcript });
        setPickedLibrary(entry);
        try {
          localStorage.setItem(backupKey, offer.transcript);
          localStorage.setItem(libraryKey, JSON.stringify(entry));
        } catch {}
        setGenerateNotice("");
        setLibraryOffer(null);
        saveSheetText(offer.match.plain);
      }}>{t("Use Library Lyrics")}</button>
      <button type="button" className="lyrics-sync-action" onClick={() => setLibraryOffer(null)}>{t("Keep Generated Lyrics")}</button>
    </>}
    {librarySelection?.title && <small className="cd-lyrics-notice">{librarySelection.provider} · <bdi>{librarySelection.title}</bdi></small>}
    {lookup?.shared && !hasManualText && <small className="cd-lyrics-notice">{t("Shared library")}</small>}

    {showSync && !canPlay && !busy && reloadable &&
      <button type="button" className="lyrics-sync-action" disabled={p.mp3Busy}
        onClick={p.onReloadSource}>{t("Reload YouTube audio")}</button>}
    {showSync && !canPlay && !busy && <small className="cd-lyrics-notice lyrics-sync-unavailable">
      {t(reloadable ? "Saved analysis has no playable audio. Reload it to sync lyrics." : "Load playable audio to sync lyrics.")}
    </small>}
  </>;
  const canCancelAlignment = currentAlignment?.state === "running" && cancelledKey !== alignmentKey;
  const canCopySheet = LYRICS_ONLY_SHEET ? !!singingSections.length && (!online || online.canExport)
    : !!chords.length && (!online || online.canExport) && !librarySelection?.title;
  const copyLabel = LYRICS_ONLY_SHEET ? "Copy lyrics" : "Copy chord sheet";
  const copySheet = () => void copy(LYRICS_ONLY_SHEET ? singingText() : sheetText(), "sheet");
  const sharedRecording = r?.source.fromYoutube ? r.source.youtubeId ?? youtubeVideoId(r.source.url ?? "") : r?.source.libraryRecording;
  const foundLyricsLanguage = generatedResult?.language || draftLanguage || generationLanguage;
  const lyricLanguage = (value?: string) => /^[a-z]{2,3}$/.test(value?.split(/[-_]/)[0] ?? "") ? value!.split(/[-_]/)[0] : "auto";
  const sameLyricTarget = () => {
    const target = generationTarget.current;
    return target.textKey === textKey && target.customText === customText && !target.editingSheet;
  };
  const verifyLyrics = async (lines: string[], language = lyricLanguage(foundLyricsLanguage), afterGeneration = false): Promise<LyricsVerification | null> => {
    if (!audioPath || !p.tauri || lyricVerificationJob.current || (!afterGeneration && generateJob.current) || recoveringGeneration) return null;
    const job = crypto.randomUUID();
    lyricVerificationJob.current = job;
    setVerifyingLyrics(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (lyricVerificationJob.current !== job) return null;
      const result = await invoke<{ state: string; proof?: LyricsVerification }>("align_lyrics", { job, request: {
        verifyDraft: true, lines, path: audioPath, duration: lookupDuration, language,
      } });
      if (lyricVerificationJob.current !== job) return null;
      if (result.state === "unavailable") throw new Error("The local transcription model is not installed. Run the lyrics alignment setup to enable it.");
      return result.state === "verified" ? result.proof ?? null : null;
    } finally {
      if (lyricVerificationJob.current === job) {
        lyricVerificationJob.current = null;
        setVerifyingLyrics(false);
      }
    }
  };
  const checkImportedLyrics = async (lines: string[], hint?: string) => {
    if (!audioPath) throw new Error("Load playable audio to check the lyrics.");
    const language = lyricLanguage(hint === "unknown" ? undefined : hint ?? foundLyricsLanguage);
    const proof = await verifyLyrics(lines, language);
    if (!proof) throw new Error("The recording did not confirm these lyrics. Review the words and try again.");
    return { proof, language };
  };
  const publishVerifiedLyrics = async (lines: string[], origin: LyricContribution, proof: LyricsVerification, language: string) => {
    if (!sharedRecording) return;
    try {
      const published = await contributeLyrics(sharedRecording, language, lines, origin, proof);
      if (generationTarget.current.textKey === textKey) setGenerateNotice(t(published
        ? "Lyrics added to the shared library." : "Lyrics saved on this device. This recording has no matching shared reference."));
    } catch {
      if (generationTarget.current.textKey === textKey) setGenerateNotice(t("Shared library is unavailable."));
    }
  };
  const dismissSheetEdits = () => {
    cancelLyricVerification();
    setVerifyingLyrics(false);
    setEditBlocks(null);
    setEditingSheet(false);
    setSectionMenu(false);
    setEditNotice("");
  };
  const saveEditedSheet = () => {
    const lines = lyricDraftLines(editorBlocks);
    const changed = lyricDraftWords(editOriginalLines.current).join(" ") !== lyricDraftWords(lines).join(" ");
    const accepted = formatLeadSheet(editorBlocks);
    if (!saveSheetText(accepted)) {
      setEditNotice("Could not save the lyrics on this device.");
      return;
    }
    if (accepted !== customText) {
      saveRevision(accepted);
      try { localStorage.setItem(preserveGenerationKey, accepted); } catch {}
    }
    if (changed) setLibraryCredit(undefined);
    dismissSheetEdits();
    setGenerateNotice(t("Lyrics saved on this device."));
    if (changed && sharedRecording) {
      const language = lyricLanguage(foundLyricsLanguage);
      void verifyLyrics(lines, language).then(proof => {
        if (proof && generationTarget.current.textKey === textKey && generationTarget.current.customText === accepted) {
          return publishVerifiedLyrics(lines, "edited", proof, language);
        }
      }).catch(() => {});
    }
  };

  const lyricsActions = (close: () => void) => <>
    <button type="button" className="lyrics-sync-action" disabled={!canGenerate || generating}
      onClick={() => { close(); void startGenerate(); }}>{t(generating ? "Generating…" : canRegenerate ? "Regenerate Lyrics" : "Generate")}</button>
    {canRestorePrevious && <button type="button" className="lyrics-sync-action" disabled={editingSheet}
      onClick={() => { close(); void restorePreviousLyrics().catch(() => setGenerateNotice(t("Lyrics service unavailable"))); }}>{t("Restore Previous Lyrics")}</button>}

    {canCancelAlignment && <button type="button" className="lyrics-sync-action"
      onClick={() => { close(); setCancelledKey(alignmentKey); }}>{t("Cancel alignment")}</button>}
    {showSync && (manualTimes.length > 0 || Object.keys(timingEdits).length > 0) && <button type="button" className="lyrics-sync-action" onClick={() => {
      try { localStorage.removeItem(syncKey); localStorage.removeItem(syncKey + ":adjustments"); } catch { return; }
      setCancelledKey("");
      setSyncRevision(value => value + 1);
      close();
    }}>{t("Reset timing")}</button>}
    {compact && !sheetExpanded && <>
      <button type="button" className="lyrics-sync-action" disabled={!textKey}
        onClick={() => { close(); beginEdit(); }}>{t("Edit")}</button>
      <button type="button" className="lyrics-sync-action" disabled={!canCopySheet}
        onClick={copySheet}>{t(copied === "sheet" ? "Copied" : copyLabel)}</button>
    </>}
  </>;
  const editSheetChord = (index: number) => {
    const selected = chords[index];
    if (!selected) return;
    const original = sourceChords.findIndex(chord => chord.start === selected.start);
    if (original < 0) return;
    setEditError("");
    setEditing(original);
    if (!sheetExpanded) openSheet();
  };
  const togglePlayback = () => {
    if (p.playing || counting.current) {
      counting.current = false;
      clicks.current?.cancel();
      if (p.playing) p.onToggle();
      return;
    }
    const start = async () => {
      if (countIn && clickBpm > 0) {
        counting.current = true;
        const ready = await clicks.current?.countIn(clickMeter.bar, 60 / (clickBpm * speed), clickMeter.subdivisions);
        counting.current = false;
        if (!ready) return;
        if (loopOn && markA != null) p.onSeek(markA);
      }
      p.onToggle();
    };
    void start();
  };
  const loopReady = markA != null && markB != null && markB > markA + 0.2;
  const mark = (which: "a" | "b") => {
    const at = Math.min(dur, Math.max(0, p.readTime()));
    if (which === "a") {
      setMarkA(at);
      if (markB != null && markB <= at + 0.2) setMarkB(null);
    } else if (markA != null && at > markA + 0.2) {
      setMarkB(at);
    }
  };
  const toggleLoop = () => {
    if (loopOn) {
      p.onLoop(null);
      setMarkA(null);
      setMarkB(null);
    }
    setLoopOn(!loopOn);
  };
  const seekPlayer = (at: number) => {
    if (loopOn && markA != null && (at < markA || (loopReady && markB != null && at >= markB))) {
      p.onLoop(null);
      setMarkB(null);
      if (at < markA) setMarkA(null);
    }
    p.onSeek(at);
  };
  useImperativeHandle(p.shortcutRef, () => ({
    run(action) {
      if (!canPlay || welcome || replacing || exportOpen) return false;
      if (action === "playback") togglePlayback();
      else if (action === "loop") toggleLoop();
      else if (action === "restart") seekPlayer(0);
      else {
        const at = chordShortcutStart(chords, p.readTime(), action);
        if (at === undefined) return false;
        seekPlayer(at);
      }
      return true;
    },
  }));
  const chordEditor = editing !== null && sourceChords[editing] && (
    <form className="cd-chord-editor" key={editing} onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const display = String(data.get("chord")).trim();
      const start = Number(data.get("start"));
      const end = Number(data.get("end"));
      if (display !== "N.C." && !chordNotes(display)) {
        setEditError("Enter a supported chord such as Am, C:maj7, D/F#, or N.C.");
        return;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end
        || start < (sourceChords[editing - 1]?.end ?? 0) || end > (sourceChords[editing + 1]?.start ?? dur)) {
        setEditError("Choose times in seconds that do not overlap neighboring chords.");
        return;
      }
      p.onCorrectChord(editing, { start, end, display, label: display, score: null,
        scoreKind: "manual", kind: display === "N.C." ? "no_chord" : "chord" });
      setEditing(null);
    }}>
      <label>{t("Chord")} <input name="chord" defaultValue={sourceChords[editing].display} required maxLength={32} /></label>
      <label>{t("Start (s)")} <input name="start" type="number" step="any" defaultValue={sourceChords[editing].start} required /></label>
      <label>{t("End (s)")} <input name="end" type="number" step="any" defaultValue={sourceChords[editing].end} required /></label>
      <button className="cd-btn" type="submit">{t("Save")}</button>
      <button className="cd-btn" type="button" onClick={() => setEditing(null)}>{t("Cancel")}</button>
      {editError && <span role="alert">{t(editError)}</span>}
    </form>
  );
  const renderTimedWords = (line: TimedSheetRow, current: boolean) => {
    const anchors = lyricAnchors?.get(line.start);
    if (!anchors?.length || !line.text || line.text.includes("\n")) return null;
    const words = Array.from(line.text.matchAll(/[\p{L}\p{N}]+/gu));
    const anchored = new Map<number, ChordSegment[]>();
    for (const chord of line.chords) {
      const word = chordWordIndex(chord, line, anchors);
      if (!words[word]) continue;
      const group = anchored.get(word) ?? [];
      group.push(chord);
      anchored.set(word, group);
    }
    const chip = (chord: ChordSegment & { printed?: string }, index: number) => <button type="button" key={index}
      title={segTitle(chord, p.language)} disabled={!canPlay} aria-current={current && active === chord}
      className={(current && active === chord ? "current " : "") + (chord.kind !== "chord" ? "dim" : "")}
      onClick={() => seekFromSheet(Math.max(line.start, chord.start))}
      onDoubleClick={() => editSheetChord(chords.findIndex(item => item.start === chord.start && item.display === chord.display))}>{chordText(chord)}</button>;
    return <div className="cd-sheet-line cd-word-chart" dir="auto">
      {words.map((word, index) => {
        const start = index === 0 ? 0 : word.index!;
        const end = words[index + 1]?.index ?? line.text.length;
        return <div key={index} className="cd-word-stack">
          <p>{(anchored.get(index) ?? []).map((chord, i) => chip(chord, i))}</p>
          <span>{line.text.slice(start, end)}</span>
        </div>;
      })}
    </div>;
  };
  const compactSectionName = (heading: string) => {
    const legacyVerse = /^\[S(\d+)\]$/i.exec(heading);
    if (legacyVerse) return t("Verse {number}", { number: Number(legacyVerse[1]) });
    const section = sectionKind(heading);
    if (section?.name === "Verse") return t("Verse {number}", { number: section.number });
    return section ? t(section.name) : "";
  };
  const renderCompactSection = (heading: string) => {
    const name = compactSectionName(heading);
    return <span className="cd-compact-section" data-compact-section={heading}>
      <bdi>{heading}</bdi>{name && <span>{name}</span>}
    </span>;
  };
  const compactSectionTags = showChart && lyricChart
    ? lyricChart.filter(row => row.section).map(row => row.text)
    : timed ? [] : textRows.flatMap(row => row.heading ? [row.heading] : []);
  let activeSection = "";
  if (compact && activeSheetRow >= 0 && showChart && lyricChart) {
    let line = -1;
    for (const row of lyricChart) {
      if (row.section) activeSection = row.text;
      else if (row.text.trim() && ++line === activeSheetRow) break;
    }
  }
  const scrollSheetTo = (container: HTMLElement, row: HTMLElement) => {
    container.scrollTo({ top: container.scrollTop + row.getBoundingClientRect().top - container.getBoundingClientRect().top - 8 });
  };
  useLayoutEffect(() => {
    const container = sheetRef.current;
    if (!compact || !container) return;
    const query = lyricsQuery.trim().normalize().toLocaleLowerCase(p.language);
    const rows = container.querySelectorAll<HTMLElement>(
      ".cd-songbook-section, .cd-songbook-line, .cd-sheet-row, .cd-compact-plain-line, .cd-singing-section",
    );
    const matches = Array.from(rows).filter(row => {
      row.removeAttribute("data-sheet-match");
      return query && row.textContent?.normalize().toLocaleLowerCase(p.language).includes(query);
    });
    setLyricsMatchCount(matches.length);
    if (matches.length) {
      const row = matches[((lyricsMatch % matches.length) + matches.length) % matches.length];
      row.setAttribute("data-sheet-match", "");
      scrollSheetTo(container, row);
    }
  }, [compact, lyricsQuery, lyricsMatch, lyricChart, untimedText, onlineRows, sheetRows, transpose, p.language]);
  const renderSheet = (expanded = false) => LYRICS_ONLY_SHEET ? (
    <div className="cd-sheet cd-singing-sheet" tabIndex={0} aria-label={t("Lyrics Sheet")}>
      {expanded === sheetExpanded && lookup && <LyricsControls ref={lyricsControls} lookup={lookup} language={p.language}
        onAction={applyLyricsAction} manual={hasManualText} actions={lyricsActions} />}
      {singingStatus && <p className="cd-lyrics-notice" role="status">{singingStatus}</p>}
      {singingSections.map((section, index) => {
        const heading = singingHeading(section);
        return <section key={index} className="cd-singing-section" dir="auto">
          {heading && <h4>{heading}</h4>}
          <div className="cd-plain-lyrics">{section.lines.join("\n")}</div>
        </section>;
      })}
    </div>
  ) : (
    <div className="cd-sheet cd-sheet-with-text" ref={expanded ? expandedSheetRef : sheetRef}
      tabIndex={0} aria-label={t("Lyrics Sheet")}
      style={compact ? { "--compact-lyric-scale": lyricsScale / 100 } as React.CSSProperties : undefined}
      onWheel={event => {
        const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
        if ((event.deltaY < 0 && scrollTop > 0) ||
          (event.deltaY > 0 && scrollTop < scrollHeight - clientHeight - 1)) setFollowSheet(false);
      }}
      onTouchMove={event => {
        if (event.currentTarget.scrollHeight > event.currentTarget.clientHeight) setFollowSheet(false);
      }}
      onPointerDown={event => {
        const container = event.currentTarget;
        if (event.target === container && container.scrollHeight > container.clientHeight &&
          (event.clientX >= container.getBoundingClientRect().left + container.clientLeft + container.clientWidth ||
            event.clientX < container.getBoundingClientRect().left + container.clientLeft)) setFollowSheet(false);
      }}
      onKeyDown={event => {
        if (event.target === event.currentTarget && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) setFollowSheet(false);
      }}>
      {!expanded && lookup && <div className="lyrics-meta">
            <LyricsControls ref={lyricsControls} lookup={lookup} language={p.language} onAction={applyLyricsAction}
              manual={hasManualText} actions={lyricsActions} />
            {syncStatus}
          </div>}
      {expanded && (lyricsNotice || showSync || offer || reviewDraft || librarySelection?.title) && <div className="lyrics-meta">{syncStatus}</div>}
      {showChart && lyricChart ? <SongbookChart rows={lyricChart} activeLine={activeSheetRow} followLine={followRow}
        transpose={chartSync?.transpose ?? 0} sync={chartSync} detected={chords} canPlay={canPlay}
        activeDetected={activeIndex} time={p.time} onSeek={seekFromSheet}
        renderSection={compact ? renderCompactSection : undefined}
        onEdit={editSheetChord} editHint={t("double-click to edit")} />
        : untimedText ? <>
        <div className="cd-untimed-lyrics"><pre className={hasManualText ? "cd-aligned-sheet" : "cd-plain-lyrics"} dir="auto">{compact && !expanded
          ? untimedText.split(/\r?\n/).map((line, index) => <span className="cd-compact-plain-line" key={index}>{line || " "}</span>)
          : untimedText}</pre></div>
      </>
        : (timed ? onlineRows : sheetRows).length ? (timed ? onlineRows.map(row => row.chords) : sheetRows).map((row, index) => {
        const wordChart = timed ? renderTimedWords(onlineRows[index], index === activeSheetRow) : null;
        return <div key={index}>
        {timed && usingAuto && autoLines?.before.has(onlineRows[index].start) &&
          <div className="cd-sheet-row cd-untimed-lines"><div className="cd-sheet-line" dir="auto">{autoLines.before.get(onlineRows[index].start)}</div></div>}
        <div className={timed && onlineRows[index].text ? "cd-sheet-row cd-timed-lyric" : "cd-sheet-row"} data-sheet-current={index === activeSheetRow ? "" : undefined}
          data-sheet-follow={index === followRow ? "" : undefined}>
          {!timed && textRows[index]?.heading && <strong className="cd-sheet-section">
            {compact ? renderCompactSection(textRows[index].heading) : textRows[index].heading}
          </strong>}
          {wordChart}
          {!wordChart && row.length > 0 && (!timed || !onlineRows[index].text) && <p title={timed ? t("Detected chords") : undefined}>{row.map((chord, chordIndex) => {
            const current = index === activeSheetRow && active === chord;
            return <button type="button" key={chordIndex} title={segTitle(chord, p.language)}
              aria-label={segTitle(chord, p.language)} disabled={!canPlay} aria-current={current}
              className={(current ? "current " : "") + (chord.kind !== "chord" ? "dim" : "")}
              onClick={() => seekFromSheet(timed ? Math.max(chord.start, onlineRows[index].start) : chord.start)}
              onDoubleClick={() => editSheetChord(chords.findIndex(item => item.start === chord.start && item.display === chord.display))}>{chordText(chord)}</button>;
          })}</p>}
          {!wordChart && (timed ? onlineRows[index].text : textRows[index]?.text) &&
            <div className="cd-sheet-line" dir="auto">{timed ? onlineRows[index].text : textRows[index].text}</div>}
        </div>
        </div>
      }) : <span className="cd-na">{NA}</span>}
      {!showChart && timed && usingAuto && autoLines?.tail && <div className="cd-sheet-row cd-untimed-lines"><div className="cd-sheet-line" dir="auto">{autoLines.tail}</div></div>}
    </div>
  );
  const sheetActions = (expanded = false) => <div className="cd-sheet-actions">
    {canGenerate && !canRegenerate && <button type="button" className="cd-generate-btn" onClick={() => void startGenerate()} disabled={generating}>
      {t(generating ? "Generating…" : "Generate")}
    </button>}
    <button type="button" className="cd-icon-btn" disabled={!textKey} title={t("Edit")} aria-label={t("Edit")}
      onClick={beginEdit}><Icon name="feather" size={17} /></button>
    <button type="button" className="cd-icon-btn" disabled={!canCopySheet} onClick={copySheet}
      title={t(copied === "sheet" ? "Copied" : copyLabel)} aria-label={t(copied === "sheet" ? "Copied" : copyLabel)}>
      <Icon name={copied === "sheet" ? "check" : "copy"} size={17} />
    </button>
    <button type="button" className="cd-icon-btn" disabled={!expanded && !r}
      title={t(expanded ? "Close" : "Expand")} aria-label={t(expanded ? "Close" : "Expand")}
      onClick={() => expanded ? sheetDialog.current?.close() : openSheet()}>
      <Icon name={expanded ? "close" : "expand"} size={17} />
    </button>
  </div>;
  const sheetFooter = () => !LYRICS_ONLY_SHEET && r && <footer className="cd-sheet-footer">
    <span><Icon name="music" size={14} />{t("Current")}{compact && activeSection && <>
      <bdi className="cd-compact-current-section">{activeSection} {compactSectionName(activeSection)}</bdi><span aria-hidden="true">·</span>
    </>}<bdi>{active ? chordText(active) : NA}</bdi></span>
    <button type="button" className={compact ? "cd-compact-follow" : undefined}
      role={compact ? "switch" : undefined} aria-checked={compact ? canFollowSheet && followSheet : undefined}
      aria-pressed={compact ? undefined : canFollowSheet && followSheet} disabled={!canFollowSheet || !canPlay}
      onClick={() => {
        if (!followSheet && compact) setLyricsQuery("");
        setFollowSheet(value => !value);
      }}>
      <span>{t("Follow playback")}</span>{compact && <i aria-hidden="true" />}
    </button>
  </footer>;
  const compactSheetPicker = () => p.compactLayout && !editingSheet && (
    <div className="cd-choice cd-compact-sheet-choice" role="group" aria-label={t("Lyrics Sheet")}>
      <button type="button" aria-pressed={!showSheetDiagrams} onClick={() => setCompactSheetView("lyrics")}>{t("Lyrics Sheet")}</button>
      <button type="button" aria-pressed={showSheetDiagrams} onClick={() => setCompactSheetView("diagrams")}>{t("Chord Diagrams")}</button>
    </div>
  );
  const diagramSheetAction = (expanded = false) => (
    <button type="button" className="cd-icon-btn" aria-label={t(expanded ? "Close" : "Expand")}
      title={t(expanded ? "Close" : "Expand")} onClick={() => expanded ? sheetDialog.current?.close() : openSheet("diagrams")}>
      <Icon name={expanded ? "close" : "expand"} size={17} />
    </button>
  );
  const renderDiagramSheet = (expanded = false) => (
    <div className="cd-diagram-sheet" data-diagram-view={instrument === "Piano" && diagramView === "primary" ? "piano" : "notation"}>
      <div className="cd-diagram-sheet-tools">{instrumentPicker}{expanded ? viewPicker() :
        <div className="cd-compact-chord-legend">
          <span data-position="current">{t("Current chord")}</span>
          <span data-position="next">{t("Next chord")}</span>
        </div>}
      </div>
      {unique.length ? <div className="cd-diagram-sheet-grid" tabIndex={0} aria-label={t("All Chords in Song")}
        title={t(diagramNoteKey(instrument, diagramView))}>
        {unique.map(chord => {
          const position = chord.display === currentDiagramLabel ? "current" : chord.display === upcomingDiagramLabel ? "next" : undefined;
          return <Diagram key={chord.display} name={chord.shape}
            label={chord.display + (chord.kind === "uncertain" ? "?" : "")}
            active={position === "current"} sheetPosition={position}
            instrument={instrument} view={diagramView} capo={capo} language={p.language} />;
        })}
      </div> : <p className="cd-lib-empty">{NA}</p>}
      {expanded && <small className="cd-diagram-sheet-note">{t(diagramNoteKey(instrument, diagramView))}</small>}
    </div>
  );
  const renderCompactLyricsTools = () => <div className="cd-compact-lyrics-tools">
    <button type="button" className="cd-compact-tool" popoverTarget={compactSectionsId}
      title={t("Song Structure")} aria-label={t("Song Structure")} disabled={!compactSectionTags.length}>
      <Icon name="list" size={16} />
    </button>
    <div popover="auto" id={compactSectionsId} className="cd-compact-popover cd-compact-section-menu" aria-label={t("Song Structure")}>
      {compactSectionTags.map((heading, index) => <button key={index} type="button" onClick={event => {
        const container = sheetRef.current;
        const row = container?.querySelectorAll<HTMLElement>("[data-compact-section]")[index];
        if (container && row) {
          setFollowSheet(false);
          setLyricsQuery("");
          scrollSheetTo(container, row);
        }
        event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
      }}>{compactSectionName(heading) || heading}</button>)}
    </div>
    <label className="cd-compact-search">
      <Icon name="search" size={16} />
      <input type="search" aria-label={t("Search lyrics or chords…")} placeholder={t("Search lyrics or chords…")}
        value={lyricsQuery} onChange={event => {
          setLyricsQuery(event.target.value);
          setLyricsMatch(0);
          if (event.target.value.trim()) setFollowSheet(false);
        }} onKeyDown={event => {
          if (event.key === "Enter" && lyricsMatchCount) {
            event.preventDefault();
            setLyricsMatch(index => index + (event.shiftKey ? -1 : 1));
          } else if (event.key === "Escape") setLyricsQuery("");
        }} />
    </label>
    <div className="cd-compact-font" role="group" aria-label={t("Lyrics text size")}>
      <button type="button" aria-label={t("Decrease lyrics text size")} disabled={lyricsScale <= 80}
        onClick={() => setLyricsScale(value => value - 10)}>A−</button>
      <button type="button" aria-label={t("Reset")} onClick={() => setLyricsScale(100)}><bdi>{lyricsScale}%</bdi></button>
      <button type="button" aria-label={t("Increase lyrics text size")} disabled={lyricsScale >= 140}
        onClick={() => setLyricsScale(value => value + 10)}>A+</button>
    </div>
  </div>;

  const wavePath = useMemo(() => {
    const w = r?.waveform ?? [];
    let d = "";
    for (let i = 0; i < w.length; i++) { const h = Math.max(0.6, w[i] * 46); d += `M${i + 0.5} ${50 - h}V${50 + h}`; }
    return { d, n: Math.max(1, w.length) };
  }, [r]);

  const transposeControl = (
          <div className="cd-transpose-row">
            <span className="cd-transpose-label">{t("Transpose")}</span>
            <div className="cd-transpose" dir="ltr" role="group" aria-label={t("Transpose")}>
              <button type="button" className="cd-transpose-step" aria-label={t("Transpose down")} title={t("Transpose down")}
                disabled={!r || transpose <= -11} onClick={() => setTranspose(Math.max(-11, transpose - 1))}>−</button>
              {standard
                ? <button type="button" className="cd-transpose-value cd-summary-reset" data-active={transpose !== 0}
                    aria-label={`${t("Reset")} · ${transpose > 0 ? `+${transpose}` : transpose}`} title={t("Reset")}
                    disabled={!r} onClick={() => setTranspose(0)}><span aria-live="polite">{transpose > 0 ? `+${transpose}` : transpose}</span></button>
                : <span className="cd-transpose-value" data-active={transpose !== 0} aria-live="polite">{transpose > 0 ? `+${transpose}` : transpose}</span>}
              <button type="button" className="cd-transpose-step" aria-label={t("Transpose up")} title={t("Transpose up")}
                disabled={!r || transpose >= 11} onClick={() => setTranspose(Math.min(11, transpose + 1))}>+</button>
              {!standard && <button type="button" className="cd-transpose-reset" aria-label={t("Reset")} title={t("Reset")}
                disabled={!r} onClick={() => setTranspose(0)}><Icon name="refresh" size={13} /></button>}
            </div>
          </div>
  );

  return (
    <div className={`cd${welcome ? " cd-is-welcome" : busy ? " cd-is-analyzing" : ""}${standard ? " cd-standard" : compact ? " cd-compact" : ""}`} ref={dashboardRef}>
      {(welcome || !r || replacing) && <section ref={uploadPanel} className={"cd-upload" + (replacing ? " cd-upload-change" : "")}
        onKeyDown={event => {
          if (replacing && event.key === "Escape") closeChangeSong();
        }}>
        {replacing && <div className="cd-change-header">
          <h3>{t("Change Song")}</h3>
          <button ref={changeSongCancel} type="button" className="cd-btn" disabled={busy} onClick={closeChangeSong}><Icon name="close" size={18} />{t("Cancel")}</button>
        </div>}
        <button type="button" className={"cd-drop" + (dragOver ? " dragging" : "")} disabled={busy || p.mp3Busy || !p.tauri} onClick={p.onBrowse}
          title={p.tauri ? t("Drop an audio file or click to browse") : t("File analysis needs the desktop app")}>
          <Icon name="upload" size={54} />
          <span><strong dir="auto">{labels[6]}</strong><small>MP3, WAV, FLAC, M4A, AAC, OGG</small></span>
        </button>
        <span className="cd-or">{t("or")}</span>
        <YoutubeInput key={replacing ? "replacement" : "initial"}
          value={replacing ? replacementUrl : p.youtubeUrl}
          onChange={replacing ? setReplacementUrl : p.onYoutubeUrl}
          onAnalyze={() => p.onAnalyzeYoutube(replacing ? replacementUrl : undefined)}
          searchRequested={p.youtubeSearchRequested}
          onSearchFocused={p.onYoutubeSearchFocused}
          disabled={busy || p.mp3Busy} canAnalyze={replacing ? p.tauri && isLikelyYoutubeUrl(replacementUrl) : p.canAnalyzeYoutube}
          desktop={p.tauri} language={p.language} />
      </section>}

      {!welcome && (r || busy || p.status.kind === "error") && <section className="cd-card cd-song">
        <button type="button" className="cd-art" disabled={!canPlay} onClick={togglePlayback} aria-label={p.playing ? t("Pause") : t("Play")}>
          <svg viewBox="0 0 95 64" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="cdSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5b4fd6" /><stop offset=".45" stopColor="#d66aa6" /><stop offset=".7" stopColor="#f6a46b" /></linearGradient></defs>
            <rect width="95" height="64" fill="url(#cdSky)" />
            <circle cx="56" cy="34" r="10" fill="#ffd7a0" opacity=".9" />
            <path d="M0 44 18 30 30 38 46 24 62 36 74 28 95 40V64H0Z" fill="#3a2f7a" />
            <path d="M0 52 22 40 40 48 58 38 78 47 95 42V64H0Z" fill="#231d55" />
          </svg>
          {thumbnailId && thumbnailId !== failedThumbnail && <img
            src={`https://i.ytimg.com/vi/${thumbnailId}/mqdefault.jpg`}
            alt="" referrerPolicy="no-referrer" onError={() => setFailedThumbnail(thumbnailId)}
          />}
          <span className="cd-art-play"><Icon name={p.playing ? "pause" : "play"} size={13} /></span>
        </button>
        <div className="cd-song-name">
          <h2 title={title}>{title}</h2>
          {r && <span className="cd-song-source"><bdi>{clock(dur)}</bdi><span aria-hidden="true">·</span>{r.source.fromYoutube
            ? <svg viewBox="0 0 24 17" width="17" height="12" aria-hidden="true"><rect width="24" height="17" rx="4" fill="#ff0033" /><path d="M10 4.8v7.4l6-3.7Z" fill="white" /></svg>
            : <Icon name="folder" size={15} />}{t(r.source.fromYoutube ? "YouTube" : "Local file")}</span>}
          {p.status.kind === "ready" && p.status.playbackError && (
            <span className="err" title={p.status.playbackError}>{t("Playback unavailable: {message}", { message: localizeMessage(p.language, p.status.playbackError) })}</span>
          )}
          {busy && p.status.kind === "loading" && (
            <span className="cd-progress">
              <span title={p.status.message || p.status.phase}>{localizeMessage(p.language, p.status.message || p.status.phase, p.status.phase)} · {Math.round(p.status.pct)}%</span>
              <i><b style={{ width: `${Math.min(100, p.status.pct)}%` }} /></i>
            </span>
          )}
          {p.status.kind === "error" && <span className="err" title={p.status.message}>{localizeMessage(p.language, p.status.message)}</span>}
          {p.status.kind === "idle" && <span className="idle">{t("Drop an audio file or paste a YouTube link")}</span>}
        </div>
        {r && !busy && <span className="cd-light-status"><Icon name="check" size={16} />{t("Analysis complete")}</span>}
        {busy ? (
          <button type="button" className="cd-btn danger" onClick={p.onCancel}><Icon name="close" size={20} />{t("Cancel")}</button>
        ) : p.status.kind === "error" ? (
          <button type="button" className="cd-btn" onClick={() => void copy(p.status.kind === "error" ? p.status.message : "", "error")}>\            <Icon name="copy" size={20} />{copied === "error" ? t("Copied") : t("Copy error")}
          </button>
        ) : (
          <>
            <button type="button" className="cd-btn" disabled={!r || p.mp3Busy} onClick={p.onReanalyze}><Icon name="refresh" size={21} />{t("Re-analyze")}</button>
            <button ref={changeSongButton} type="button" className="cd-btn" disabled={p.mp3Busy} data-guide-change-song
              aria-expanded={replacing} onClick={() => { setReplacementUrl(""); setChangeSongOpen(true); }}>
              <Icon name="music" size={20} />{t("Change Song")}
            </button>
          </>
        )}
        <div className="cd-export" ref={exportRef}>
          <button type="button" className="cd-btn" disabled={busy} aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen((o) => !o)}>
            <Icon name="download" size={21} />{t("Export")}<Icon name="chevronDown" size={16} />
          </button>
          {exportOpen && (
            <div className="cd-menu" role="menu" onClick={() => setExportOpen(false)}>
              <button role="menuitem" disabled={!r} onClick={p.onJson}>{t("Chord data (JSON)")}</button>
              <button role="menuitem" disabled={!r} onClick={p.onCsv}>{t("Chord sheet (CSV)")}</button>
              <button role="menuitem" disabled={!r} onClick={p.onChart}>{t("Printable chord chart (HTML)")}</button>
              <button role="menuitem" disabled={!r?.source.fromYoutube || p.mp3Busy} onClick={p.onMp3}>{t("Save analyzed audio as MP3")}</button>
              <button role="menuitem" disabled={!p.canDownloadMp3 || p.mp3Busy} onClick={p.onDownloadMp3}>{t("Download MP3 from pasted URL")}</button>
              <small>{t("MP3 quality: {quality} (Settings)", { quality: t(p.mp3QualityLabel) })}</small>
              <button role="menuitem" disabled={!r || p.mp3Busy} onClick={p.onClear}>{t("Clear song")}</button>
            </div>
          )}
        </div>
      </section>}

      {r && !welcome ? <>
      {standard && <section className="cd-results cd-summary-strip">
        <div className="cd-card cd-key">
          <svg className="cd-summary-key-wave" viewBox="0 0 360 62" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 8C46-3 93 23 141 39C208 61 274 54 360 26V62H0Z" />
            <path d="M0 50C48 36 98 40 149 52C218 68 272 55 360 41V62H0Z" />
            <path d="M0 37C60 15 105 34 155 51C218 73 293 53 360 40V62H0Z" />
          </svg>
          <span className="cd-summary-clef" aria-hidden="true">𝄞</span>
          <h3><Icon name="key" size={23} /><span dir="auto">{t("Key")}</span></h3>
          <div className="cd-summary-key-value">
            <strong dir="auto">{visibleKey}</strong>
            {keyDetail && <span dir="auto">{relative && !k?.uncertain
              ? <>{t(k?.mode === "minor" ? "Relative Major:" : "Relative Minor:")} <bdi><b>{localizedKey(p.language, relativeLabel)}</b></bdi></>
              : keyDetail}</span>}
          </div>
        </div>
        <DetectedChordsCard chords={unique} keyPc={keyPc} language={p.language} onMore={openLibrary} />
        <div className="cd-card cd-conf">
          <div className="cd-summary-match-header">
            <h3><Icon name="focus" size={19} /><span dir="auto">{t("Key Match")}</span><button type="button" className="cd-match-info" title={matchHelp} aria-label={matchHelp}><Icon name="info" size={15} /></button></h3>
            <strong><bdi>{formatScore(keyScore, k?.scoreKind ?? "")}</bdi></strong>
          </div>
          <div className="cd-meter" aria-hidden="true"><span style={{ width: `${keyScore == null ? 0 : Math.max(0, Math.min(1, keyScore)) * 100}%` }} /></div>
          <small dir="auto">{t("Key correlation · not a probability")}</small>
          {transposeControl}
        </div>
      </section>}
      <div className="cd-practice" role="toolbar" aria-label={t("Practice Tools")}>
        <div className="cd-practice-brand">
          <Icon name="music" size={20} />
          <strong>{t("Practice Tools")}</strong>
        </div>

        <i className="cd-practice-sep" aria-hidden="true" />

        <div className="cd-practice-group">
          <Icon name="loop" size={18} className="cd-practice-ico" />
          <span className="cd-practice-label">{t("A-B Loop")}</span>
          <button type="button" role="switch" aria-checked={loopOn} aria-label={t("A-B Loop")} className="cd-switch"
            disabled={!canPlay} onClick={toggleLoop}><span /></button>
          {loopOn && <>
            <button type="button" className="cd-practice-chip" disabled={!canPlay} title={t("Set A")} onClick={() => mark("a")}>{markA == null ? t("Set A") : t("A {time}", { time: formatTimeFine(markA) })}</button>
            <button type="button" className="cd-practice-chip" disabled={!canPlay || markA == null} title={t("Set B")} onClick={() => mark("b")}>{markB == null ? t("Set B") : t("B {time}", { time: formatTimeFine(markB) })}</button>
          </>}
        </div>

        <i className="cd-practice-sep" aria-hidden="true" />

        <div className="cd-practice-group">
          <Icon name="gauge" size={18} className="cd-practice-ico" />
          <span className="cd-practice-label">{t("Speed")}</span>
          <span className="cd-practice-select">
            <select aria-label={t("Speed")} value={speed} disabled={!canPlay} onChange={event => setSpeed(Number(event.currentTarget.value))}>
              {SPEEDS.map(rate => <option key={rate} value={rate}>{rate.toFixed(2)}x</option>)}
            </select>
            <Icon name="chevronDown" size={14} />
          </span>
        </div>

        <i className="cd-practice-sep" aria-hidden="true" />

        <div className="cd-practice-group">
          <Icon name="capo" size={18} className="cd-practice-ico" />
          <span className="cd-practice-label">{t("Capo")}</span>
          <span className="cd-practice-select">
            <select aria-label={t("Capo")} value={capo} disabled={!r} onChange={event => setCapo(Number(event.currentTarget.value))}>
              <option value={0}>{t("Off")}</option>
              {Array.from({ length: 11 }, (_, i) => i + 1).map(fret => <option key={fret} value={fret}>{fret}</option>)}
            </select>
            <Icon name="chevronDown" size={14} />
          </span>
        </div>

        <i className="cd-practice-sep" aria-hidden="true" />

        <div className="cd-practice-group">
          <button type="button" className="cd-practice-icon" aria-pressed={metronome} aria-label={t("Metronome")} title={t("Metronome")}
            disabled={!canPlay} onClick={() => setMetronome(value => !value)}><Icon name="metronome" size={18} /></button>
          <button type="button" className="cd-practice-icon" aria-pressed={countIn} aria-label={t("Count-in")} title={t("Count-in")}
            disabled={!canPlay} onClick={() => setCountIn(value => !value)}><Icon name="countin" size={18} /></button>
          {metronome && <>
            <input className="cd-practice-bpm" aria-label={t("Tempo")} type="number" min={40} max={240} step={1} value={bpm} disabled={!canPlay}
              onChange={event => { setBpmTouched(true); setBpm(Math.max(40, Math.min(240, event.currentTarget.valueAsNumber || bpm))); }} />
            <span className="cd-practice-select compact">
              <select aria-label={t("Click grouping")} value={meter} disabled={!canPlay} onChange={event => setMeter(event.currentTarget.value)}>
                <option value="auto">{t("Auto-detect")}</option>
                <option value="pulse">{t("Neutral pulse")}</option>
                {["2/4", "3/4", "4/4", "6/8", "12/8"].map(signature => <option key={signature}>{signature}</option>)}
              </select>
              <Icon name="chevronDown" size={14} />
            </span>
          </>}
        </div>

        <i className="cd-practice-sep" aria-hidden="true" />

        <div className="cd-practice-group">
          <Icon name="hash" size={18} className="cd-practice-ico" />
          <span className="cd-practice-label">{t("Numbers")}</span>
          <button type="button" role="switch" aria-checked={numbers !== "off"} aria-label={t("Numbers")} className="cd-switch"
            disabled={!r || tonicPc == null} onClick={() => setNumbers(value => value === "off" ? "nashville" : "off")}><span /></button>
          {numbers !== "off" && <>
            <span className="cd-practice-select">
              <select aria-label={t("Number style")} value={numbers} disabled={!r || tonicPc == null} onChange={event => setNumbers(event.currentTarget.value as NumberStyle)}>
                <option value="nashville">1 4 5</option>
                <option value="roman">I IV V</option>
              </select>
              <Icon name="chevronDown" size={14} />
            </span>
            {r?.key.tonic && <span className="cd-practice-hint">{t("1 = {tonic}", { tonic: r.key.tonic })}</span>}
          </>}
        </div>
        <i className="cd-practice-sep" aria-hidden="true" />
        <span className="cd-practice-select" data-guide-chord-mode>
          <select className="themed-select" aria-label={t("Chord display mode")} value={cleanMode ? "clean" : "all"}
            onChange={event => {
              const mode = event.currentTarget.value;
              setCleanMode(mode === "clean");
              localStorage.setItem(CHORD_MODE_KEY, mode);
            }}>
            <option value="all">{t("All Chords")}</option>
            <option value="clean">{t("Clean Progression")}</option>
          </select>
          <Icon name="chevronDown" size={14} />
        </span>
      </div>

      <section className="cd-card cd-timeline">
        {p.compactLayout && <div className="cd-player-summary">
          <dl>
            <div><dt>{t("Key")}</dt><dd>{visibleKey}</dd></div>
            <div><dt>{t("Tempo (BPM)")}</dt><dd>{r.meta.tempoBpm && Number.isFinite(r.meta.tempoBpm) && r.meta.tempoBpm > 0 ? <bdi>≈ {r.meta.tempoBpm}</bdi> : t("Unavailable")}</dd></div>
            <div><dt>{t("Time Signature")}</dt><dd><bdi>{meterLabel}</bdi></dd></div>
            <div><dt>{t("Duration")}</dt><dd><bdi>{dur > 0 ? clock(dur) : t("Unavailable")}</bdi></dd></div>
          </dl>
          {transposeControl}
        </div>}
        <div className="cd-wave-row">
          <button type="button" className="cd-play" aria-label={p.playing ? t("Pause") : t("Play")} disabled={!canPlay} onClick={togglePlayback}>
            <Icon name={p.playing ? "pause" : "play"} size={22} />
          </button>
          <span className="cd-time cd-clock">{r ? `${formatTime(p.time)} / ${formatTime(dur)}` : `${NA} / ${NA}`}</span>
          <div className="cd-wave" role="slider" tabIndex={canPlay ? 0 : -1} aria-label={t("Seek")} aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(p.time)} aria-valuetext={r ? `${formatTime(p.time)}${active ? ` · ${chordText(active)}` : ""}` : NA} aria-disabled={!canPlay}
            onPointerDown={(e) => { if (!canPlay) return; e.currentTarget.setPointerCapture(e.pointerId); seekFromPointer(e); }}
            onPointerMove={(e) => { if (canPlay && e.buttons === 1) seekFromPointer(e); }}
            onKeyDown={(e) => {
              if (!canPlay || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing
                || actionForKey(p.shortcuts, e.key)) return;
              if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) e.preventDefault();
              if (e.key === "ArrowRight") seekPlayer(Math.min(dur, p.readTime() + 5));
              else if (e.key === "ArrowLeft") seekPlayer(Math.max(0, p.readTime() - 5));
              else if (e.key === "Home") seekPlayer(0);
              else if (e.key === "End") seekPlayer(dur);
            }}>
            {r ? (
              <svg viewBox={`0 0 ${wavePath.n} 100`} preserveAspectRatio="none" aria-hidden="true">
                <defs><clipPath id="cdPlayed"><rect x="0" y="0" width={pct * wavePath.n} height="100" /></clipPath></defs>
                <path d={wavePath.d} stroke="var(--wave-unplayed, #16d9f6)" strokeWidth="0.62" />
                <path d={wavePath.d} stroke="var(--wave-played, #c8fbff)" strokeWidth="0.62" clipPath="url(#cdPlayed)" />
              </svg>
            ) : <span className="cd-wave-empty" />}
            {r && dur > 0 && loopOn && loopReady && markA != null && markB != null && <i className="cd-loop-span" style={{ left: `${markA / dur * 100}%`, width: `${(markB - markA) / dur * 100}%` }} />}
            {r && dur > 0 && loopOn && markA != null && <i className="cd-loop-mark" style={{ left: `${markA / dur * 100}%` }} />}
            {r && dur > 0 && loopOn && markB != null && <i className="cd-loop-mark b" style={{ left: `${markB / dur * 100}%` }} />}
            {r && <i className="cd-playhead cd-wave-playhead" style={{ left: `${pct * 100}%` }} />}
          </div>
          <Icon name="volume" size={25} />
          <input className="cd-vol" type="range" aria-label={t("Volume")} min={0} max={1} step={0.01} value={vol}
            style={{ ["--v" as string]: `${vol * 100}%` }} onChange={(e) => p.onVolume(e.currentTarget.valueAsNumber)} />
        </div>
        <ChordTrack language={p.language} key={r?.source.path ?? "empty"} chords={chords} dur={dur} time={p.time} canPlay={canPlay} playing={p.playing} keyPc={keyPc} onSeek={seekPlayer} readTime={p.readTime} watchClock={p.watchClock} compactPlayer={compact} />
      </section>

      <section className="cd-lower" dir={compact ? languageDirection(p.language) : undefined}>
          {compact ? <>
            <div className="cd-card cd-panel cd-sheet-panel">
              <div className="cd-compact-pane-heading">
                <div className="cd-compact-tabs" role="group" aria-label={t("Lyrics Sheet")}>
                  <button type="button" aria-pressed="true" onClick={() => sheetRef.current?.focus()}><Icon name="sheet" size={19} />{t("Lyrics Sheet")}</button>
                  <button type="button" onClick={() => openSheet("diagrams")}><Icon name="grid" size={17} />{t("Chord Diagrams")}</button>
                </div>
                {sheetPicker}
                <button type="button" className="cd-icon-btn cd-compact-expand-lyrics" title={t("Expand")} aria-label={t("Expand")}
                  onClick={() => openSheet()}><Icon name="expand" size={17} /></button>
              </div>
              {renderCompactLyricsTools()}
              {lyricsQuery.trim() && !lyricsMatchCount && <p className="cd-compact-no-matches" role="status">{t("No matching lyrics")}</p>}
              {renderSheet()}{sheetFooter()}
            </div>
            <div className="cd-card cd-panel cd-compact-diagram-panel">
              <div className="cd-compact-pane-heading">
                <h3><Icon name="grid" size={21} /><span>{t("Chord Diagrams")} — {t("All Chords in Song")}</span></h3>
                {diagramSheetAction()}
                <button type="button" className="cd-icon-btn" popoverTarget={compactDiagramViewsId}
                  title={t("Chord diagram view")} aria-label={t("Chord diagram view")}><Icon name="more" size={18} /></button>
                <div id={compactDiagramViewsId} popover="auto" className="cd-compact-popover"
                  onClick={event => { if ((event.target as Element).closest("button")) event.currentTarget.hidePopover(); }}>
                  {viewPicker()}
                </div>
              </div>
              {renderDiagramSheet()}
            </div>
          </> : <div className="cd-card cd-panel cd-sheet-panel">
            <h3>
              <Icon name="sheet" size={24} /><span className="cd-sheet-heading">{t("Lyrics Sheet")}</span>
              {sheetPicker}{sheetActions()}
            </h3>
            {renderSheet()}{sheetFooter()}
          </div>}

          {!p.compactLayout && <>
          <div className="cd-card cd-panel cd-diagram-panel">
            <h3><Icon name="grid" size={24} /><span className="cd-sheet-heading">{t("Chord Diagrams")}</span> {instrumentPicker}</h3>
            <div className="cd-diagrams">{renderDiagrams()}</div>
            {viewPicker(true)}
          </div>

          <div className="cd-right-col">
            <div className="cd-card cd-panel cd-song-summary">
              <h3><Icon name="bars" size={18} /><span dir="auto">{t("Song Information")}</span></h3>
              <div className="cd-summary-body" dir={languageDirection(p.language)}>
                <div className="cd-summary-key">
                  <strong>{keyUnknown ? (k ? t("Uncertain") : NA) : localizedKey(p.language, keyLabel)}</strong>
                  {!keyUnknown && <div className="cd-summary-mode">
                    <span>{t("Mode:")} <b>{k?.mode === "major" ? t("Major") : t("Minor")}</b></span>
                    {relative && <span>{t(k?.mode === "minor" ? "Relative Major:" : "Relative Minor:")} <b>{localizedKey(p.language, relativeLabel)}</b></span>}
                  </div>}
                </div>
                <dl className="cd-summary-stats">
                  <div title={t("Estimated from the beat grid")}><Icon name="bars" size={13} /><dt>{t("Tempo (BPM)")}</dt><dd>{r?.meta.tempoBpm != null ? <bdi>≈ {r.meta.tempoBpm}</bdi> : r ? t("Unavailable") : NA}</dd></div>
                  <div title={t("Estimated time signature")}><Icon name="music" size={13} /><dt>{t("Time Signature")}</dt><dd><bdi>{r ? meterLabel : NA}</bdi></dd></div>
                  <div><Icon name="clock" size={13} /><dt>{t("Duration")}</dt><dd><bdi>{r ? clock(dur) : NA}</bdi></dd></div>
                </dl>
              </div>
            </div>
            <ChordWave
              chords={chords}
              time={p.time}
              dur={dur}
              canPlay={canPlay}
              playing={p.playing}
              language={p.language}
              onSeek={seekPlayer}
              readTime={p.readTime}
              watchClock={p.watchClock}
            />
          </div>
          </>}
        </section>
      <dialog className={"cd-sheet-dialog" + (editingSheet ? " cd-sheet-editing" : "")} ref={sheetDialog} aria-labelledby={sheetTitleId}
        dir={compact ? languageDirection(p.language) : undefined}
        onClose={event => {
          if (event.target !== event.currentTarget || event.currentTarget.open) return;
          setSheetExpanded(false);
          dismissSheetEdits();
          setEditing(null);
        }}>
        {sheetExpanded && <>
          <header className="cd-sheet-dialog-header">
            <div className="cd-sheet-dialog-title"><h2 id={sheetTitleId}>{t(showSheetDiagrams ? "Chord Diagrams" : "Lyrics Sheet")}</h2><bdi>{r?.source.name}</bdi></div>
            {compactSheetPicker()}
            {showSheetDiagrams ? diagramSheetAction(true) : editingSheet ? <div className="cd-sheet-actions cd-edit-save">
              <button type="button" className="btn btn-primary" disabled={verifyingLyrics} onClick={() => void saveEditedSheet()}>
                {t("Save lyrics sheet")}
              </button>
              <button type="button" className="btn btn-ghost" onClick={dismissSheetEdits}>{t("Cancel")}</button>
            </div> : <>{sheetPicker}{sheetActions(true)}</>}
          </header>
          {showSheetDiagrams ? renderDiagramSheet(true) : editingSheet ? <div className="cd-sheet cd-sheet-editor" aria-label={t("Lyrics Sheet")}>
            <div className="cd-sheet-edit-bar">
              <div className="cd-choice cd-sheet-view" role="group" aria-label={t("Lyrics Sheet")}>
                {(["chords", "both", "lyrics"] as const).map(mode => <button type="button" key={mode} aria-pressed={sheetView === mode}
                  onClick={() => setSheetView(mode)}>{t(mode === "chords" ? "Chords only" : mode === "lyrics" ? "Lyrics only" : "Both")}</button>)}
              </div>
              <div className="cd-sheet-tags" role="toolbar" aria-label={t("Add Section")}>
                <div className="cd-sheet-add">
                  <button type="button" aria-expanded={sectionMenu} onClick={() => setSectionMenu(value => !value)}>+ {t("Add Section")}</button>
                  {sectionMenu && <div className="cd-sheet-add-menu" role="menu">
                    {SECTION_KINDS.map(kind => <button type="button" role="menuitem" key={kind.code} onClick={() => placeSection(kind.code)}>{t(kind.name)}</button>)}
                  </div>}
                </div>
                {SECTION_KINDS.map(kind => <button type="button" key={kind.code} onClick={() => placeSection(kind.code)}>
                  <bdi>{`[${kind.code}]`}</bdi>{t(kind.name)}
                </button>)}
                <button type="button" aria-label={t("Undo")} disabled={!canUndo} onClick={undoSheet}>↺</button>
                <button type="button" aria-label={t("Redo")} disabled={!canRedo} onClick={redoSheet}>↻</button>
              </div>
            </div>
            {editNotice && <p className="cd-edit-lyric-notice" role="status">{t(editNotice)}</p>}
            <fieldset className="cd-sheet-edit-body" disabled={verifyingLyrics}>
              <div className="cd-sheet-edit-main">
                {editorBlocks.map((block, index) => {
                  const groupIndex = sectionGroups.findIndex(group => group[0] === index);
                  return <div className="cd-sheet-edit-line" key={index} id={`sheet-line-${index}`}>
                    {block.tag && <div className="cd-sheet-section-row">
                      <bdi className="cd-sheet-section-tag">{block.tag}</bdi>
                      <span>{sectionLabel(block.tag)}</span>
                      <button type="button" aria-label={t("Edit")} onClick={() => document.getElementById(`sheet-lyric-${index}`)?.focus()}><Icon name="feather" size={15} /></button>
                      <button type="button" aria-label={t("Move up")} disabled={groupIndex <= 0} onClick={() => moveSection(groupIndex, -1)}>↑</button>
                      <button type="button" aria-label={t("Move down")} disabled={groupIndex < 0 || groupIndex >= sectionGroups.length - 1} onClick={() => moveSection(groupIndex, 1)}>↓</button>
                    </div>}
                    {sheetView !== "lyrics" && <input className="cd-sheet-edit-chords" aria-label={t("Chord")} placeholder={t("Chord")} value={block.chords}
                      onChange={event => writeBlocks(editorBlocks.map((item, itemIndex) => itemIndex === index ? { ...item, chords: event.target.value } : item))} />}
                    {sheetView !== "chords" && <input id={`sheet-lyric-${index}`} className="cd-sheet-edit-text" aria-label={t("Lyric")} placeholder={t("Text")} value={block.text}
                      onChange={event => writeBlocks(editorBlocks.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} />}
                    <button type="button" className="cd-sheet-edit-remove" aria-label={t("Remove line")} onClick={() => {
                      const blocks = editorBlocks.filter((_, itemIndex) => itemIndex !== index);
                      writeBlocks(blocks.length ? blocks : [{ tag: "", chords: "", text: "" }]);
                    }}>×</button>
                  </div>;
                })}
                <button type="button" className="cd-sheet-add-line" onClick={() => writeBlocks([...editorBlocks, { tag: "", chords: "", text: "" }])}>{t("Add line")}</button>
              </div>
              <aside className="cd-sheet-structure" aria-label={t("Song Structure")}>
                <h4>{t("Song Structure")}</h4>
                <ol>
                  {sectionGroups.flatMap((group, groupIndex) => {
                    const block = editorBlocks[group[0]];
                    if (!block?.tag) return [];
                    return [<li key={group[0]}>
                      <button type="button" onClick={() => document.getElementById(`sheet-line-${group[0]}`)?.scrollIntoView({ block: "nearest" })}>
                        <bdi>{groupIndex + 1}</bdi><bdi className="cd-sheet-section-tag">{block.tag}</bdi><span>{sectionLabel(block.tag)}</span>
                      </button>
                    </li>];
                  })}
                </ol>
              </aside>
            </fieldset>
          </div> : <>
          {!LYRICS_ONLY_SHEET && chordEditor}
          {renderSheet(true)}
          </>}
          <div className="cd-sheet-dialog-controls">
            <button type="button" className="cd-play" aria-label={p.playing ? t("Pause") : t("Play")} disabled={!canPlay} onClick={togglePlayback}>
              <Icon name={p.playing ? "pause" : "play"} size={18} />
            </button>
            <span className="cd-clock" dir="ltr">{formatTime(p.time)} / {formatTime(dur)}</span>
            {!showSheetDiagrams && sheetFooter()}
          </div>
        </>}
      </dialog>

      </> : welcome && (
        <section className={"cd-welcome" + (dragOver ? " dragging" : "")} aria-label={t("Hear it. Learn it. Play it.")}>
          <div className="cd-welcome-card" dir={languageDirection(p.language)}>
            <h2 dir="auto">
              {p.language === "en" ? t("Hear it. Learn it. Play it.").split(/(?<=\.) /).map((part, index) =>
                index === 2 ? <em key={index}>{part}</em> : `${part} `) : t("Hear it. Learn it. Play it.")}
              <span className="cd-welcome-note-anchor" aria-hidden="true">
                <span className="cd-welcome-notes">
                  <svg className="cd-welcome-note cd-welcome-note-1" viewBox="-1 -2 20 29">
                    <path d="M8 2v20M8 2l10-3v6L8 8" />
                    <ellipse cx="4.5" cy="22" rx="4.5" ry="3.2" transform="rotate(-18 4.5 22)" />
                  </svg>
                  <svg className="cd-welcome-note cd-welcome-note-2" viewBox="-1.5 0 24 30">
                    <path d="M7 4v21M21 1v21M7 5l14-4M7 10l14-4" />
                    <ellipse cx="3.8" cy="25" rx="4.2" ry="3.2" transform="rotate(-18 3.8 25)" />
                    <ellipse cx="17.8" cy="22" rx="4.2" ry="3.2" transform="rotate(-18 17.8 22)" />
                  </svg>
                  <svg className="cd-welcome-note cd-welcome-note-3" viewBox="-1.5 1 16.5 24">
                    <path d="M7 2v18M7 2c4 1.5 6.5 4 6.5 7.5" />
                    <ellipse cx="3.8" cy="20" rx="3.8" ry="2.8" transform="rotate(-18 3.8 20)" />
                  </svg>
                </span>
              </span>
            </h2>
            <p className="cd-welcome-desc">{t("Discover the key, follow the chords, and learn your favorite songs with Sion Keys.")}</p>
            <div className="cd-welcome-steps" aria-hidden="true">
              <span className="cd-welcome-step"><Icon name="music" size={14} /><bdi>{t("Discover")}</bdi></span>
              <span className="cd-welcome-step-arrow">→</span>
              <span className="cd-welcome-step"><Icon name="key" size={14} /><bdi>{t("Understand")}</bdi></span>
              <span className="cd-welcome-step-arrow">→</span>
              <span className="cd-welcome-step"><Icon name="play" size={12} /><bdi>{t("Play the music")}</bdi></span>
            </div>
          </div>
          <DailyVerse language={p.language} desktop={p.tauri} />
        </section>
      )}
      <dialog className="cd-sheet-dialog cd-lib-dialog" ref={voicingDialog} aria-labelledby={voicingTitleId}
        onClose={() => { setExploredChord(null); setLibChoice(null); }}>
        {exploredChord !== null && <>
          <header className="cd-sheet-dialog-header">
            <div className="cd-sheet-dialog-title">
              <h2 id={voicingTitleId}>{t("Chord Library")}</h2>
              <bdi>{t("Chords: {n}", { n: unique.length })}</bdi>
            </div>
            <button type="button" className="cd-icon-btn" aria-label={t("Close")} onClick={() => voicingDialog.current?.close()}><Icon name="close" size={18} /></button>
          </header>
          <div className="cd-lib-toolbar">
            {instrumentPicker}
            {viewPicker()}
          </div>
          {r ? <ChordLibrary items={unique} selected={libChoice} onSelect={setLibChoice}
            instrument={instrument} view={diagramView} capo={capo} language={p.language} />
            : <p className="cd-lib-empty">{t("No song loaded")}</p>}
        </>}
      </dialog>
    </div>
  );
}
