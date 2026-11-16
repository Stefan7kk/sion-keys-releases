import type { ChordSegment } from "../lib/types";
import { chordToneClass, formatTime } from "../lib/format";

export function ChordTimeline(props: {
  chords: ChordSegment[];
  currentTime: number;
  onSeek: (t: number) => void;
}) {
  const activeIdx = props.chords.findIndex(
    (c) => props.currentTime >= c.start && props.currentTime < c.end,
  );

  if (!props.chords.length) {
    return (
      <div className="card p-4 text-sm text-[var(--c-muted)]">
        No chords yet. Analyze a song to see timestamped maj/min/7th/N.C. segments.
      </div>
    );
  }

  return (
    <div className="card p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--c-muted)]">
        Chords
      </div>
      <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto pr-1">
        {props.chords.map((c, i) => {
          const active = i === activeIdx;
          return (
            <button
              key={`${c.start}-${c.label}-${i}`}
              type="button"
              onClick={() => props.onSeek(c.start)}
              className={`rounded-xl border px-3 py-2 text-left transition ${chordToneClass(c)} ${
                active ? "chord-active" : ""
              }`}
              title={`${c.label} · score ${c.score ?? "—"} (${c.scoreKind})`}
            >
              <div className="text-sm font-bold leading-none">{c.display}</div>
              <div className="mt-1 text-[10px] opacity-70">{formatTime(c.start)}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
