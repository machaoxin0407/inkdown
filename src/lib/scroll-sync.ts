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

/** Inverse mapping for restoring the same source location after reflow. */
export function sourcePosition(top: number, anchors: ScrollAnchor[], max: number): SourceScroll {
  let left = anchors[0],
    right = anchors[anchors.length - 1];
  for (const point of anchors) {
    if (point.top <= top) left = point;
    else {
      right = point;
      break;
    }
  }
  const fraction =
    left && right && right.top > left.top
      ? Math.max(0, Math.min(1, (top - left.top) / (right.top - left.top)))
      : 0;
  return {
    line: left ? left.line + (right.line - left.line) * fraction : 0,
    progress: max > 0 ? top / max : 0,
    atStart: top <= 1,
    atEnd: max > 0 && top >= max - 1,
  };
}
