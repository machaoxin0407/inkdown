/** A fractional, zero-based source line at the editor's viewport top. */
export interface SourceScroll {
  line: number;
  progress: number;
  atStart: boolean;
  atEnd: boolean;
}
export interface ScrollAnchor {
  line: number;
  top: number;
}

/** Interpolate between rendered Markdown blocks, not total pane heights. */
export function previewScrollTop(position: SourceScroll, anchors: ScrollAnchor[], max: number) {
  if (max <= 0 || position.atStart) return 0;
  if (position.atEnd) return max;
  if (!anchors.length) return Math.max(0, Math.min(max, position.progress * max));
  let low = 0,
    high = anchors.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (anchors[mid].line <= position.line) low = mid + 1;
    else high = mid;
  }
  const left = anchors[Math.max(0, low - 1)];
  const right = anchors[Math.min(anchors.length - 1, low)];
  const fraction =
    right.line > left.line
      ? Math.max(0, Math.min(1, (position.line - left.line) / (right.line - left.line)))
      : 0;
  return Math.max(0, Math.min(max, left.top + (right.top - left.top) * fraction));
}
