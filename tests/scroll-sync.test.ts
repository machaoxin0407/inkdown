import { describe, it, expect } from 'vitest';
import { previewScrollTop, type SourceScroll } from '../src/lib/scroll-sync';
import { parseMarkdown } from '../src/lib/parse';
const position = (line: number): SourceScroll => ({
  line,
  progress: 0.5,
  atStart: false,
  atEnd: false,
});
describe('source-based scroll synchronization', () => {
  const anchors = [
    { line: 0, top: 30 },
    { line: 10, top: 200 },
    { line: 20, top: 900 },
  ];
  it('aligns matching blocks despite unequal preview heights', () => {
    expect(previewScrollTop(position(10), anchors, 1200)).toBe(200);
    expect(previewScrollTop(position(15), anchors, 1200)).toBe(550);
    expect(previewScrollTop(position(5), anchors, 1200)).toBe(115);
  });
  it('pins top and bottom and clamps non-scrollable/short panes', () => {
    expect(previewScrollTop({ ...position(5), atStart: true }, anchors, 1200)).toBe(0);
    expect(previewScrollTop({ ...position(15), atEnd: true }, anchors, 1200)).toBe(1200);
    expect(previewScrollTop(position(20), anchors, 100)).toBe(100);
    expect(previewScrollTop(position(20), anchors, -20)).toBe(0);
  });
  it('handles missing anchors and fractional wrapped source lines', () => {
    expect(previewScrollTop(position(3), [], 600)).toBe(300);
    expect(previewScrollTop(position(10.5), anchors, 1200)).toBe(235);
  });
  it('maps regular blocks, fences, diagrams, and formulas to original source lines', () => {
    const { html } = parseMarkdown(
      '# Title\n\nParagraph\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n$$x^2$$\n\n```text\nhello\n```\n\n- item',
    );
    for (const line of [0, 2, 4, 9, 11, 15]) expect(html).toContain(`data-source-line="${line}"`);
    expect(html).toContain('class="diagram-source" data-source-line="4"');
    expect(html).toContain('data-math="block" data-source-line="9"');
  });
});
