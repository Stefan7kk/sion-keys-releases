/** Detail-lane geometry. One clock value produces the waveform x and the 12-second lane. */

export const ROLL_SECONDS = 12;
export const PLAYHEAD_LEAD_SECONDS = 4;

export type TimelineSegment = { start: number; end: number };

export type DetailFrame = {
  t: number;
  duration: number;
  windowStart: number;
  windowSec: number;
};

export function detailFrame(time: number, duration: number): DetailFrame {
  const song = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const raw = Number.isFinite(time) ? time : 0;
  const t = Math.min(song, Math.max(0, raw));
  const windowSec = ROLL_SECONDS;
  const maxStart = Math.max(0, song - windowSec);
  const windowStart = Math.min(maxStart, Math.max(0, t - PLAYHEAD_LEAD_SECONDS));
  return { t, duration: song, windowStart, windowSec };
}

/**
 * Parts of the lane window the detector did not label. Drawn as an explicit
 * strip, because a blank hole read as a chord that failed to render.
 */
export function laneGaps(
  segments: readonly TimelineSegment[],
  start: number,
  end: number,
): { start: number; end: number }[] {
  const gaps: { start: number; end: number }[] = [];
  let covered = start;
  for (const segment of segments) {
    if (segment.end <= start || segment.start >= end) continue;
    if (segment.start > covered) gaps.push({ start: covered, end: segment.start });
    covered = Math.max(covered, segment.end);
  }
  if (covered < end) gaps.push({ start: covered, end: end });
  return gaps;
}

export function pxPerSec(width: number, windowSec = ROLL_SECONDS): number {
  return width > 0 && windowSec > 0 ? width / windowSec : 0;
}

/** The lane grows past the fixed scale so an upcoming change is always on screen. */
export const MAX_LANE_SECONDS = 20;
/** Room kept after the upcoming change so its block is not flush against the edge. */
export const LANE_TAIL_SECONDS = 0.75;
/** How much of the incoming chord the lane keeps visible. */
export const UP_COMING_ROOM_SECONDS = 3.5;

/**
 * Length of the detail window needed to show the upcoming chord change.
 * A chord held longer than the fixed horizon would otherwise leave the "Next"
 * hint naming a chord that has no block on the timeline. The window also keeps
 * room for the start of that chord, so the incoming block is drawn as a block
 * and not as a sliver at the edge.
 */
export function laneWindowSec(
  frame: DetailFrame,
  upcomingStart: number | null,
  maxSec = MAX_LANE_SECONDS,
  tailSec = LANE_TAIL_SECONDS,
): number {
  if (upcomingStart == null || !Number.isFinite(upcomingStart)) return frame.windowSec;
  const needed = upcomingStart - frame.windowStart + tailSec;
  return Math.min(maxSec, Math.max(frame.windowSec, needed));
}

/**
 * Same window, but sized so the incoming chord is drawn with a usable width
 * instead of appearing as a sliver at the right edge.
 */
export function laneWindowSecForChord(
  frame: DetailFrame,
  upcoming: { start: number; end: number } | null,
  maxSec = MAX_LANE_SECONDS,
  tailSec = LANE_TAIL_SECONDS,
): number {
  if (!upcoming || !Number.isFinite(upcoming.start) || !Number.isFinite(upcoming.end)) {
    return laneWindowSec(frame, null, maxSec, tailSec);
  }
  const room = Math.min(Math.max(0, upcoming.end - upcoming.start), UP_COMING_ROOM_SECONDS);
  const needed = upcoming.start - frame.windowStart + room + tailSec;
  return Math.min(maxSec, Math.max(frame.windowSec, needed));
}

/** Keep the visible part of a block and its label inside the rolling lane. */
export function visibleLaneSpan(segment: TimelineSegment, frame: DetailFrame) {
  const start = Math.max(frame.windowStart, segment.start);
  const end = Math.min(frame.windowStart + frame.windowSec, segment.end);
  if (end <= start) return null;
  return {
    left: (start - frame.windowStart) / frame.windowSec * 100,
    width: (end - start) / frame.windowSec * 100,
  };
}

/** Intervals are in timeline order and do not overlap. */
function laneIndex(segments: readonly TimelineSegment[], time: number): number {
  let low = 0, high = segments.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (segments[mid].end <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function visibleLaneChords<T extends TimelineSegment>(segments: readonly T[], start: number, end: number): T[] {
  const first = laneIndex(segments, start);
  let last = first;
  while (last < segments.length && segments[last].start < end) last++;
  return segments.slice(first, last);
}

export function chordLaneFrame<T extends TimelineSegment & { label: string }>(
  chords: readonly T[], time: number, duration: number,
) {
  const frame = detailFrame(time, duration);
  const index = laneIndex(chords, frame.t);
  const current = chords[index];
  const active = current && current.start <= frame.t ? current : null;
  let nextIndex = active ? index + 1 : index;
  while (active && nextIndex < chords.length && chords[nextIndex].label === active.label &&
      chords[nextIndex].start <= chords[nextIndex - 1].end + 1e-4) nextIndex++;
  const next = chords[nextIndex];
  // A constant time scale keeps chord widths and scrolling speed stable.
  return { frame, active, next };
}

/** Full-song waveform. This x belongs only to the overview. */
export function xWave(t: number, duration: number, waveWidth: number): number {
  if (!(duration > 0) || !(waveWidth > 0)) return 0;
  return (t / duration) * waveWidth;
}

/** Stationary while the window is away from both ends. */
export function xPlayhead(frame: DetailFrame, laneWidth: number): number {
  return (frame.t - frame.windowStart) * pxPerSec(laneWidth, frame.windowSec);
}

export function xSegment(start: number, frame: DetailFrame, laneWidth: number): number {
  return (start - frame.windowStart) * pxPerSec(laneWidth, frame.windowSec);
}

export function wSegment(start: number, end: number, frame: DetailFrame, laneWidth: number): number {
  return Math.max(0, end - start) * pxPerSec(laneWidth, frame.windowSec);
}

export function xRulerTick(tickTime: number, frame: DetailFrame, laneWidth: number): number {
  return (tickTime - frame.windowStart) * pxPerSec(laneWidth, frame.windowSec);
}

export function activeAt<T extends TimelineSegment>(segments: readonly T[], t: number): T | null {
  const segment = segments[laneIndex(segments, t)];
  return segment && segment.start <= t ? segment : null;
}

/** Whole seconds plus a tenth, so a chord change at 7:12.6 is not labeled 7:12. */
export function formatTimeFine(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
  const clamped = Math.floor(sec * 10 + 1e-6) / 10;
  const whole = Math.floor(clamped);
  const tenth = Math.round((clamped - whole) * 10);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const body = `${pad(s)}.${tenth}`;
  if (h > 0) return `${h}:${pad(m)}:${body}`;
  return `${m}:${body}`;
}
