import { writable } from 'svelte/store';
import { api, desktop } from './api';
import { pathKey, basename, isMarkdown } from './types';
export interface SearchHit {
  path: string;
  line: number;
  from: number;
  to: number;
  snippet: string;
}
export interface FileChanges {
  generation: number;
  paths: string[];
  failed: boolean;
}
export const indexState = writable({ paths: [] as string[], loading: false, message: '' });
let root = '',
  paths: string[] = [],
  request = 0,
  loaded = false;
export function setWorkspace(path: string) {
  if (pathKey(root) === pathKey(path)) return;
  root = path;
  request++;
  loaded = false;
  paths = [];
  indexState.set({ paths, loading: false, message: '' });
  if (desktop) void api.cancelIndex();
}
export async function refreshIndex(force = false) {
  if (!desktop || !root || (loaded && !force)) return;
  const token = ++request;
  indexState.set({ paths, loading: true, message: '' });
  try {
    const result = await api.index(root);
    if (token !== request) return;
    if (!result.cancelled) {
      paths = result.paths;
      loaded = true;
    }
    indexState.set({
      paths,
      loading: false,
      message: result.skipped ? `已跳过 ${result.skipped} 个无法访问的项目` : '',
    });
  } catch (e) {
    if (token === request) indexState.set({ paths, loading: false, message: String(e) });
  }
}
export async function updateIndex(changes: string[]) {
  if (!loaded) return;
  if (changes.some((p) => !isMarkdown(p) && !/\.[^\/]+$/.test(p))) {
    await refreshIndex(true);
    return;
  }
  const token = request;
  const next = new Map(paths.map((p) => [pathKey(p), p]));
  for (const path of changes) {
    if (!pathKey(path).startsWith(pathKey(root) + '/')) continue;
    try {
      if ((await api.fingerprint(path)) !== null) next.set(pathKey(path), path);
      else next.delete(pathKey(path));
    } catch {
      next.delete(pathKey(path));
    }
  }
  if (token !== request) return;
  paths = [...next.values()].sort((a, b) => basename(a).localeCompare(basename(b)));
  indexState.set({ paths, loading: false, message: '' });
}
