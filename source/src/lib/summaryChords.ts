/** Fit an ordered prefix and, when needed, its exact overflow count. */
export function visibleSummaryChords(
  widths: readonly number[],
  moreWidths: readonly number[],
  availableWidth: number,
  gap: number,
  rows: number,
): number {
  let row = 1;
  let used = 0;
  let visible = 0;
  for (let count = 0; count < widths.length; count++) {
    const more = moreWidths[widths.length - count];
    if (more <= availableWidth && (row < rows || used + (used ? gap : 0) + more <= availableWidth)) {
      visible = count;
    }
    const width = widths[count];
    if (width > availableWidth) return visible;
    if (used && used + gap + width > availableWidth) {
      if (++row > rows) return visible;
      used = 0;
    }
    used += (used ? gap : 0) + width;
  }
  return widths.length;
}
