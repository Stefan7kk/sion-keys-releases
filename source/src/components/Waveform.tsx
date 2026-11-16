import { useMemo, useRef } from "react";
import type { ChordSegment } from "../lib/types";
import { chordToneClass } from "../lib/format";

export function Waveform(props: {
  peaks: number[];
  duration: number;
  currentTime: number;
  chords: ChordSegment[];
  onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { peaks, duration, currentTime, chords, onSeek } = props;

  const bars = useMemo(() => {
    if (!peaks.length) return [];
    return peaks.map((p, i) => ({
      x: (i / peaks.length) * 100,
      h: Math.max(4, p * 100),
    }));
  }, [peaks]);

  const playhead = duration > 0 ? (currentTime / duration) * 100 : 0;

  const onPointer = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(x * duration);
  };

  return (
    <div className="card overflow-hidden p-3">
      <div className="mb-2 flex items-center justify-between text-xs text-[var(--c-muted)]">
        <span>Waveform</span>
        <span>Click or drag to seek</span>
      </div>
      <div
        ref={ref}
        className="relative h-28 w-full cursor-pointer select-none rounded-lg bg-[var(--c-surface)]"
        onPointerDown={onPointer}
      >
        {/* chord color strip */}
        <div className="absolute inset-x-0 top-0 flex h-2 overflow-hidden rounded-t-lg">
          {duration > 0 &&
            chords.map((c, i) => {
              const left = (c.start / duration) * 100;
              const width = Math.max(0.15, ((c.end - c.start) / duration) * 100);
              return (
                <div
                  key={i}
                  title={`${c.display} ${c.start.toFixed(1)}–${c.end.toFixed(1)}`}
                  className={`absolute top-0 h-full border-r border-black/20 ${chordToneClass(c)}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              );
            })}
        </div>

        <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
          {bars.map((b, i) => (
            <rect
              key={i}
              x={`${b.x}%`}
              y={`${50 - b.h / 2}%`}
              width={`${100 / Math.max(peaks.length, 1)}%`}
              height={`${b.h}%`}
              fill="var(--c-accent)"
              opacity={0.55}
            />
          ))}
          <line
            x1={`${playhead}%`}
            x2={`${playhead}%`}
            y1="0%"
            y2="100%"
            stroke="var(--c-accent-2)"
            strokeWidth={2}
          />
        </svg>
      </div>
    </div>
  );
}
