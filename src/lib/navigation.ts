import type { Position } from './local-state';
import { pathKey } from './types';
export interface Visit { id: string; path: string; name: string; position: Position }
export class NavigationHistory {
  entries: Visit[] = [];
  cursor = -1;
  closed: Visit[] = [];
  get canBack() { return this.cursor > 0; }
  get canForward() { return this.cursor < this.entries.length - 1; }
  update(visit: Visit) {
    const current = this.entries[this.cursor];
    if (current && current.id === visit.id) this.entries[this.cursor] = structuredClone(visit);
  }
  visit(visit: Visit) {
    this.entries.splice(this.cursor + 1);
    this.entries.push(structuredClone(visit));
    if (this.entries.length > 100) this.entries.shift();
    this.cursor = this.entries.length - 1;
  }
  move(direction: number) {
    const next = this.cursor + direction;
    if (next < 0 || next >= this.entries.length) return undefined;
    this.cursor = next;
    return structuredClone(this.entries[next]);
  }
  close(visit: Visit) {
    if (!visit.path) return;
    this.closed.push(structuredClone(visit));
    if (this.closed.length > 20) this.closed.shift();
  }
  rename(oldPath: string, path: string, name: string) {
    for (const entry of [...this.entries, ...this.closed]) if (pathKey(entry.path) === pathKey(oldPath)) {
      entry.path = path; entry.name = name; entry.position.path = path;
    }
  }
  clear() { this.entries = []; this.closed = []; this.cursor = -1; }
}
