import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  markdownDestinations,
  relocateContent,
  relativePath,
  NoteAutosave,
} from '../src/lib/notebook';
import type { Tab } from '../src/lib/types';
import { captureInsertion, changeDocument, documentStates } from '../src/lib/document-state';

describe('portable notebook links', () => {
  it('relocates outgoing pictures and incoming links without touching code or prose', () => {
    const source =
      '# 理解\n\n![图](../assets/pic.png "图")\n[相关](<../Book B/Other.md#概念>)\n`[例](A.md)`\n```md\n![图](../assets/pic.png)\n```\n';
    const next = relocateContent(source, 'C:/库/Book/A.md', 'C:/库/Book/章/A.md', []);
    expect(next).toContain('![图](../../assets/pic.png "图")');
    expect(next).toContain('[相关](<../../Book%20B/Other.md#概念>)');
    expect(next).toContain('`[例](A.md)`');
    expect(next).toContain('```md\n![图](../assets/pic.png)');
    const incoming = relocateContent(
      '[知识](Book/A.md?x=1#段)',
      'C:/库/Index.md',
      'C:/库/Index.md',
      [{ oldPath: 'C:/库/Book/A.md', newPath: 'C:/库/Book/章/A.md' }],
    );
    expect(incoming).toBe('[知识](Book/%E7%AB%A0/A.md?x=1#段)');
  });
  it('finds inline and reference images, escaped labels, and shared definitions', () => {
    const source =
      '![图][shared]\n[下载][shared]\n\n[shared]: <assets/图 1.png> "title"\n\n![直接](a.png)\n[网页](https://example.com)';
    const spans = markdownDestinations(source);
    expect(spans.filter((s) => s.image)).toHaveLength(2);
    expect(spans.some((s) => s.href.includes('%E5%9B%BE') && s.image)).toBe(true);
    expect(relocateContent(source, 'C:/库/原.md', 'C:/库/章节/原.md', [])).toContain(
      '[shared]: <../assets/%E5%9B%BE%201.png> "title"',
    );
  });
  it('includes an image used as a link label', () => {
    expect(
      markdownDestinations('[![图](assets/a.png)](https://example.com)')
        .filter((s) => s.image)
        .map((s) => s.href),
    ).toEqual(['assets/a.png']);
  });
  it('keeps asynchronous insertion points on their owner without swallowing newly typed text', () => {
    const bookmark = captureInsertion('pending-image', 3);
    const content = changeDocument('pending-image', 'abc', { from: 3, insert: '继续输入' });
    expect(bookmark.point).toEqual({ from: 7, to: 7 });
    expect(
      changeDocument('pending-image', content, { ...bookmark.point, insert: '![图](a.png)' }),
    ).toBe('abc继续输入![图](a.png)');
    bookmark.release();
    documentStates.delete('pending-image');
  });
  it('leaves external URLs, anchors, code and malformed destinations unchanged', () => {
    const source =
      '[web](https://x.com)\n[mail](mailto:a@b.com)\n[anchor](#a)\n\n    [code](old.md)\n\n[bad](<unfinished';
    expect(relocateContent(source, 'C:/a.md', 'C:/b/a.md', [])).toBe(source);
    expect(relativePath('C:/库/甲/一.md', 'c:/库/乙/二.md')).toBe('../乙/二.md');
  });
});

describe('note autosave ownership and serialization', () => {
  afterEach(() => vi.useRealTimers());
  const tab = (id: string, content: string): Tab => ({
    id,
    path: `C:/${id}.md`,
    name: id,
    content,
    saved: '',
    fingerprint: 'v1',
    bom: false,
    newline: 'LF',
    scroll: 0,
    edit: true,
    external: false,
    revision: 0,
  });
  it('saves each owning note after idle, not the active note', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => true),
      a = new NoteAutosave(save);
    a.track(tab('a', 'A'));
    await vi.advanceTimersByTimeAsync(1000);
    a.track(tab('b', 'B'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(save.mock.calls).toEqual([['a']]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save.mock.calls).toEqual([['a'], ['b']]);
    a.dispose();
  });
  it('flushes continuous typing after ten seconds and serializes manual writes', async () => {
    vi.useFakeTimers();
    let finish: (ok: boolean) => void = () => {};
    const save = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve))),
      a = new NoteAutosave(save);
    for (let n = 0; n < 10; n++) {
      a.track(tab('a', String(n)));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(save).toHaveBeenCalledTimes(1);
    const manual = vi.fn(async () => true),
      task = a.serial('a', manual);
    await Promise.resolve();
    expect(manual).not.toHaveBeenCalled();
    finish(true);
    await task;
    expect(manual).toHaveBeenCalledOnce();
    a.dispose();
  });
  it('blocks a failed note until resumed and never schedules external conflicts', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => false),
      a = new NoteAutosave(save);
    a.track({ ...tab('external', 'x'), external: true });
    a.track(tab('a', '1'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(a.blocked.has('a')).toBe(true);
    a.track(tab('a', '2'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(save).toHaveBeenCalledTimes(1);
    a.resume('a');
    a.track(tab('a', '2'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
    a.dispose();
  });
});
