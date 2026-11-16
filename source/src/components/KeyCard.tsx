import type { KeyResult } from "../lib/types";
import { formatScore } from "../lib/format";

export function KeyCard(props: { keyResult: KeyResult | null }) {
  const k = props.keyResult;
  if (!k) {
    return (
      <div className="card flex min-h-[120px] flex-col justify-center p-5">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--c-muted)]">Key</div>
        <div className="mt-2 text-2xl font-bold text-[var(--c-muted)]">—</div>
        <div className="mt-1 text-xs text-[var(--c-muted)]">Waiting for analysis</div>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--c-muted)]">Key</div>
          <div className="mt-1 text-3xl font-extrabold tracking-tight text-[var(--c-text)]">
            {k.label}
          </div>
          {k.uncertain && (
            <div className="mt-1 text-xs font-semibold text-amber-300">Uncertain / close alternatives</div>
          )}
        </div>
        <div className="rounded-lg bg-[var(--c-accent-soft)] px-3 py-2 text-right">
          <div className="text-[10px] uppercase text-[var(--c-muted)]">Correlation</div>
          <div className="text-lg font-bold text-[var(--c-accent-2)]">
            {formatScore(k.score, k.scoreKind)}
          </div>
          <div className="text-[10px] text-[var(--c-muted)]">not probability</div>
        </div>
      </div>
      {k.alternative && (
        <div className="mt-3 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] px-3 py-2 text-sm">
          <span className="text-[var(--c-muted)]">Alternative </span>
          <span className="font-semibold">{k.alternative.label}</span>
          {k.alternative.relation && (
            <span className="text-[var(--c-muted)]"> ({k.alternative.relation})</span>
          )}
          {k.alternative.score != null && (
            <span className="text-[var(--c-muted)]">
              {" "}
              · {formatScore(k.alternative.score, k.alternative.scoreKind)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
