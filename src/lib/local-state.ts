import type { SourceScroll } from './scroll-sync';
import type { Tab } from './types';
import { pathKey } from './types';
export interface Position extends SourceScroll {
  path: string;
  edit: boolean;
  cursor: number;
  editorLine: number;
  updatedAt: number;
}
export interface Draft {
  version: number;
  id: string;
  name: string;
  path: string;
  content: string;
  fingerprint: string;
  bom: boolean;
  newline: string;
  position: Position;
  updatedAt: number;
}
export function positionOf(tab: Tab): Position {
  return {
    line: 0,
    progress: 0,
    atStart: true,
    atEnd: false,
    cursor: 0,
    editorLine: 0,
    ...tab.position,
    path: tab.path,
    edit: tab.edit,
    updatedAt: Date.now(),
  };
}
interface Port {
  writeDraft(d: Draft): Promise<unknown>;
  deleteDraft(id: string): Promise<unknown>;
  writePosition(p: Position): Promise<unknown>;
}
/** One serial queue per document: clearing always runs after any in-flight write. */
export class Backups {
  private pending = new Map<
    string,
    { tab: Tab; timer: ReturnType<typeof setTimeout>; max: ReturnType<typeof setTimeout> }
  >();
  private chains = new Map<string, Promise<unknown>>();
  private known = new Map<string, { content: string; path: string; fingerprint: string }>();
  private positionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  positions = new Map<string, Position>();
  constructor(
    private port: Port,
    private onerror: (e: unknown) => void,
  ) {}
  private queue(id: string, action: () => Promise<unknown>) {
    const result = (this.chains.get(id) || Promise.resolve()).then(action);
    this.chains.set(id, result.catch(this.onerror));
    return result;
  }
  track(tab: Tab) {
    const old = this.pending.get(tab.id);
    if (tab.content === tab.saved) {
      if (this.known.has(tab.id)) void this.clear(tab.id).catch(() => {});
      return;
    }
    const signature = { content: tab.content, path: tab.path, fingerprint: tab.fingerprint };
    const previous = this.known.get(tab.id);
    if (
      previous?.content === signature.content &&
      previous?.path === signature.path &&
      previous?.fingerprint === signature.fingerprint
    ) {
      if (old) old.tab = tab;
      return;
    }
    this.known.set(tab.id, signature);
    if (old) {
      clearTimeout(old.timer);
      old.tab = tab;
      old.timer = setTimeout(() => this.flush(tab.id), 2000);
    } else
      this.pending.set(tab.id, {
        tab,
        timer: setTimeout(() => this.flush(tab.id), 2000),
        max: setTimeout(() => this.flush(tab.id), 10000),
      });
  }
  private flush(id: string) {
    const item = this.pending.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    clearTimeout(item.max);
    this.pending.delete(id);
    const t = item.tab;
    const draft: Draft = {
      version: 1,
      id: t.id,
      name: t.name,
      path: t.path,
      content: t.content,
      fingerprint: t.fingerprint,
      bom: t.bom,
      newline: t.newline,
      position: positionOf(t),
      updatedAt: Date.now(),
    };
    void this.queue(id, () => this.port.writeDraft(draft)).catch(() => {
      this.known.delete(id);
    });
  }
  async clear(id: string) {
    const item = this.pending.get(id);
    if (item) {
      clearTimeout(item.timer);
      clearTimeout(item.max);
      this.pending.delete(id);
    }
    this.known.delete(id);
    await this.queue(id, () => this.port.deleteDraft(id));
  }
  remember(tab: Tab) {
    if (!tab.path) return;
    const key = pathKey(tab.path),
      p = positionOf(tab);
    this.positions.set(key, p);
    clearTimeout(this.positionTimers.get(key));
    this.positionTimers.set(
      key,
      setTimeout(() => {
        this.positionTimers.delete(key);
        void this.queue('position:' + key, () => this.port.writePosition(p)).catch(() => {});
      }, 500),
    );
  }
  async settle() {
    for (const id of this.pending.keys()) this.flush(id);
    for (const [key, timer] of this.positionTimers) {
      clearTimeout(timer);
      const p = this.positions.get(key)!;
      void this.queue('position:' + key, () => this.port.writePosition(p)).catch(() => {});
    }
    this.positionTimers.clear();
    await Promise.all(this.chains.values());
  }
}
export interface QuickItem {
  name: string;
  path: string;
  id?: string;
}
export function quickMatches(items: QuickItem[], query: string): QuickItem[] {
  const q = query.trim().toLocaleLowerCase(),
    seen = new Set<string>();
  return items
    .flatMap((item, index) => {
      const key = item.path ? pathKey(item.path) : item.id!;
      if (seen.has(key)) return [];
      seen.add(key);
      const name = item.name.toLocaleLowerCase(),
        path = item.path.toLocaleLowerCase();
      let score = 0;
      if (q) {
        if (name === q) score = 1000;
        else if (name.startsWith(q)) score = 800;
        else if (name.includes(q)) score = 600;
        else if (path.includes(q)) score = 400;
        else {
          let at = -1;
          for (const c of q) {
            at = path.indexOf(c, at + 1);
            if (at < 0) return [];
          }
          score = 100;
        }
      }
      return [{ item, score, index }];
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 50)
    .map((x) => x.item);
}
