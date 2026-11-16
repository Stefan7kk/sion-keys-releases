import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { formatTime } from "../lib/format";
import { localizedKind, localizedScoreKind, translate } from "../lib/i18n";
import type { Language } from "../lib/languages";
import type { ChordSegment } from "../lib/types";

export type WaveInputChord = ChordSegment & { printed?: string };

export interface WaveChordItem {
  index: number;
  start: number;
  end: number;
  label: string;
  rawLabel: string;
  kind: "chord" | "uncertain";
  score: number | null;
  scoreKind: ChordSegment["scoreKind"];
}

export interface WaveSlotRender {
  item: WaveChordItem;
  index: number;
  delta: number;
  x: number;
  y: number;
  waveY: number;
  scale: number;
  opacity: number;
  prominence: number;
  active: boolean;
}

export interface ChordWaveFrame {
  t: number;
  u: number;
  phase: number;
  activeIndex: number;
  pulse: number;
  slots: WaveSlotRender[];
}

const VIEW_W = 360;
const VIEW_H = 108;
const CENTER_X = 180;
const BASE_STEP_X = 63;
const SLOT_OFFSETS = [-3, -2, -1, 0, 1, 2, 3] as const;

const PARTICLES = [
  { x: 28, y: 36, r: 1.1, ampX: 4.5, ampY: 3.2, speed: 0.9, phase: 0.2, baseAlpha: 0.45 },
  { x: 52, y: 78, r: 1.3, ampX: 3.8, ampY: 2.6, speed: 1.1, phase: 1.4, baseAlpha: 0.52 },
  { x: 76, y: 28, r: 0.9, ampX: 5.0, ampY: 3.0, speed: 0.8, phase: 2.7, baseAlpha: 0.38 },
  { x: 98, y: 66, r: 1.5, ampX: 3.2, ampY: 2.8, speed: 1.2, phase: 0.8, baseAlpha: 0.62 },
  { x: 128, y: 48, r: 1.0, ampX: 4.2, ampY: 3.4, speed: 1.0, phase: 3.9, baseAlpha: 0.44 },
  { x: 146, y: 84, r: 1.2, ampX: 3.6, ampY: 2.4, speed: 0.85, phase: 5.1, baseAlpha: 0.48 },
  { x: 166, y: 34, r: 1.1, ampX: 4.0, ampY: 3.1, speed: 1.15, phase: 2.1, baseAlpha: 0.50 },
  { x: 196, y: 88, r: 1.4, ampX: 3.5, ampY: 2.5, speed: 0.95, phase: 4.4, baseAlpha: 0.58 },
  { x: 214, y: 50, r: 1.2, ampX: 4.4, ampY: 3.0, speed: 1.05, phase: 1.1, baseAlpha: 0.54 },
  { x: 238, y: 74, r: 1.0, ampX: 3.8, ampY: 2.8, speed: 0.9, phase: 3.3, baseAlpha: 0.42 },
  { x: 266, y: 30, r: 1.3, ampX: 4.1, ampY: 3.2, speed: 1.1, phase: 5.6, baseAlpha: 0.50 },
  { x: 286, y: 68, r: 1.5, ampX: 3.4, ampY: 2.6, speed: 0.8, phase: 0.5, baseAlpha: 0.60 },
  { x: 314, y: 40, r: 1.0, ampX: 4.6, ampY: 3.0, speed: 1.0, phase: 2.9, baseAlpha: 0.40 },
  { x: 336, y: 76, r: 1.2, ampX: 3.6, ampY: 2.5, speed: 0.95, phase: 4.8, baseAlpha: 0.46 },
] as const;

const WAVE_NODES = [
  { x: 96, r: 13, baseOpacity: 0.55 },
  { x: 180, r: 18, baseOpacity: 0.82 },
  { x: 264, r: 13, baseOpacity: 0.55 },
] as const;

function formatWaveChordLabel(seg: WaveInputChord): string {
  const base = (seg.printed ?? seg.display)
    .replace(":maj", "maj")
    .replace(":min", "m")
    .replace(":", "");
  if (seg.kind === "uncertain") return base === "N.C." ? "?" : `${base}?`;
  return base;
}

export function extractWaveChords(chords: readonly WaveInputChord[]): WaveChordItem[] {
  const items: WaveChordItem[] = [];
  for (const seg of chords) {
    if (!seg || seg.display === "N.C." || (seg.kind !== "chord" && seg.kind !== "uncertain")) continue;
    const label = formatWaveChordLabel(seg);
    if (!label || label === "N.C." || label === "?") continue;
    const prev = items.at(-1);
    if (prev && prev.label === label && prev.kind === seg.kind && Math.abs(seg.start - prev.end) <= 1e-3) {
      prev.end = seg.end;
      continue;
    }
    items.push({
      index: items.length,
      start: seg.start,
      end: seg.end,
      label,
      rawLabel: seg.printed ?? seg.display,
      kind: seg.kind,
      score: seg.score,
      scoreKind: seg.scoreKind,
    });
  }
  return items;
}

export function mainWaveY(x: number, phase: number): number {
  const dx = x - CENTER_X;
  const carrier = Math.cos((Math.PI * dx) / 84);
  const ripple1 = Math.sin((Math.PI * dx) / 68 + phase * 1.85);
  const ripple2 = Math.cos((Math.PI * dx) / 116 - phase * 1.15);
  return 67.5 + 11.2 * carrier + 1.65 * ripple1 + 0.95 * ripple2;
}

function strandMidY(x: number, phase: number): number {
  const dx = x - CENTER_X;
  return (
    69.0 -
    7.8 * Math.cos((Math.PI * dx) / 96 - phase * 1.35) +
    3.2 * Math.sin((Math.PI * dx) / 76 + phase * 1.6)
  );
}

function strandUpperY(x: number, phase: number): number {
  const dx = x - (CENTER_X - 16);
  return (
    64.0 +
    13.2 * Math.cos((Math.PI * dx) / 88 + phase * 0.95) -
    1.8 * Math.sin((Math.PI * dx) / 58 - phase * 1.45)
  );
}

function strandLowerY(x: number, phase: number): number {
  const dx = x - (CENTER_X + 18);
  return (
    72.5 +
    9.4 * Math.cos((Math.PI * dx) / 82 - phase * 1.05) +
    2.1 * Math.cos((Math.PI * dx) / 62 + phase * 1.5)
  );
}

function buildSmoothCurve(fn: (x: number) => number, startX = -24, endX = 384, step = 12): { d: string; points: [number, number][] } {
  const points: [number, number][] = [];
  for (let x = startX; x <= endX; x += step) {
    points.push([x, fn(x)]);
  }
  if (points.length < 2) return { d: "", points };
  let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x.toFixed(1)} ${cp1y.toFixed(1)},${cp2x.toFixed(1)} ${cp2y.toFixed(1)},${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return { d, points };
}

function buildWavePaths(phase: number) {
  const main = buildSmoothCurve((x) => mainWaveY(x, phase));
  const mid = buildSmoothCurve((x) => strandMidY(x, phase));
  const upper = buildSmoothCurve((x) => strandUpperY(x, phase));
  const lower = buildSmoothCurve((x) => strandLowerY(x, phase));

  let ribbonFill = main.d;
  for (let i = mid.points.length - 1; i >= 0; i--) {
    const [x, y] = mid.points[i];
    ribbonFill += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  ribbonFill += " Z";

  const first = main.points[0];
  const last = main.points[main.points.length - 1];
  const underGlow = `${main.d} L${last[0].toFixed(1)} ${VIEW_H + 14} L${first[0].toFixed(1)} ${VIEW_H + 14} Z`;

  return {
    main: main.d,
    mid: mid.d,
    upper: upper.d,
    lower: lower.d,
    ribbonFill,
    underGlow,
  };
}

function findChordIndex(items: readonly WaveChordItem[], t: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (items[mid].end <= t) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function computeChordWaveFrame(
  items: readonly WaveChordItem[],
  time: number,
  duration: number,
  reducedMotion = false,
): ChordWaveFrame {
  const maxDur = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const rawT = Number.isFinite(time) ? time : 0;
  const t = Math.max(0, Math.min(maxDur, rawT));
  const phase = reducedMotion ? 0 : t;

  if (!items.length) {
    return { t, u: 0, phase, activeIndex: -1, pulse: 0, slots: [] };
  }

  const n = items.length;
  let u = 0;
  let activeIndex = -1;
  let pulse = 0;

  if (t < items[0].start) {
    if (t <= 0) {
      u = 0;
    } else {
      const preSpan = Math.max(0.01, items[0].start);
      const frac = Math.min(1, Math.max(0, t / preSpan));
      u = reducedMotion ? 0 : -0.5 * (1 - frac);
    }
    activeIndex = -1;
  } else if (t >= items[n - 1].end) {
    u = n - 1;
    activeIndex = t <= items[n - 1].end + 1e-3 ? n - 1 : -1;
  } else {
    const idx = Math.min(n - 1, findChordIndex(items, t));
    const current = items[idx];
    if (current && current.start <= t && t < current.end) {
      activeIndex = idx;
      const span = Math.max(0.01, current.end - current.start);
      const f = Math.min(1, Math.max(0, (t - current.start) / span));
      const nextItem = items[idx + 1];
      const hasGapAfter = nextItem != null && nextItem.start > current.end + 0.02;

      if (reducedMotion) {
        u = idx;
      } else {
        const s = 2 * f - 1; // [-1, +1]
        const curve = 0.45 * s + 0.55 * s * s * s; // [-1, +1], C1 smooth at boundaries
        const leftReach = idx === 0 ? 0 : 0.5;
        const rightReach = idx === n - 1 ? 0 : hasGapAfter ? 0.35 : 0.5;
        u = idx + (curve < 0 ? leftReach * curve : rightReach * curve);
      }
      pulse = reducedMotion ? 0.85 : 0.62 + 0.38 * Math.exp(-Math.max(0, t - current.start) * 3.6);
    } else if (idx > 0) {
      const prev = items[idx - 1];
      const next = items[idx];
      const gapSpan = Math.max(0.01, next.start - prev.end);
      const gapFrac = Math.min(1, Math.max(0, (t - prev.end) / gapSpan));
      u = reducedMotion ? idx - 0.5 : idx - 1 + 0.35 + 0.15 * gapFrac;
      activeIndex = -1;
    }
  }

  const startBlend = n >= 4 ? Math.max(0, Math.min(1, 1 - u)) : 0;
  const endBlend = n >= 4 ? Math.max(0, Math.min(1, u - Math.max(0, n - 2))) : 0;
  const stepRight = BASE_STEP_X - 13 * startBlend;
  const stepLeft = BASE_STEP_X - 13 * endBlend;
  const maxRightDelta = 2.45 + 0.75 * startBlend;
  const maxLeftDelta = 2.45 + 0.75 * endBlend;

  const anchor = Math.round(u);
  const slots: WaveSlotRender[] = [];

  for (const offset of SLOT_OFFSETS) {
    const k = anchor + offset;
    if (k < 0 || k >= n) continue;
    const item = items[k];
    const delta = k - u;
    if (delta > maxRightDelta || delta < -maxLeftDelta) continue;

    const x = CENTER_X + (delta >= 0 ? delta * stepRight : delta * stepLeft);
    if (x < 16 || x > VIEW_W - 16) continue;

    const absDelta = Math.abs(delta);
    const maxD = delta >= 0 ? maxRightDelta : maxLeftDelta;
    const edgeFade = absDelta <= maxD - 0.55 ? 1 : Math.max(0, (maxD - absDelta) / 0.55);
    const prominence = Math.exp(-1.15 * delta * delta);
    const active = k === activeIndex;

    const waveY = mainWaveY(x, phase);
    const clearance = 19.5 + 3.5 * prominence;
    const y = waveY - clearance;

    const lenScale = item.label.length > 6 ? 0.8 : item.label.length > 4 ? 0.88 : item.label.length > 3 ? 0.94 : 1;
    const baseScale = active ? 1.12 : 0.88 + 0.14 * prominence;
    const scale = baseScale * lenScale;
    const baseOpacity = active ? 1 : 0.56 + 0.36 * prominence;
    const opacity = Math.min(1, Math.max(0, baseOpacity * edgeFade));

    slots.push({
      item,
      index: k,
      delta,
      x,
      y,
      waveY,
      scale,
      opacity,
      prominence,
      active,
    });
  }

  return { t, u, phase, activeIndex, pulse, slots };
}

function itemTooltip(item: WaveChordItem, language: Language): string {
  const what = localizedKind(language, item.kind);
  const score = item.score == null ? "—" : item.score.toFixed(2);
  return `${item.label} · ${formatTime(item.start)}–${formatTime(item.end)} · ${what} · ${localizedScoreKind(language, item.scoreKind)} ${score}`;
}

export interface ChordWaveProps {
  chords: WaveInputChord[];
  time: number;
  dur: number;
  canPlay: boolean;
  playing: boolean;
  language: Language;
  onSeek: (time: number) => void;
  readTime: () => number;
  watchClock: (fn: (t: number) => void) => () => void;
}

export function ChordWave({
  chords,
  time: committedTime,
  dur,
  canPlay,
  playing,
  language,
  onSeek,
  readTime,
  watchClock,
}: ChordWaveProps) {
  const uid = useId().replace(/:/g, "");
  const waveChords = useMemo(() => extractWaveChords(chords), [chords]);

  const rootRef = useRef<HTMLDivElement>(null);
  const ribbonFillRef = useRef<SVGPathElement>(null);
  const underGlowRef = useRef<SVGPathElement>(null);
  const strandUpperRef = useRef<SVGPathElement>(null);
  const strandMidRef = useRef<SVGPathElement>(null);
  const strandLowerRef = useRef<SVGPathElement>(null);
  const mainGlowRef = useRef<SVGPathElement>(null);
  const mainBodyRef = useRef<SVGPathElement>(null);
  const mainCoreRef = useRef<SVGPathElement>(null);
  const centerAuraRef = useRef<SVGEllipseElement>(null);
  const nodeRefs = useRef<(SVGGElement | null)[]>([]);
  const particleRefs = useRef<(SVGCircleElement | null)[]>([]);
  const slotRefs = useRef<(SVGGElement | null)[]>([]);
  const slotTextRefs = useRef<(SVGTextElement | null)[]>([]);
  const slotDotRefs = useRef<(SVGCircleElement | null)[]>([]);
  const slotHaloRefs = useRef<(SVGCircleElement | null)[]>([]);
  const slotStartsRef = useRef<(number | null)[]>(SLOT_OFFSETS.map(() => null));

  const paintRef = useRef<(t: number) => void>(() => {});
  paintRef.current = (t: number) => {
    const reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const frame = computeChordWaveFrame(waveChords, t, dur, reducedMotion);
    const paths = buildWavePaths(frame.phase);

    if (rootRef.current) {
      rootRef.current.dataset.time = frame.t.toFixed(3);
      rootRef.current.dataset.activeChord = frame.activeIndex >= 0 ? waveChords[frame.activeIndex]?.label ?? "" : "";
      rootRef.current.dataset.visibleCount = String(frame.slots.length);
    }

    ribbonFillRef.current?.setAttribute("d", paths.ribbonFill);
    underGlowRef.current?.setAttribute("d", paths.underGlow);
    strandUpperRef.current?.setAttribute("d", paths.upper);
    strandMidRef.current?.setAttribute("d", paths.mid);
    strandLowerRef.current?.setAttribute("d", paths.lower);
    mainGlowRef.current?.setAttribute("d", paths.main);
    mainBodyRef.current?.setAttribute("d", paths.main);
    mainCoreRef.current?.setAttribute("d", paths.main);

    if (centerAuraRef.current) {
      const centerY = mainWaveY(CENTER_X, frame.phase);
      centerAuraRef.current.setAttribute("cy", (centerY - 6).toFixed(1));
      centerAuraRef.current.setAttribute(
        "opacity",
        (frame.activeIndex >= 0 ? 0.55 + 0.35 * frame.pulse : 0.35).toFixed(2),
      );
    }

    for (let i = 0; i < WAVE_NODES.length; i++) {
      const nodeEl = nodeRefs.current[i];
      if (!nodeEl) continue;
      const spec = WAVE_NODES[i];
      const ny = mainWaveY(spec.x, frame.phase);
      const isCenter = i === 1;
      const op = isCenter && frame.activeIndex >= 0 ? Math.min(1, spec.baseOpacity * (0.85 + 0.25 * frame.pulse)) : spec.baseOpacity;
      nodeEl.setAttribute("transform", `translate(${spec.x.toFixed(1)} ${ny.toFixed(1)})`);
      nodeEl.setAttribute("opacity", op.toFixed(2));
    }

    for (let i = 0; i < PARTICLES.length; i++) {
      const pEl = particleRefs.current[i];
      if (!pEl) continue;
      const p = PARTICLES[i];
      const px = reducedMotion ? p.x : p.x + Math.sin(frame.phase * p.speed + p.phase) * p.ampX;
      const py = reducedMotion ? p.y : p.y + Math.cos(frame.phase * (p.speed * 0.85) + p.phase) * p.ampY;
      const pop = reducedMotion
        ? p.baseAlpha
        : p.baseAlpha * (0.68 + 0.32 * Math.sin(frame.phase * (p.speed * 1.4) + p.phase));
      pEl.setAttribute("cx", px.toFixed(1));
      pEl.setAttribute("cy", py.toFixed(1));
      pEl.setAttribute("opacity", pop.toFixed(2));
    }

    for (let s = 0; s < SLOT_OFFSETS.length; s++) {
      const gEl = slotRefs.current[s];
      const textEl = slotTextRefs.current[s];
      const dotEl = slotDotRefs.current[s];
      const haloEl = slotHaloRefs.current[s];
      const slot = frame.slots[s];
      if (!gEl || !textEl || !dotEl || !haloEl) continue;

      if (!slot || slot.opacity <= 0.02) {
        gEl.style.display = "none";
        gEl.setAttribute("data-active", "false");
        gEl.removeAttribute("data-chord");
        slotStartsRef.current[s] = null;
        continue;
      }

      gEl.style.display = "";
      gEl.setAttribute(
        "transform",
        `translate(${slot.x.toFixed(2)} ${slot.y.toFixed(2)}) scale(${slot.scale.toFixed(3)})`,
      );
      gEl.setAttribute("opacity", slot.opacity.toFixed(3));
      gEl.setAttribute("data-active", slot.active ? "true" : "false");
      gEl.setAttribute("data-chord", slot.item.label);
      gEl.setAttribute("data-start", String(slot.item.start));
      gEl.setAttribute("data-end", String(slot.item.end));
      gEl.setAttribute("data-x", slot.x.toFixed(1));
      gEl.setAttribute("data-y", slot.y.toFixed(1));
      slotStartsRef.current[s] = slot.item.start;

      if (textEl.textContent !== slot.item.label) {
        textEl.textContent = slot.item.label;
      }
      textEl.setAttribute(
        "class",
        slot.active
          ? "cd-wave-chord-text active"
          : Math.abs(slot.delta) <= 1.25
            ? "cd-wave-chord-text near"
            : "cd-wave-chord-text far",
      );

      const dotLocalY = (slot.waveY - slot.y) / slot.scale;
      dotEl.setAttribute("cy", dotLocalY.toFixed(1));
      dotEl.setAttribute("r", slot.active ? "2.5" : "1.5");
      dotEl.setAttribute("opacity", slot.active ? "0.95" : (0.35 + 0.35 * slot.prominence).toFixed(2));

      haloEl.setAttribute("cy", dotLocalY.toFixed(1));
      haloEl.setAttribute("r", slot.active ? "10" : "5");
      haloEl.setAttribute("opacity", slot.active ? "0.75" : (0.18 * slot.prominence).toFixed(2));

      const titleText = itemTooltip(slot.item, language);
      const titleEl = gEl.querySelector("title");
      if (titleEl && titleEl.textContent !== titleText) titleEl.textContent = titleText;
    }
  };

  useLayoutEffect(() => {
    const now = canPlay && playing ? readTime() : committedTime;
    paintRef.current(now);
  });

  useEffect(() => {
    if (!canPlay || !playing) return;
    paintRef.current(readTime());
    return watchClock((t) => paintRef.current(t));
  }, [canPlay, playing, readTime, watchClock, waveChords, dur]);

  return (
    <div
      ref={rootRef}
      className={"cd-card cd-panel cd-chord-wave" + (canPlay ? " is-playable" : "") + (playing ? " is-playing" : "")}
      role="region"
      aria-label={translate(language, "Detected Chords")}
    >
      <svg
        className="cd-chord-wave-svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id={`cwAmbient-${uid}`} cx="50%" cy="62%" r="54%">
            <stop offset="0%" stopColor="var(--cw-glow-core)" stopOpacity="0.44" />
            <stop offset="52%" stopColor="var(--cw-glow-mid)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--cw-glow-mid)" stopOpacity="0" />
          </radialGradient>

          <linearGradient id={`cwRibbon-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--cw-wave-secondary)" stopOpacity="0" />
            <stop offset="18%" stopColor="var(--cw-wave-secondary)" stopOpacity="0.24" />
            <stop offset="50%" stopColor="var(--cw-wave-primary)" stopOpacity="0.34" />
            <stop offset="82%" stopColor="var(--cw-wave-secondary)" stopOpacity="0.24" />
            <stop offset="100%" stopColor="var(--cw-wave-secondary)" stopOpacity="0" />
          </linearGradient>

          <linearGradient id={`cwUnder-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="var(--cw-wave-primary)" stopOpacity="0.25" />
            <stop offset="65%" stopColor="var(--cw-wave-secondary)" stopOpacity="0.06" />
            <stop offset="100%" stopColor="var(--cw-wave-secondary)" stopOpacity="0" />
          </linearGradient>

          <linearGradient id={`cwStrand-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--cw-wave-secondary)" stopOpacity="0.05" />
            <stop offset="16%" stopColor="var(--cw-wave-primary)" stopOpacity="0.55" />
            <stop offset="50%" stopColor="var(--cw-wave-core)" stopOpacity="0.78" />
            <stop offset="84%" stopColor="var(--cw-wave-primary)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--cw-wave-secondary)" stopOpacity="0.05" />
          </linearGradient>

          <linearGradient id={`cwMainGlow-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--cw-wave-secondary)" stopOpacity="0.08" />
            <stop offset="14%" stopColor="var(--cw-wave-primary)" stopOpacity="0.48" />
            <stop offset="50%" stopColor="var(--cw-wave-core)" stopOpacity="0.72" />
            <stop offset="86%" stopColor="var(--cw-wave-primary)" stopOpacity="0.48" />
            <stop offset="100%" stopColor="var(--cw-wave-secondary)" stopOpacity="0.08" />
          </linearGradient>

          <linearGradient id={`cwMainBody-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--cw-wave-secondary)" stopOpacity="0.2" />
            <stop offset="14%" stopColor="var(--cw-wave-primary)" stopOpacity="0.92" />
            <stop offset="50%" stopColor="var(--cw-wave-core)" stopOpacity="1" />
            <stop offset="86%" stopColor="var(--cw-wave-primary)" stopOpacity="0.92" />
            <stop offset="100%" stopColor="var(--cw-wave-secondary)" stopOpacity="0.2" />
          </linearGradient>

          <linearGradient id={`cwMainCore-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--cw-wave-core)" stopOpacity="0" />
            <stop offset="20%" stopColor="var(--cw-wave-core)" stopOpacity="0.82" />
            <stop offset="50%" stopColor="#ffffff" stopOpacity="0.98" />
            <stop offset="80%" stopColor="var(--cw-wave-core)" stopOpacity="0.82" />
            <stop offset="100%" stopColor="var(--cw-wave-core)" stopOpacity="0" />
          </linearGradient>

          <radialGradient id={`cwNodeFlare-${uid}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--cw-wave-core)" stopOpacity="0.9" />
            <stop offset="35%" stopColor="var(--cw-wave-primary)" stopOpacity="0.42" />
            <stop offset="100%" stopColor="var(--cw-wave-primary)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <ellipse
          ref={centerAuraRef}
          cx={CENTER_X}
          cy="68"
          rx="162"
          ry="36"
          fill={`url(#cwAmbient-${uid})`}
        />

        <path ref={underGlowRef} fill={`url(#cwUnder-${uid})`} />
        <path ref={ribbonFillRef} fill={`url(#cwRibbon-${uid})`} />

        <path
          ref={strandLowerRef}
          fill="none"
          stroke={`url(#cwStrand-${uid})`}
          strokeWidth="1.05"
          strokeLinecap="round"
          opacity="0.44"
        />
        <path
          ref={strandUpperRef}
          fill="none"
          stroke={`url(#cwStrand-${uid})`}
          strokeWidth="1.15"
          strokeLinecap="round"
          opacity="0.56"
        />
        <path
          ref={strandMidRef}
          fill="none"
          stroke={`url(#cwStrand-${uid})`}
          strokeWidth="1.65"
          strokeLinecap="round"
          opacity="0.72"
        />

        <path
          ref={mainGlowRef}
          fill="none"
          stroke={`url(#cwMainGlow-${uid})`}
          strokeWidth="8.5"
          strokeLinecap="round"
          opacity="0.45"
        />
        <path
          ref={mainBodyRef}
          fill="none"
          stroke={`url(#cwMainBody-${uid})`}
          strokeWidth="3.1"
          strokeLinecap="round"
        />
        <path
          ref={mainCoreRef}
          fill="none"
          stroke={`url(#cwMainCore-${uid})`}
          strokeWidth="1.3"
          strokeLinecap="round"
        />

        <g className="cd-wave-nodes">
          {WAVE_NODES.map((node, i) => (
            <g
              key={i}
              ref={(el) => {
                nodeRefs.current[i] = el;
              }}
            >
              <circle r={node.r} fill={`url(#cwNodeFlare-${uid})`} />
            </g>
          ))}
        </g>

        <g className="cd-wave-particles">
          {PARTICLES.map((p, i) => (
            <circle
              key={i}
              ref={(el) => {
                particleRefs.current[i] = el;
              }}
              cx={p.x}
              cy={p.y}
              r={p.r}
              fill={i % 2 === 0 ? "var(--cw-node-dot)" : "var(--cw-wave-primary)"}
              opacity={p.baseAlpha}
            />
          ))}
        </g>

        <g className="cd-wave-chords" style={{ direction: "ltr" }}>
          {SLOT_OFFSETS.map((offset, s) => (
            <g
              key={offset}
              ref={(el) => {
                slotRefs.current[s] = el;
              }}
              className="cd-wave-chord"
              style={{ display: "none" }}
              onClick={() => {
                const start = slotStartsRef.current[s];
                if (canPlay && start != null) onSeek(start);
              }}
            >
              <title />
              <circle
                ref={(el) => {
                  slotHaloRefs.current[s] = el;
                }}
                cx="0"
                cy="20"
                r="6"
                fill={`url(#cwNodeFlare-${uid})`}
              />
              <circle
                ref={(el) => {
                  slotDotRefs.current[s] = el;
                }}
                cx="0"
                cy="20"
                r="1.8"
                fill="var(--cw-node-dot)"
              />
              <text
                ref={(el) => {
                  slotTextRefs.current[s] = el;
                }}
                x="0"
                y="0"
                textAnchor="middle"
                dominantBaseline="central"
                className="cd-wave-chord-text"
              />
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
