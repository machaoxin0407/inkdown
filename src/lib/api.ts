import { invoke, isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { DocumentData, Entry } from './types';
export const desktop = isTauri();
const filters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] }];
export const api = {
  relocatePosition: (oldPath: string, newPath: string) =>
    invoke<void>('relocate_position', { oldPath, newPath }),
  watch: (workspace: string, paths: string[], generation: number) =>
    invoke<void>('watch_paths', { workspace, paths, generation }),
  cancelSearch: () => invoke<void>('cancel_search'),
  search: (
    path: string,
    query: string,
    sensitive: boolean,
    overlays: { path: string; content: string }[],
  ) =>
    invoke<{
      hits: import('./workspace').SearchHit[];
      skipped: number;
      truncated: boolean;
      cancelled: boolean;
    }>('search_workspace', { path, query, sensitive, overlays }),
  create: (parent: string, name: string, directory: boolean) =>
    invoke<string>('create_entry', { parent, name, directory }),
  rename: (path: string, name: string, expected: string) =>
    invoke<string>('rename_document', { path, name, expected }),
  reveal: (path: string) => invoke<void>('reveal_document', { path }),
  attachment: (document: string, name: string, bytes: number[]) =>
    invoke<string>('write_attachment', { document, name, bytes }),
  importImage: (document: string, source: string) =>
    invoke<string>('import_attachment', { document, source }),
  chooseImage: () =>
    open({
      multiple: false,
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'] },
      ],
    }),
  drafts: () =>
    invoke<{ drafts: import('./local-state').Draft[]; warnings: string[] }>('list_drafts'),
  writeDraft: (draft: import('./local-state').Draft) => invoke<void>('write_draft', { draft }),
  deleteDraft: (id: string) => invoke<void>('delete_draft', { id }),
  positions: () => invoke<import('./local-state').Position[]>('read_positions'),
  writePosition: (position: import('./local-state').Position) =>
    invoke<void>('write_position', { position }),
  index: (path: string) =>
    invoke<{ paths: string[]; skipped: number; cancelled: boolean }>('index_workspace', { path }),
  cancelIndex: () => invoke<void>('cancel_index'),
  copy: (text: string) => navigator.clipboard.writeText(text),
  read: (path: string) => invoke<DocumentData>('read_document', { path }),
  workspace: (path: string) => invoke<string>('open_workspace', { path }),
  list: (path: string) => invoke<Entry[]>('list_directory', { path }),
  fingerprint: (path: string) => invoke<string | null>('document_fingerprint', { path }),
  save: (path: string, content: string, expected: string | null, bom: boolean, newline: string) =>
    invoke<DocumentData>('save_document', { path, content, expected, bom, newline }),
  image: (document: string, reference: string) =>
    invoke<string>('read_image', { document, reference }),
  pending: () => invoke<string[]>('take_open_paths'),
  chooseFiles: () => open({ multiple: true, filters, title: '打开 Markdown 文件' }),
  chooseFolder: () => open({ directory: true, title: '打开文件夹' }),
  chooseSave: (name: string) => save({ defaultPath: name, filters, title: '保存 Markdown 文件' }),
  choosePdf: (name: string) =>
    save({
      defaultPath: name,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      title: '导出为 PDF',
    }),
  exportPdf: (path: string, options?: import('./preferences').PdfPreferences) =>
    invoke<void>('export_pdf', { path, options }),
  external: async (url: string) => {
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error('不支持此链接类型');
    if (desktop) await openUrl(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  },
};
