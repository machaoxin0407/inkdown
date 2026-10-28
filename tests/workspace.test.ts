import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/lib/api', () => ({ desktop: false, api: {} }));
import { ChangeCoordinator, WorkspaceIndex } from '../src/lib/workspace';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => resolve = r); return { promise, resolve }; };
afterEach(() => vi.useRealTimers());
it('serializes overlapping index batches without dropping files and excludes assets', async () => {
  let paths: string[] = [];
  const a = deferred<string>();
  const port = { index: vi.fn(async () => ({ paths: ['C:/work/base.md'], skipped: 0, cancelled: false })), cancelIndex: vi.fn(async () => {}), fingerprint: vi.fn((p: string) => p.endsWith('/a.md') ? a.promise : Promise.resolve('hash')) };
  const index = new WorkspaceIndex(port, (s) => paths = s.paths);
  index.setRoot('C:/work'); await index.refresh();
  const first = index.update(['C:/work/a.md']);
  const second = index.update(['C:/work/b.md', 'C:/work/image.png']);
  a.resolve('hash'); await Promise.all([first, second]);
  expect(paths).toEqual(['C:/work/a.md', 'C:/work/b.md', 'C:/work/base.md']);
  expect(port.fingerprint).not.toHaveBeenCalledWith('C:/work/image.png');
});
it('replays changes arriving during a full scan and ignores results from an old workspace', async () => {
  let paths: string[] = [];
  const scan = deferred<{ paths: string[]; skipped: number; cancelled: boolean }>();
  const port = { index: vi.fn().mockReturnValueOnce(scan.promise).mockResolvedValue({ paths: ['C:/new/new.md'], skipped: 0, cancelled: false }), cancelIndex: vi.fn(async () => {}), fingerprint: vi.fn(async () => 'hash') };
  const index = new WorkspaceIndex(port, (s) => paths = s.paths);
  index.setRoot('C:/work'); const first = index.refresh();
  await Promise.resolve();
  const update = index.update(['C:/work/a.md']);
  scan.resolve({ paths: ['C:/work/base.md'], skipped: 0, cancelled: false });
  await Promise.all([first, update]);
  expect(paths).toContain('C:/work/a.md');
  index.setRoot('C:/new'); await index.refresh();
  await index.update(['C:/work/outdated.md']);
  expect(paths).toEqual(['C:/new/new.md']);
});
it('coalesces events, queues a second batch behind in-flight work and discards old epochs', async () => {
  vi.useFakeTimers();
  const gate = deferred<void>(), batches: string[][] = [];
  const handler = vi.fn(async (b) => { batches.push(b.paths); if (batches.length === 1) await gate.promise; });
  const coordinator = new ChangeCoordinator(handler, (e) => { throw e; });
  coordinator.setRoot('C:/work');
  coordinator.enqueue(['C:/work/a.md']); coordinator.enqueue(['c:/WORK/a.md', 'C:/work/b.md']);
  await vi.advanceTimersByTimeAsync(300);
  expect(handler).toHaveBeenCalledTimes(1); expect(batches[0]).toHaveLength(2);
  coordinator.enqueue(['C:/work/c.md']); await vi.advanceTimersByTimeAsync(300);
  expect(handler).toHaveBeenCalledTimes(1);
  coordinator.setRoot('C:/new'); gate.resolve(); await coordinator.flush();
  expect(handler).toHaveBeenCalledTimes(1);
  coordinator.dispose();
});

it('cannot publish an in-flight scan after switching workspaces', async () => {
  const old=deferred<{paths:string[];skipped:number;cancelled:boolean}>(),published:string[][]=[];
  const port={index:vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({paths:['C:/new/new.md'],skipped:0,cancelled:false}),cancelIndex:vi.fn(async()=>{}),fingerprint:vi.fn(async()=>null)};
  const index=new WorkspaceIndex(port,(state)=>published.push(state.paths));
  index.setRoot('C:/old');const first=index.refresh();await Promise.resolve();
  index.setRoot('C:/new');const next=index.refresh();old.resolve({paths:['C:/old/old.md'],skipped:0,cancelled:false});await Promise.all([first,next]);
  expect(published.some((paths)=>paths.includes('C:/old/old.md'))).toBe(false);
  expect(published.at(-1)).toEqual(['C:/new/new.md']);
});
