import { writable } from 'svelte/store';
import { api, desktop } from './api';
import { pathKey, basename, isMarkdown } from './types';

export interface SearchHit {
  path: string; line: number; from: number; to: number; snippet: string;
  sourceVersion: string; query: string; sensitive: boolean;
}
export interface FileChanges {
  generation: number; paths: string[]; structural: boolean; failed: boolean;
}
export interface ChangeBatch { paths: string[]; full: boolean; root: string; epoch: number }
/** A single writer for tree, index and external-document reconciliation. */
export class ChangeCoordinator {
  private root = '';
  private epoch = 0;
  private pending = new Map<string, string>();
  private full = false;
  private timer?: ReturnType<typeof setTimeout>;
  private tail: Promise<void> = Promise.resolve();
  constructor(private handle: (batch: ChangeBatch) => Promise<void>, private onerror: (e: unknown) => void) {}
  setRoot(root: string) {
    if (pathKey(root) === pathKey(this.root)) return;
    this.root = root;
    this.epoch++;
    this.pending.clear();
    this.full = false;
    clearTimeout(this.timer);
  }
  current(batch: ChangeBatch) { return batch.epoch === this.epoch; }
  enqueue(paths: string[] = [], full = false, immediate = false) {
    for (const path of paths) this.pending.set(pathKey(path), path);
    this.full ||= full;
    clearTimeout(this.timer);
    if (immediate) return this.flush();
    this.timer = setTimeout(() => { void this.flush(); }, 300);
    return this.tail;
  }
  flush() {
    clearTimeout(this.timer);
    const batch = { root: this.root, epoch: this.epoch, paths: [...this.pending.values()], full: this.full };
    this.pending.clear();
    this.full = false;
    if (!batch.full && !batch.paths.length) return this.tail;
    this.tail = this.tail.then(async () => {
      if (this.current(batch)) await this.handle(batch);
    }).catch(this.onerror);
    return this.tail;
  }
  dispose() { clearTimeout(this.timer); this.epoch++; this.pending.clear(); }
}
interface IndexPort {
  index(path: string): Promise<{ paths: string[]; skipped: number; cancelled: boolean }>;
  fingerprint(path: string): Promise<string | null>;
  cancelIndex(): Promise<unknown>;
}
export const indexState = writable({ paths: [] as string[], loading: false, message: '' });
export class WorkspaceIndex {
  private root = '';
  private epoch = 0;
  private loaded = false;
  private paths: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  constructor(private port: IndexPort, private publish: typeof indexState.set) {}
  setRoot(root: string) {
    if (pathKey(root) === pathKey(this.root)) return;
    this.root = root;
    this.epoch++;
    this.loaded = false;
    this.paths = [];
    this.publish({ paths: [], loading: false, message: '' });
    void this.port.cancelIndex().catch(() => {});
  }
  private serial(action: (root: string, valid: () => boolean) => Promise<void>) {
    const root = this.root, epoch = this.epoch;
    const valid = () => epoch === this.epoch;
    const task = this.tail.then(async () => { if (root && valid()) await action(root, valid); });
    this.tail = task.catch((e) => {
      if (valid()) this.publish({ paths: this.paths, loading: false, message: String(e) });
    });
    return this.tail;
  }
  private async scan(root: string, valid: () => boolean) {
    this.publish({ paths: this.paths, loading: true, message: '' });
    const result = await this.port.index(root);
    if (!valid()) return;
    if (!result.cancelled) {
      this.paths = result.paths.filter(isMarkdown);
      this.loaded = true;
    }
    this.publish({ paths: this.paths, loading: false, message: result.skipped ? `已跳过 ${result.skipped} 个无法访问的项目` : '' });
  }
  refresh(force = false) {
    return this.serial(async (root, valid) => { if (!this.loaded || force) await this.scan(root, valid); });
  }
  update(changes: string[], structural = false) {
    return this.serial(async (root, valid) => {
      if (!this.loaded) return;
      if (structural) { await this.scan(root, valid); return; }
      const next = new Map(this.paths.map((p) => [pathKey(p), p]));
      let skipped = 0;
      for (const path of changes) {
        if (!valid()) return;
        if (!isMarkdown(path) || !pathKey(path).startsWith(pathKey(root) + '/')) continue;
        try {
          if (await this.port.fingerprint(path) !== null) next.set(pathKey(path), path);
          else next.delete(pathKey(path));
        } catch { skipped++; }
      }
      if (!valid()) return;
      this.paths = [...next.values()].sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
      this.publish({ paths: this.paths, loading: false, message: skipped ? `${skipped} 个文件无法检查，请刷新重试` : '' });
    });
  }
}
const index = new WorkspaceIndex(api, indexState.set);
export const setWorkspace = (path: string) => { if (desktop) index.setRoot(path); };
export const refreshIndex = (force = false) => desktop ? index.refresh(force) : Promise.resolve();
export const updateIndex = (changes: string[], structural = false) => desktop ? index.update(changes, structural) : Promise.resolve();
