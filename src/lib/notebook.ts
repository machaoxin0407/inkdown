import { invoke } from '@tauri-apps/api/core';
import MarkdownIt from 'markdown-it';
import { api } from './api';
import { pathKey, type DocumentData, type Tab } from './types';
import { applyReferenceEdits, type ReferenceEdit } from './references';

export interface LibraryItem {
  id: string;
  kind: 'notebook' | 'chapter' | 'note';
  parent: string;
  name: string;
  path: string;
  order: number;
  color: string;
}
export type Notebook = LibraryItem & { kind: 'notebook' };
export type Chapter = LibraryItem & { kind: 'chapter' };
export interface NoteSummary {
  excerpt: string;
  updatedAt: number;
}
export interface TrashEntry {
  id: string;
  originalPath: string;
  storedPath: string;
  deletedAt: number;
  items: LibraryItem[];
}
export interface NotebookLibrary {
  root: string;
  revision: string;
  items: LibraryItem[];
  trash: TrashEntry[];
  summaries: Record<string, NoteSummary>;
  pending: string[];
  warnings: string[];
}
export interface PathMapping {
  oldPath: string;
  newPath: string;
}
export interface StructurePlan {
  id: string;
  revision: string;
  moves: PathMapping[];
  mappings: PathMapping[];
  next: { items: LibraryItem[]; trash: TrashEntry[] };
  action: string;
}
export interface NotebookEdit {
  path: string;
  expected: string;
  content: string;
  bom: boolean;
  newline: string;
}
export interface OperationOutcome {
  mappings: PathMapping[];
  documents: DocumentData[];
  complete: boolean;
  errors: string[];
}
export interface ImportPlan {
  id: string;
  revision: string;
  parent: string;
  files: { source: string; destination: string; id: string; document: DocumentData }[];
  warnings: string[];
}
export const notebookApi = {
  open: (path: string, create = false, rebuild = false) =>
    invoke<NotebookLibrary>('notebook_open', { path, create, rebuild }),
  refresh: (root: string) => invoke<NotebookLibrary>('notebook_refresh', { root }),
  create: (l: NotebookLibrary, parent: string, kind: string, name: string, content = '') =>
    invoke<NotebookLibrary>('notebook_create', {
      root: l.root,
      expected: l.revision,
      parent,
      kind,
      name,
      content,
    }),
  style: (l: NotebookLibrary, ids: string[], color?: string) =>
    invoke<NotebookLibrary>('notebook_style', {
      root: l.root,
      expected: l.revision,
      ids,
      color: color || null,
    }),
  prepare: (l: NotebookLibrary, itemId: string, action: string, parent = '', name = '') =>
    invoke<StructurePlan>('notebook_prepare', {
      root: l.root,
      expected: l.revision,
      itemId,
      action,
      parent,
      name,
    }),
  execute: (root: string, planId: string, edits: NotebookEdit[]) =>
    invoke<OperationOutcome>('notebook_execute', { root, planId, edits }),
  recover: (root: string, operation: string, acceptCurrent = false) =>
    invoke<OperationOutcome>('notebook_recover', { root, operation, acceptCurrent }),
  attachment: (root: string, noteId: string, name: string, bytes: number[]) =>
    invoke<string>('notebook_attachment', { root, noteId, name, bytes }),
  importPrepare: (l: NotebookLibrary, parent: string, sources: string[]) =>
    invoke<ImportPlan>('notebook_import_prepare', {
      root: l.root,
      expected: l.revision,
      parent,
      sources,
    }),
  probeImage: (source: string) =>
    invoke<{ fingerprint: string }>('notebook_probe_image', { source }),
  importCommit: (
    root: string,
    planId: string,
    fileId: string,
    content: string,
    images: { source: string; name: string; expected: string }[],
  ) => invoke<string>('notebook_import_commit', { root, planId, fileId, content, images }),
};
export const absolute = (root: string, rel: string) => root.replace(/[\\/]$/, '') + '/' + rel;
export function normalizePath(path: string) {
  const parts: string[] = [];
  for (const p of path.replace(/\\/g, '/').split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  return parts.join('/');
}
export function relativePath(document: string, target: string) {
  const a = normalizePath(document).split('/').slice(0, -1),
    b = normalizePath(target).split('/');
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
export function resolveRelative(document: string, href: string) {
  if (/^(?:[a-z][a-z\d+.-]*:|[\\/]|#)/i.test(href)) return '';
  try {
    return normalizePath(
      document.replace(/[^\\/]+$/, '') + decodeURIComponent(href.split(/[?#]/)[0]),
    );
  } catch {
    return '';
  }
}
export function noteForPath(l: NotebookLibrary | null, path: string) {
  return l?.items.find(
    (i) => i.kind === 'note' && pathKey(absolute(l.root, i.path)) === pathKey(path),
  );
}
const md = new MarkdownIt({ html: false });
/** Only destination spans are changed. Fences, inline code and ordinary text stay intact. */
export function markdownDestinations(
  source: string,
): { from: number; to: number; href: string; image: boolean }[] {
  const env: { references?: Record<string, { href: string }> } = {};
  const tokens = md.parse(source, env),
    starts = [0];
  for (let n = source.indexOf('\n'); n >= 0; n = source.indexOf('\n', n + 1)) starts.push(n + 1);
  const excluded = tokens
    .filter((t) => ['fence', 'code_block'].includes(t.type) && t.map)
    .map((t) => [starts[t.map![0]], starts[t.map![1]] ?? source.length]);
  const out: { from: number; to: number; href: string; image: boolean }[] = [];
  const references = new Map<string, boolean>();
  const key = (s: string) => md.utils.unescapeAll(s).trim().replace(/\s+/g, ' ').toUpperCase();
  const parse = (at: number, image: boolean) => {
    const d = md.helpers.parseLinkDestination(source, at, source.length);
    if (!d.ok) return null;
    return {
      from: source[at] === '<' ? at + 1 : at,
      to: source[at] === '<' ? d.pos - 1 : d.pos,
      href: md.normalizeLink(d.str),
      image,
    };
  };
  const definitions: { from: number; to: number; href: string; image: boolean; key: string }[] = [];
  for (const m of source.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:\n[ \t]*)?/gm)) {
    if (excluded.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
    const d = parse(m.index! + m[0].length, false);
    if (d && env.references?.[key(m[1])]?.href === d.href) {
      definitions.push({ ...d, key: key(m[1]) });
      excluded.push([
        m.index!,
        source.indexOf('\n', d.to) < 0 ? source.length : source.indexOf('\n', d.to),
      ]);
    }
  }
  for (let i = 0; i < source.length; i++) {
    if (excluded.some(([a, b]) => i >= a && i < b)) continue;
    if (source[i] === '\\') {
      i++;
      continue;
    }
    if (source[i] === '`') {
      let end = i;
      while (source[end] === '`') end++;
      const run = source.slice(i, end);
      let close = end;
      while ((close = source.indexOf(run, close)) >= 0) {
        if (source[close - 1] !== '`' && source[close + run.length] !== '`') break;
        close += run.length;
      }
      i = close < 0 ? end - 1 : close + run.length - 1;
      continue;
    }
    if (source[i] !== '[') continue;
    const image = i > 0 && source[i - 1] === '!';
    let depth = 1,
      end = i + 1;
    for (; end < source.length; end++) {
      if (source[end] === '\\') {
        end++;
        continue;
      }
      if (source[end] === '[') depth++;
      if (source[end] === ']' && --depth === 0) break;
    }
    if (end >= source.length) continue;
    if (source[end + 1] === '(') {
      let at = end + 2;
      while (/\s/.test(source[at] || '') && at < source.length) at++;
      const d = parse(at, image);
      if (!d) continue;
      // Ask markdown-it to validate the complete inline construct, including its title.
      let close = d.to + (source[at] === '<' ? 1 : 0),
        quote = '';
      for (; close < source.length; close++) {
        const c = source[close];
        if (c === '\\') {
          close++;
          continue;
        }
        if (quote) {
          if (c === quote) quote = '';
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          continue;
        }
        if (c === ')') break;
        if (c === '\n' && source[close + 1] === '\n') break;
      }
      const parsed: import('markdown-it/lib/token.mjs').default[] = [];
      md.inline.parse(source.slice(image ? i - 1 : i, close + 1), md, env, parsed);
      if (
        parsed.some(
          (t) =>
            (t.type === 'link_open' && t.attrGet('href') === d.href) ||
            (t.type === 'image' && t.attrGet('src') === d.href),
        )
      ) {
        out.push(d);
        if (!image && source.slice(i + 1, end).includes('!['))
          for (const nested of markdownDestinations(source.slice(i + 1, end)))
            out.push({ ...nested, from: nested.from + i + 1, to: nested.to + i + 1 });
      }
      i = close;
    } else {
      let label = source.slice(i + 1, end);
      if (source[end + 1] === '[') {
        const close = source.indexOf(']', end + 2);
        if (close >= 0) label = source.slice(end + 2, close) || label;
      }
      references.set(key(label), image || references.get(key(label)) || false);
    }
  }
  for (const d of definitions)
    if (references.has(d.key) && !out.some((o) => o.from === d.from))
      out.push({ ...d, image: references.get(d.key)! });
  return out.sort((a, b) => a.from - b.from);
}
export function rewriteDestinations(
  content: string,
  mapper: (href: string, image: boolean, raw: string) => string | undefined,
) {
  const edits: ReferenceEdit[] = [];
  for (const span of markdownDestinations(content)) {
    const next = mapper(span.href, span.image, content.slice(span.from, span.to));
    if (next !== undefined && next !== span.href)
      edits.push({ from: span.from, to: span.to, insert: next });
  }
  return applyReferenceEdits(content, edits);
}
const encoded = (p: string) => p.split('/').map(encodeURIComponent).join('/');
export function relocateContent(
  content: string,
  oldDocument: string,
  newDocument: string,
  mappings: PathMapping[],
) {
  return rewriteDestinations(content, (href, _image, raw) => {
    const target = resolveRelative(oldDocument, href);
    if (!target) return;
    const moved = mappings.find((m) => pathKey(m.oldPath) === pathKey(target));
    if (!moved && pathKey(oldDocument) === pathKey(newDocument)) return;
    return (
      encoded(relativePath(newDocument, moved?.newPath || target)) +
      (raw.match(/[?#].*$/)?.[0] || '')
    );
  });
}
export async function structureEdits(
  l: NotebookLibrary,
  plan: StructurePlan,
): Promise<NotebookEdit[]> {
  if (plan.action === 'trash') return [];
  const edits: NotebookEdit[] = [],
    mappings = plan.mappings.map((m) => ({
      oldPath: absolute(l.root, m.oldPath),
      newPath: absolute(l.root, m.newPath),
    }));
  const items = plan.action === 'restore' ? plan.next.items : l.items;
  for (const item of items.filter((i) => i.kind === 'note')) {
    let oldRel = item.path,
      sourceRel = item.path,
      newRel = item.path;
    if (plan.action === 'restore') {
      const mapping = plan.mappings.find((m) => pathKey(m.newPath) === pathKey(item.path));
      if (mapping) {
        oldRel = mapping.oldPath;
        const mv = plan.moves[0];
        sourceRel = mv.oldPath + item.path.slice(mv.newPath.length);
      }
    } else
      newRel =
        plan.mappings.find((m) => pathKey(m.oldPath) === pathKey(item.path))?.newPath || item.path;
    const d = await api.read(absolute(l.root, sourceRel));
    const content = relocateContent(
      d.content,
      absolute(l.root, oldRel),
      absolute(l.root, newRel),
      mappings,
    );
    if (content !== d.content)
      edits.push({
        path: newRel,
        content,
        expected: d.fingerprint,
        bom: d.bom,
        newline: d.newline,
      });
  }
  return edits;
}
export async function prepareImport(l: NotebookLibrary, plan: ImportPlan) {
  const warnings = [...plan.warnings],
    prepared = [];
  for (const file of plan.files) {
    const images: { source: string; name: string; expected: string }[] = [],
      replacements = new Map<string, string>();
    for (const span of markdownDestinations(file.document.content)) {
      const target = resolveRelative(file.source, span.href);
      if (!target) {
        if (span.image) warnings.push(`${file.source}：图片 ${span.href} 需本地导入`);
        continue;
      }
      const imported = plan.files.find((f) => pathKey(f.source) === pathKey(target));
      if (imported && !span.image) {
        replacements.set(
          span.href,
          encoded(relativePath(file.destination, imported.destination)) +
            (file.document.content.slice(span.from, span.to).match(/[?#].*$/)?.[0] || ''),
        );
        continue;
      }
      if (!span.image) {
        warnings.push(`${file.source}：关联文件未导入 ${span.href}`);
        continue;
      }
      if (replacements.has(span.href)) continue;
      try {
        const probe = await notebookApi.probeImage(target);
        const ext = target.split('.').pop()!.toLowerCase(),
          name = `image-${images.length + 1}.${ext}`;
        images.push({ source: target, name, expected: probe.fingerprint });
        replacements.set(
          span.href,
          encoded(relativePath(file.destination, `assets/${file.id}/${name}`)),
        );
      } catch (e) {
        warnings.push(`${file.source}：${span.href} — ${String(e)}`);
      }
    }
    prepared.push({
      file,
      images,
      content: rewriteDestinations(file.document.content, (href) => replacements.get(href)),
    });
  }
  return { prepared, warnings };
}

/** Separate queues per document; timers never replace an in-flight save. */
export class NoteAutosave {
  private tasks = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; max: ReturnType<typeof setTimeout> }
  >();
  private chains = new Map<string, Promise<boolean>>();
  private signatures = new Map<string, string>();
  blocked = new Set<string>();
  paused = false;
  constructor(
    private save: (id: string) => Promise<boolean>,
    private changed: () => void = () => {},
  ) {}
  track(tab: Tab) {
    if (tab.content === tab.saved && !tab.pending) {
      this.cancel(tab.id);
      this.signatures.delete(tab.id);
      return;
    }
    if (this.paused || this.blocked.has(tab.id) || tab.external) return;
    const signature = tab.content + '\0' + tab.pending;
    if (this.signatures.get(tab.id) === signature) return;
    this.signatures.set(tab.id, signature);
    const old = this.tasks.get(tab.id);
    if (old) clearTimeout(old.timer);
    this.tasks.set(tab.id, {
      timer: setTimeout(() => void this.flush(tab.id), 2000),
      max: old?.max || setTimeout(() => void this.flush(tab.id), 10000),
    });
  }
  cancel(id: string) {
    const t = this.tasks.get(id);
    if (t) {
      clearTimeout(t.timer);
      clearTimeout(t.max);
    }
    this.tasks.delete(id);
  }
  serial(id: string, work: () => Promise<boolean>) {
    const task = (this.chains.get(id) || Promise.resolve(true)).then(work);
    const tracked = task.catch(() => false);
    this.chains.set(id, tracked);
    void tracked.finally(() => {
      if (this.chains.get(id) === tracked) this.chains.delete(id);
    });
    return task;
  }
  flush(id: string) {
    this.cancel(id);
    return this.serial(id, async () => {
      if (this.paused || this.blocked.has(id)) return false;
      const ok = await this.save(id);
      if (!ok) this.blocked.add(id);
      this.changed();
      return ok;
    });
  }
  resume(id: string) {
    this.blocked.delete(id);
    this.signatures.delete(id);
  }
  async settle() {
    const queued = [...this.tasks.keys()].map((id) => this.flush(id));
    const results = await Promise.all([...this.chains.values(), ...queued]);
    return results.every(Boolean);
  }
  dispose() {
    for (const id of this.tasks.keys()) this.cancel(id);
  }
}
