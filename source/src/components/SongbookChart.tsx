import { activeOccurrence, transposeSongbookChord, type ChartSync, type SongbookRow } from "../lib/lyrics";
import type { ChordSegment } from "../lib/types";
import { formatTime } from "../lib/format";
import type { ReactNode } from "react";

export function SongbookChart({ rows, activeLine = -1, followLine = -1, transpose = 0, sync, detected, canPlay = false, activeDetected = -1, time = 0, onSeek, onEdit, editHint, renderSection }: {
  rows: SongbookRow[]; activeLine?: number; followLine?: number; transpose?: number;
  sync?: ChartSync | null; detected?: ChordSegment[];
  canPlay?: boolean; activeDetected?: number; time?: number; onSeek?: (time: number) => void; onEdit?: (index: number) => void; editHint?: string;
  renderSection?: (heading: string) => ReactNode;
}) {
  let lyricIndex = -1;
  return <div className="cd-songbook" dir="ltr" tabIndex={0}>
    {rows.map((row, index) => {
      if (row.section) return <div className="cd-songbook-section" key={index}>{renderSection?.(row.text) ?? row.text}</div>;
      const lyric = row.text.trim() ? ++lyricIndex : -1;
      const current = lyric >= 0 && lyric === activeLine;
      const laneEnds: number[] = [];
      const chords = row.chords.map((chord, originalIndex) => ({ ...chord, originalIndex }))
        .sort((a, b) => a.at - b.at).map(chord => {
          const label = transposeSongbookChord(chord.label, transpose);
          const end = chord.at + Array.from(label).length;
          let lane = laneEnds.findIndex(previous => previous < chord.at);
          if (lane < 0) lane = laneEnds.length;
          laneEnds[lane] = end;
          const detectedIndex = chord.detected ?? activeOccurrence(sync?.map[`${index}:${chord.originalIndex}`], detected, time);
          return { ...chord, label, lane, detectedIndex };
        });
      const width = Math.max(1, Array.from(row.text).length, ...laneEnds);
      return <div className="cd-songbook-line" key={index} data-sheet-current={current ? "" : undefined}
        data-sheet-follow={lyric >= 0 && lyric === followLine ? "" : undefined}
        aria-current={current || undefined} style={{ minWidth: width + "ch" }}>
        {laneEnds.map((_, lane) => <div className="cd-songbook-chord-line" key={lane}>
          {chords.filter(chord => chord.lane === lane).map((chord, i) => {
            const target = chord.detectedIndex != null ? detected?.[chord.detectedIndex] : undefined;
            const interactive = Boolean(target && onSeek);
            const isCurrent = interactive && chord.detectedIndex === activeDetected && (!row.timing || current);
            const seekTime = target ? Math.max(target.start, row.timing?.start ?? target.start) : 0;
            const style = { insetInlineStart: chord.at + "ch" };
            if (!interactive) return <span className="cd-songbook-chord" key={i} data-column={chord.at} style={style}>{chord.label}</span>;
            return <button type="button" key={i} data-column={chord.at} style={style}
              className={"cd-songbook-chord cd-songbook-chord-btn" + (isCurrent ? " current" : "")}
              disabled={!canPlay} aria-current={isCurrent || undefined}
              title={`${formatTime(seekTime)}${onEdit && editHint ? " · " + editHint : ""}`}
              onClick={() => onSeek!(seekTime)}
              onDoubleClick={() => onEdit?.(chord.detectedIndex!)}>{chord.label}</button>;
          })}
        </div>)}
        {(row.text || !chords.length) && <div className="cd-songbook-words">{row.text || " "}</div>}
      </div>;
    })}
  </div>;
}
