import { describe, it, expect, vi, afterEach } from 'vitest';
import { Backups, quickMatches } from '../src/lib/local-state';
import { sourcePosition, previewScrollTop } from '../src/lib/scroll-sync';
import type { Tab } from '../src/lib/types';
const tab: Tab = {
  id: 'draft-1',
  path: 'C:/中文.md',
  name: '中文.md',
  content: 'new',
  saved: 'old',
  fingerprint: 'base',
  bom: false,
  newline: 'LF',
  scroll: 0,
  edit: true,
  external: false,
  revision: 0,
};
afterEach(() => vi.useRealTimers());
describe('draft lifecycle', () => {
  it('debounces edits but backs up continuous typing within ten seconds', async () => {
    vi.useFakeTimers();
    const port = {
      writeDraft: vi.fn().mockResolvedValue(undefined),
      deleteDraft: vi.fn().mockResolvedValue(undefined),
      writePosition: vi.fn().mockResolvedValue(undefined),
    };
    const b = new Backups(port, vi.fn());
    for (let i = 0; i < 10; i++) {
      b.track({ ...tab, content: String(i) });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(port.writeDraft).toHaveBeenCalledTimes(1);
    expect(port.writeDraft.mock.calls[0][0].content).toBe('9');
    b.track({ ...tab, content: 'final' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(port.writeDraft).toHaveBeenCalledTimes(2);
  });
  it('clear cancels pending work and runs after an in-flight write', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const events: string[] = [];
    const b = new Backups(
      {
        writeDraft: () =>
          new Promise<void>((r) => {
            finish = () => {
              events.push('write');
              r();
            };
          }),
        deleteDraft: async () => {
          events.push('delete');
        },
        writePosition: async () => {},
      },
      vi.fn(),
    );
    b.track(tab);
    await vi.advanceTimersByTimeAsync(2000);
    b.track({ ...tab, content: 'later' });
    const clearing = b.clear(tab.id);
    finish();
    await clearing;
    await vi.advanceTimersByTimeAsync(12000);
    expect(events).toEqual(['write', 'delete']);
  });
  it('reports failures without dropping the retry opportunity', async () => {
    vi.useFakeTimers();
    const fail = vi.fn(),
      writeDraft = vi.fn().mockRejectedValueOnce(Error('disk full')).mockResolvedValue(undefined);
    const b = new Backups(
      { writeDraft, deleteDraft: async () => {}, writePosition: async () => {} },
      fail,
    );
    b.track(tab);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fail).toHaveBeenCalled();
    b.track(tab);
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeDraft).toHaveBeenCalledTimes(2);
  });
});
it('quick open ranks names, deduplicates Windows paths and bounds results', () => {
  const items = [
    { name: '指南.md', path: 'C:/文档/指南.md', id: 'open' },
    { name: '指南.md', path: 'c:\\文档\\指南.md' },
    { name: '说明.md', path: 'C:/指南/说明.md' },
  ];
  expect(quickMatches(items, '指南').map((x) => x.name)).toEqual(['指南.md', '说明.md']);
  expect(quickMatches(items, '文指')[0].id).toBe('open');
  expect(
    quickMatches(
      Array.from({ length: 80 }, (_, i) => ({ name: i + '.md', path: 'C:/' + i + '.md' })),
      '',
    ),
  ).toHaveLength(50);
});
it('source positions survive reflow and clamp shortened documents', () => {
  const p = sourcePosition(
    350,
    [
      { line: 0, top: 0 },
      { line: 10, top: 500 },
    ],
    1000,
  );
  expect(p.line).toBe(7);
  expect(
    previewScrollTop(
      p,
      [
        { line: 0, top: 0 },
        { line: 10, top: 1000 },
      ],
      2000,
    ),
  ).toBe(700);
  expect(
    previewScrollTop(
      p,
      [
        { line: 0, top: 0 },
        { line: 3, top: 200 },
      ],
      100,
    ),
  ).toBe(100);
});
