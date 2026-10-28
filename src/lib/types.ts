export interface DocumentData {
  path: string;
  content: string;
  fingerprint: string;
  byteLength?: number;
  bom: boolean;
  newline: 'LF' | 'CRLF';
}
export interface Tab extends DocumentData {
  id: string;
  name: string;
  saved: string;
  scroll: number;
  edit: boolean;
  external: boolean;
  revision: number;
  bodyVersion?: number;
  pending?: boolean;
  livePreview?: boolean;
  previewSource?: string;
  position?: import('./local-state').Position;
}
export interface Entry {
  name: string;
  path: string;
  directory: boolean;
}
export interface Heading {
  line?: number;
  id: string;
  text: string;
  level: number;
}
export const basename = (path: string) => path.split(/[\\/]/).pop() || path;
export const pathKey = (path: string) => path.replace(/\\/g, '/').toLowerCase();
export const isMarkdown = (path: string) => /\.(md|markdown|mdown)$/i.test(path);
export function localReference(base: string, reference: string) {
  const clean = decodeURIComponent(reference.split('#')[0]);
  if (/^[a-z][a-z\d+.-]*:/i.test(clean) || clean.startsWith('//') || clean.startsWith('\\\\'))
    throw new Error('不支持此链接类型');
  if (/^[\\/]/.test(clean)) throw new Error('仅支持相对路径链接');
  return base.replace(/[^\\/]+$/, '') + clean;
}

export const sourceVersion = (tab: Tab) => tab.content === tab.saved && !tab.pending ? tab.fingerprint : `${tab.id}:${tab.bodyVersion || 0}`;
export const dirty = (tab: Tab) => !!tab.pending || tab.content !== tab.saved;

/** A disk read must never replace input that arrived while it was in flight. */
export function canApplyDocumentRead(snapshot: Tab, current: Tab | undefined) {
  return !!current && !current.pending && pathKey(current.path) === pathKey(snapshot.path) &&
    current.content === snapshot.content && current.saved === snapshot.saved &&
    current.fingerprint === snapshot.fingerprint && current.revision === snapshot.revision &&
    current.bodyVersion === snapshot.bodyVersion;
}
