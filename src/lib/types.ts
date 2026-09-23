export interface DocumentData {
  path: string;
  content: string;
  fingerprint: string;
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
  position?: import('./local-state').Position;
}
export interface Entry {
  name: string;
  path: string;
  directory: boolean;
}
export interface Heading {
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
