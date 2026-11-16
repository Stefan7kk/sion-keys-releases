import { formatTime } from "../lib/format";

export function Transport(props: {
  playing: boolean;
  currentTime: number;
  duration: number;
  disabled?: boolean;
  onToggle: () => void;
  onSeek: (t: number) => void;
}) {
  const { playing, currentTime, duration, disabled, onToggle, onSeek } = props;
  return (
    <div className="card flex flex-wrap items-center gap-3 p-3">
      <button
        type="button"
        className="btn btn-primary min-w-[96px]"
        disabled={disabled}
        onClick={onToggle}
      >
        {playing ? "Pause" : "Play"}
      </button>
      <div className="min-w-[88px] font-mono text-sm text-[var(--c-muted)]">
        {formatTime(currentTime)} / {formatTime(duration)}
      </div>
      <input
        type="range"
        className="min-w-[160px] flex-1 accent-[var(--c-accent)]"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(currentTime, duration || 0)}
        disabled={disabled || duration <= 0}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
    </div>
  );
}
