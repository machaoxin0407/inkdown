<script context="module" lang="ts">
  function focusDialog(node: HTMLElement) {
    const previous = document.activeElement as HTMLElement;
    const buttons = () => [...node.querySelectorAll<HTMLButtonElement>('button')];
    buttons()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const all = buttons(),
        first = all[0],
        last = all[all.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', trap);
    return {
      destroy() {
        node.removeEventListener('keydown', trap);
        previous?.focus();
      },
    };
  }
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    BookOpen,
    PanelLeft,
    FolderOpen,
    FilePlus2,
    FileText,
    Search,
    Sun,
    Moon,
    Monitor,
    X,
    Plus,
    Minus,
    Save,
    Columns2,
    Clock3,
    List,
    Folder,
    ChevronDown,
    Check,
    ArrowUpRight,
    RefreshCw,
    Ellipsis,
    Feather,
    Keyboard,
  } from 'lucide-svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { listen } from '@tauri-apps/api/event';
  import Editor from './Editor.svelte';
  import NotebookPanel from './NotebookPanel.svelte';
  import { notebookApi, NoteAutosave, noteForPath, absolute, relativePath, normalizePath, type NotebookLibrary, type OperationOutcome, type LibraryItem } from './lib/notebook';
  import { liveEditors, documentStates, captureInsertion } from './lib/document-state';
  import Preview from './Preview.svelte';
  import Tree from './Tree.svelte';
  import Outline from './Outline.svelte';
  import ActionDialog from './ActionDialog.svelte';
  import SettingsPanel from './Settings.svelte';
  import { readingPreferences, pdfPreferences } from './lib/preferences';
  import { clearImageCache, clearRenderCaches } from './lib/render';
  import WorkspaceSearch from './WorkspaceSearch.svelte';
  import { ChangeCoordinator, setWorkspace, updateIndex, type FileChanges, type SearchHit } from './lib/workspace';
  import QuickOpen from './QuickOpen.svelte';
  import DraftRecovery from './DraftRecovery.svelte';
  import CompareDialog from './CompareDialog.svelte';
  import PdfPreview from './PdfPreview.svelte';
  import RenamePreview from './RenamePreview.svelte';
  import type { RenamePlan, RenameResult } from './lib/rename';
  import type { PreparedPdf } from './lib/pdf';
  import type { PdfPreferences } from './lib/preferences';
  import { NavigationHistory, type Visit } from './lib/navigation';
  import {
    Backups,
    positionOf,
    type Draft,
    type Position,
    type QuickItem,
  } from './lib/local-state';
  import { api, desktop } from './lib/api';
  import { canApplyDocumentRead } from './lib/types';
  import { flushDocuments, changeDocument, documentHistory } from './lib/document-state';
  import { normalizeZoom, MIN_ZOOM, MAX_ZOOM } from './lib/zoom';
  import type { Tab, Heading, Entry, DocumentData } from './lib/types';
  import { basename, pathKey, localReference, isMarkdown, sourceVersion, dirty } from './lib/types';
  import welcomeSource from '../examples/欢迎使用.md?raw';
  const welcome = welcomeSource
    .replace('![本地示例](./assets/landscape.svg)', '')
    .replace('继续阅读 [功能验证示例](./功能验证.md)。', '');
  type Settings = {
    theme: 'system' | 'light' | 'dark';
    sidebar: boolean;
    ratio: number;
    zoom: number;
    recent: string[];
    workspace: string;
    paths: string[];
    activePath: string;
  };
  const defaults: Settings = {
    theme: 'system',
    sidebar: true,
    ratio: 48,
    zoom: 100,
    recent: [],
    workspace: '',
    paths: [],
    activePath: '',
  };
  function settings(): Settings {
    try {
      const value = JSON.parse(localStorage.getItem('inkdown.settings') || '{}');
      return {
        ...defaults,
        ...value,
        theme: ['system', 'light', 'dark'].includes(value.theme) ? value.theme : 'system',
        ratio: Math.max(28, Math.min(72, Number(value.ratio) || 48)),
        zoom: normalizeZoom(value.zoom),
        recent: Array.isArray(value.recent)
          ? value.recent.filter((p: unknown) => typeof p === 'string').slice(0, 12)
          : [],
        paths: Array.isArray(value.paths)
          ? value.paths.filter((p: unknown) => typeof p === 'string')
          : [],
      };
    } catch {
      return defaults;
    }
  }
  const initial = settings();
  let notebookMode = localStorage.getItem('inkdown.mode') === 'notebooks';
  let library: NotebookLibrary | null = null;
  let notebookPanel: NotebookPanel;
  let savingNotes: Record<string, string> = {};
  let notebookMutation = false;
  let notebookInterfaceBusy = false;
  $: localStorage.setItem('inkdown.mode', notebookMode ? 'notebooks' : 'files');
  const autosave = new NoteAutosave(async (id) => {
    if (notebookMutation || library?.pending.length) return false;
    if (liveEditors.get(id)?.composing) { setTimeout(() => { autosave.resume(id); const t = tabs.find(t => t.id === id); if (t) autosave.track(t); }, 500); return true; }
    flushDocuments();
    const tab = tabs.find(t => t.id === id);
    if (!tab || !noteForPath(library, tab.path)) return true;
    if (tab.external) return false;
    if (!dirty(tab)) return true;
    savingNotes = { ...savingNotes, [id]: '保存中' };
    try {
      const document = await api.save(tab.path, tab.content, tab.fingerprint, tab.bom, tab.newline);
      patch(id, { fingerprint: document.fingerprint, saved: tab.content, external: false });
      const current = tabs.find(t => t.id === id);
      if (current && !dirty(current)) await backups.clear(id);
      savingNotes = { ...savingNotes, [id]: '已保存' };
      return true;
    } catch (e) {
      savingNotes = { ...savingNotes, [id]: '保存失败' };
      if (String(e).includes('CONFLICT')) patch(id, { external: true });
      fail(`笔记“${tab.name}”自动保存失败：${String(e)}。已保留编辑和草稿。`);
      return false;
    }
  });
  $: if (library && ready && !notebookMutation && !library.pending.length) for (const tab of tabs) if (noteForPath(library, tab.path)) autosave.track(tab);
  async function beforeNotebookOperation() {
    flushDocuments();
    if (!(await autosave.settle())) throw new Error('请先处理保存失败的笔记，再整理笔记库');
    for (const tab of tabs.filter(t => noteForPath(library,t.path))) {
      if (tab.external || (dirty(tab) && !(await saveTab(tab)))) throw new Error('笔记仍有未保存内容或外部冲突，请先处理');
    }
    notebookMutation = true; autosave.paused = true;
  }
  function releaseNotebookOperation() { notebookMutation = false; autosave.paused = !!library?.pending.length; if (!library?.pending.length && active?.edit) void tick().then(() => liveEditors.get(activeId)?.focus()); }
  async function afterNotebookOperation(result: OperationOutcome, action: string, removed: string[]) {
    if (!library) return;
    for (const mapping of result.mappings) {
      const oldPath = absolute(library.root,mapping.oldPath), newPath = absolute(library.root,mapping.newPath);
      await api.read(newPath);
      for (const tab of tabs.filter(t => pathKey(t.path) === pathKey(oldPath))) {
        await backups.clear(tab.id);
        patch(tab.id,{ path:newPath,name:basename(newPath),position:tab.position ? {...tab.position,path:newPath} : undefined });
      }
      await api.relocatePosition(oldPath,newPath);
      navigation.rename(oldPath,newPath,basename(newPath)); navigationTick++;
      recent = recent.map(p => pathKey(p) === pathKey(oldPath) ? newPath : p);
    }
    for (const document of result.documents) {
      const tab = tabs.find(t => pathKey(t.path) === pathKey(document.path));
      if (tab) { const content = changeDocument(tab.id,tab.content,{from:0,to:tab.content.length,insert:document.content}); patch(tab.id,{...document,content,saved:document.content,external:false,pending:false,previewSource:content}); await backups.clear(tab.id); }
    }
    if ((action === 'trash' || action === 'recover') && result.complete) {
      const ids = tabs.filter(t => removed.some(p => { const prefix = pathKey(absolute(library!.root,p)); return pathKey(t.path) === prefix || pathKey(t.path).startsWith(prefix+'/'); })).map(t => t.id);
      for (const id of ids) { autosave.cancel(id); await backups.clear(id); documentStates.delete(id); }
      tabs = tabs.filter(t => !ids.includes(t.id)); if (ids.includes(activeId)) activeId = tabs[0]?.id || '';
    }
    clearImageCache(); searchRevision++;
    if (result.errors.length) fail(result.errors.join('；'));
  }
  async function openNote(path: string, edit = false) { await openPath(path); if (edit) patch(activeId,{edit:true}); }
  function insertNoteLink(item: LibraryItem) {
    if (!active?.path || !library) return;
    const text = `[${item.name.replace(/([\[\]\\])/g,'\\$1')}](<${relativePath(active.path,absolute(library.root,item.path)).split('/').map(encodeURIComponent).join('/')}>)`;
    const range = liveEditors.get(active.id)?.state.selection.main;
    const content = changeDocument(active.id,active.content,{from:range?.from ?? active.content.length,to:range?.to ?? active.content.length,insert:text}); patch(active.id,{content,pending:false,edit:true});
  }
  let preferencesOpen = false;
  let reading = readingPreferences(),
    pdfOptions = pdfPreferences();
  try {
    const stored = JSON.parse(localStorage.getItem('inkdown.preferences') || '{}');
    reading = readingPreferences(stored.reading);
    pdfOptions = pdfPreferences(stored.pdf);
  } catch {}
  let expanded: Record<string, Entry[]> = {},
    opened: string[] = [],
    limits: Record<string, number> = {};
  let treeRoot = '';
  $: if (workspace !== treeRoot) {
    treeRoot = workspace;
    expanded = {};
    limits = {};
    try {
      opened = JSON.parse(localStorage.getItem('inkdown.tree:' + workspace) || '[]');
      if (!Array.isArray(opened)) opened = [];
    } catch {
      opened = [];
    }
  }
  function saveTree() {
    try {
      localStorage.setItem('inkdown.tree:' + workspace, JSON.stringify(opened));
    } catch {}
  }
  let treeRequest = 0;
  async function refreshTree(paths?: string[]) {
    const request = ++treeRequest, root = workspace;
    if (!root) return;
    const valid = () => root === workspace && request === treeRequest;
    const value = await api.list(root);
    if (!valid()) return;
    const initial = expanded;
    const updates = new Map<string, Entry[] | null>();
    for (const path of Object.keys(initial)) {
      if (paths && !paths.some((p) => pathKey(p).startsWith(pathKey(path) + '/') || pathKey(path).startsWith(pathKey(p) + '/'))) continue;
      try { updates.set(path, await api.list(path)); } catch { updates.set(path, null); }
      if (!valid()) return;
    }
    const next = { ...expanded };
    for (const [path, children] of updates) {
      if (expanded[path] !== initial[path]) continue;
      if (children) next[path] = children;
      else { delete next[path]; opened = opened.filter((p) => p !== path); }
    }
    entries = value; expanded = next; saveTree();
  }
  let actionForm: {
    title: string;
    note?: string;
    fields: {
      key: string;
      label: string;
      value: string;
      type?: string;
      min?: number;
      max?: number;
    }[];
    resolve: (value: Record<string, string> | null) => void;
  } | null = null;
  function inputForm(title: string, fields: NonNullable<typeof actionForm>['fields'], note = '') {
    return new Promise<Record<string, string> | null>((resolve) => {
      actionForm = { title, fields, note, resolve };
    });
  }
  function answerForm(value: Record<string, string> | null) {
    const current = actionForm;
    actionForm = null;
    current?.resolve(value);
  }
  let renamePreview: { plan: RenamePlan; result?: RenameResult; loading: boolean; renamedPath?: string; resolve: () => void } | null = null;
  async function renameWorkflow(oldPath: string, name: string) {
    flushDocuments();
    const { prepareRename } = await import('./lib/rename');
    const plan = await prepareRename(api, oldPath, name, workspace, tabs);
    await new Promise<void>((resolve) => renamePreview = { plan, loading: false, resolve });
  }
  function closeRename() { const state = renamePreview; if (state?.loading) return; renamePreview = null; state?.resolve(); }
  async function applySelectedReferences(selected: string[]) {
    const state = renamePreview;
    if (!state || state.loading) return;
    flushDocuments(); renamePreview = { ...state, loading: true };
    const { applyRename } = await import('./lib/rename');
    try {
      const result = await applyRename(api, state.plan, selected, tabs, {
        async renamed(path) {
          await backups.settle();
          try { await api.relocatePosition(state.plan.oldPath, path); }
          catch(e) { fail('已重命名，但位置记录迁移失败：' + String(e)); }
          const previous = backups.positions.get(pathKey(state.plan.oldPath));
          backups.positions.delete(pathKey(state.plan.oldPath));
          if(previous) backups.positions.set(pathKey(path), { ...previous, path });
          for(const tab of tabs) if(pathKey(tab.path) === pathKey(state.plan.oldPath)) { patch(tab.id, { path, name: basename(path) }); const updated = tabs.find((t) => t.id===tab.id); if(updated) rememberPosition(updated); }
          recent = recent.map((p) => pathKey(p) === pathKey(state.plan.oldPath) ? path : p);
          navigation.rename(state.plan.oldPath, path, basename(path)); navigationTick++;
        },
        buffer(proposal, path) {
          const tab = tabs.find((t) => pathKey(t.path)===pathKey(path));
          if(!tab) throw new Error('编辑文档已关闭，请重新扫描');
          const content = changeDocument(tab.id, tab.content, proposal.edits.map((edit) => ({ from: edit.from, to: edit.to, insert: edit.insert })));
          patch(tab.id, { content, pending: false, previewSource: content });
        },
        saved(document) {
          const tab = tabs.find((t) => pathKey(t.path)===pathKey(document.path));
          if(tab) {
            const content = changeDocument(tab.id, tab.content, { from:0, to:tab.content.length, insert:document.content });
            patch(tab.id, { ...document, content, saved:document.content, external:false, pending:false, previewSource:content });
          }
        },
      }, state.renamedPath);
      renamePreview = { ...state, result, renamedPath: result.renamed ? result.path : state.renamedPath, loading:false };
      void changes.enqueue([], true);
    } catch(e) {
      renamePreview = { ...state, loading:false, result: { renamed:!!state.renamedPath, path:state.renamedPath || state.plan.oldPath, files:[{ path:state.plan.oldPath, status:'failed', message:String(e) }] } };
    }
  }
  async function rescanReferences() {
    const state = renamePreview;
    if(!state || state.loading) return;
    flushDocuments(); renamePreview = { ...state, loading:true };
    try {
      const { prepareRename } = await import('./lib/rename');
      const paths = state.renamedPath ? state.result?.files.filter((f) => ['failed','conflict'].includes(f.status)).map((f) => f.path) : undefined;
      const plan = await prepareRename(api, state.plan.oldPath, state.plan.name, state.plan.workspace, tabs, paths);
      renamePreview = { ...state, plan, result:undefined, loading:false };
    } catch(e) { renamePreview = { ...state, loading:false }; fail(e); }
  }
  async function treeAction(action: string, entry: Entry) {
    if (action === 'reveal') {
      await api.reveal(entry.path);
      return;
    }
    if (action === 'rename') {
      const data = await inputForm('重命名文档', [{ key: 'name', label: '文件名', value: entry.name }], '下一步可预览并选择更新工作区中的文档引用。');
      if (!data) return;
      await renameWorkflow(entry.path, data.name);
    } else {
      const data = await inputForm(action === 'folder' ? '新建文件夹' : '新建文档', [
        { key: 'name', label: '名称', value: action === 'folder' ? '新建文件夹' : '未命名.md' },
      ]);
      if (!data) return;
      const path = await api.create(entry.path, data.name, action === 'folder');
      if (action !== 'folder') await openPath(path);
    }
    void changes.enqueue([], true);
  }
  async function insertContent(kind: string, file?: File, sourcePath?: string) {
    const id = activeId;
    if (!active?.edit) return;
    const chosen = editor?.selected() || '';
    if (kind === 'link') {
      const values = await inputForm('插入链接', [
        { key: 'text', label: '链接文字', value: chosen || '链接' },
        { key: 'url', label: '链接地址', value: 'https://' },
      ]);
      if (values && activeId === id)
        editor?.insert(
          '[' +
            values.text.replace(/([\[\]\\])/g, '\\$1') +
            '](<' +
            values.url.replace(/>/g, '%3E') +
            '>)',
        );
    } else if (kind === 'table') {
      const values = await inputForm('插入表格', [
        { key: 'rows', label: '正文行数', value: '3', type: 'number', min: 1, max: 50 },
        { key: 'cols', label: '列数', value: '3', type: 'number', min: 1, max: 20 },
      ]);
      if (!values || activeId !== id) return;
      const cols = Math.max(1, Math.min(20, Number(values.cols))),
        rows = Math.max(1, Math.min(50, Number(values.rows)));
      editor?.insert(
        '\n' +
          '| ' +
          Array.from({ length: cols }, (_, i) => '列 ' + (i + 1)).join(' | ') +
          ' |\n| ' +
          Array(cols).fill('---').join(' | ') +
          ' |\n' +
          ('| ' + Array(cols).fill(' ').join(' | ') + ' |\n').repeat(rows),
      );
    } else {
      flushDocuments();
      let tab = tabs.find((t) => t.id === id)!;
      const insertion = captureInsertion(id, tab.content.length);
      try {
      if (!tab.path && !(await saveTab(tab))) return;
      tab = tabs.find((t) => t.id === id)!;
      const note = noteForPath(library, tab.path);
      let reference: string;
      if (file) {
        if (file.size > 16 * 1024 * 1024) throw new Error('图片超过 16 MB');
        const bytes = [...new Uint8Array(await file.arrayBuffer())];
        reference = note && library ? await notebookApi.attachment(library.root,note.id,file.name || 'clipboard.png',bytes) : await api.attachment(tab.path,file.name || 'clipboard.png',bytes);
      } else {
        const source = sourcePath || await api.chooseImage();
        if (typeof source !== 'string') return;
        reference = note && library ? await notebookApi.attachment(library.root,note.id,basename(source),await api.imageBytes(source)) : await api.importImage(tab.path, source);
      }
      flushDocuments();
      const current = tabs.find(t => t.id === id);
      if (current) { const content = changeDocument(id,current.content,{...insertion.point,insert:'![图片](<' + reference.split('/').map(encodeURIComponent).join('/') + '>)'}); patch(id,{content,pending:false}); }
      } finally { insertion.release(); }
    }
  }
  let characterCount = 0, countRequest = 0;
  let countTimer: ReturnType<typeof setTimeout>, countWorker: Worker | undefined;
  function scheduleCount(source: string) {
    const id = ++countRequest;
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      countWorker ??= new Worker(new URL('./lib/count.worker.ts', import.meta.url), { type:'module' });
      countWorker.onmessage = ({ data }) => { if(data.id === countRequest) characterCount = data.count; };
      countWorker.postMessage({ id, source });
    }, 500);
  }
  $: if(active) scheduleCount(active.content);
  let zoom = initial.zoom;
  let theme = initial.theme,
    sidebar = initial.sidebar,
    ratio = initial.ratio;
  let systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  let tabs: Tab[] = [],
    activeId = '',
    recent = initial.recent,
    workspace = '';
  let entries: Entry[] = [],
    headings: Heading[] = [],
    sideMode: 'files' | 'outline' | 'search' = 'files';
  let busy = false,
    toast = '',
    error = '',
    dragging = false,
    menu = false,
    ready = false;
  let preview: Preview, editor: Editor, splitHost: HTMLDivElement;
  let searchRevision = 0;
  const changes = new ChangeCoordinator(async (batch) => {
    if (!changes.current(batch)) return;
    await checkExternal(batch.full ? undefined : batch.paths);
    if (!changes.current(batch)) return;
    if (batch.root) await refreshTree(batch.full ? undefined : batch.paths);
    if (!changes.current(batch)) return;
    await updateIndex(batch.paths, batch.full);
    if (!changes.current(batch)) return;
    searchRevision++;
    if (!notebookMutation && !notebookInterfaceBusy && library && (batch.full || batch.paths.some(p => pathKey(p).startsWith(pathKey(library!.root)+'/')))) await notebookPanel?.refresh();
    if (batch.paths.some((p) => /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(p))) {
      clearImageCache();
      preview?.refreshImages(batch.paths);
    }
  }, fail);
  $: { changes.setRoot(workspace); setWorkspace(workspace); }
  let treeVersion = 0,
    queuedOpen = false;
  let dialog: {
    title: string;
    text: string;
    choices: { label: string; value: string; primary?: boolean }[];
    resolve: (value: string) => void;
  } | null = null;
  let toastTimer: ReturnType<typeof setTimeout>;
  let active: Tab | undefined;
  const navigation = new NavigationHistory();
  let navigationTick = 0, historyActive = '', navigating = false;
  $: navState = { back: navigationTick >= 0 && navigation.canBack, forward: navigationTick >= 0 && navigation.canForward, closed: navigationTick >= 0 && navigation.closed.length };
  const visitOf = (tab: Tab): Visit => ({ id: tab.id, path: tab.path, name: tab.name, position: positionOf(tab) });
  $: if (active && active.id !== historyActive && !navigating) {
    historyActive = active.id;
    navigation.visit(visitOf(active)); navigationTick++;
  }
  function selectTab(id: string) { flushDocuments(); selection = undefined; if (active) navigation.update(visitOf(active)); activeId = id; }
  async function navigate(direction: number) {
    flushDocuments();
    selection = undefined;
    if (active) navigation.update(visitOf(active));
    const entry = navigation.move(direction);
    if (!entry) return;
    navigating = true;
    try {
      const tab = tabs.find((t) => t.id === entry.id);
      if (tab) activeId = tab.id;
      else if (entry.path) await openPath(entry.path);
      else throw new Error('这份未命名文档已关闭');
      patch(activeId, { position: { ...entry.position, path: tabs.find((t) => t.id === activeId)!.path }, edit: entry.position.edit });
      await tick(); preview?.restorePosition(entry.position); preview?.positionNow(entry.position);
      if (entry.position.edit) selection = { from: entry.position.cursor, to: entry.position.cursor, nonce: Date.now() };
    } catch (e) { navigation.move(-direction); notify(String(e)); }
    finally { navigating = false; historyActive = activeId; navigationTick++; }
  }
  async function reopenClosed() {
    const entry = navigation.closed.pop(); navigationTick++;
    if (!entry) return;
    try { await openPath(entry.path); patch(activeId, { position: entry.position, edit: entry.position.edit }); await tick(); preview?.positionNow(entry.position); if(entry.position.edit) selection = { from:entry.position.cursor, to:entry.position.cursor, nonce:Date.now() }; }
    catch (e) { navigation.closed.push(entry); navigationTick++; throw e; }
  }
  function navigateHeading(id: string) {
    if (!active) return;
    navigation.update(visitOf(active)); navigation.visit(visitOf(active)); preview?.jump(id);
    const heading = headings.find((h) => h.id === id);
    rememberPosition(active, { line: heading?.line || 0, atStart: false, atEnd: false });
    navigationTick++;
  }
  function navigateAnchor(name: string) {
    if (!active) return;
    navigation.update(visitOf(active)); navigation.visit(visitOf(active)); preview?.anchor(name);
    const heading = headings.find((h) => h.id === name || h.text.trim().replace(/\s+/g, '-').toLowerCase() === name.toLowerCase());
    rememberPosition(active, { line: heading?.line || 0, atStart: false, atEnd: false });
    navigationTick++;
  }
  let comparison: { left: string; right: string; name: string; fingerprint: string | null; resolve: (value: { choice: string; fingerprint: string | null }) => void } | null = null;
  async function compareVersions(tab: Tab) {
    let right = '', fingerprint: string | null = null;
    try { const disk = await api.read(tab.path); right = disk.content; fingerprint = disk.fingerprint; }
    catch (e) { if (await api.fingerprint(tab.path) !== null) throw e; }
    return new Promise<{ choice: string; fingerprint: string | null }>((resolve) => { comparison = { left: tab.content, right, name: tab.name, fingerprint, resolve }; });
  }
  function answerComparison(choice: string) { const value = comparison; comparison = null; value?.resolve({ choice, fingerprint: value.fingerprint }); }
  async function compareExternal(tab: Tab) {
    const result = await compareVersions(tab);
    if (result.choice === 'reload') await reloadTab(tab);
    if (result.choice === 'saveAs') await saveTab(tab, true);
    if (result.choice === 'overwrite') await saveTab(tab, false, { fingerprint: result.fingerprint });
  }
  function historyAction(direction: 'undo' | 'redo') {
    flushDocuments(); if (!active) return;
    const content = documentHistory(active.id, active.content, direction);
    patch(active.id, { content, previewSource: content });
  }
  let quickOpen = false,
    recoveryOpen = false,
    drafts: Draft[] = [];
  const backups = new Backups(api, (e) => fail('本机备份或位置记录失败：' + String(e)));
  $: if (ready && desktop) for (const tab of tabs) backups.track(tab);
  function rememberPosition(tab: Tab, change: Partial<Position> = {}) {
    tab.position = { ...positionOf(tab), ...change };
    if (desktop && ready) backups.remember(tab);
    navigation.update(visitOf(tab));
  }
  async function showRecovery() {
    quickOpen = false;
    menu = false;
    if (!desktop) {
      notify('请在桌面版中恢复草稿');
      return;
    }
    const result = await api.drafts();
    drafts = result.drafts.filter((d) => !tabs.some((t) => t.id === d.id));
    if (result.warnings.length) fail(result.warnings.join('；'));
    recoveryOpen = true;
  }
  async function restoreDrafts(ids: string[]) {
    for (const draft of drafts.filter((d) => ids.includes(d.id))) {
      let document: DocumentData | undefined;
      if (draft.path)
        try {
          document = await api.read(draft.path);
        } catch {}
      const existing = document && tabs.find((t) => pathKey(t.path) === pathKey(document!.path));
      if (existing && existing.content !== existing.saved) document = undefined;
      else if (existing) tabs = tabs.filter((t) => t.id !== existing.id);
      const path = document?.path || '';
      const tab: Tab = {
        id: draft.id,
        name: draft.name,
        path,
        content: draft.content,
        byteLength: new TextEncoder().encode(draft.content).length,
        livePreview: new TextEncoder().encode(draft.content).length >= 5 * 1024 * 1024 ? false : undefined,
        previewSource: draft.content,
        saved: document?.content === draft.content ? '\0' : (document?.content ?? '\0'),
        fingerprint: draft.fingerprint,
        bom: draft.bom,
        newline: draft.newline === 'CRLF' ? 'CRLF' : 'LF',
        scroll: 0,
        edit: draft.position.edit,
        external: !!document && document.fingerprint !== draft.fingerprint,
        revision: 0,
        position: { ...draft.position, path },
      };
      tabs = [...tabs, tab];
      activeId = tab.id;
    }
    drafts = drafts.filter((d) => !ids.includes(d.id));
    recoveryOpen = false;
    notify('草稿已恢复，原文件尚未修改');
  }
  async function discardDrafts(ids: string[]) {
    for (const id of ids) await backups.clear(id);
    drafts = drafts.filter((d) => !ids.includes(d.id));
    if (!drafts.length) recoveryOpen = false;
  }
  function showQuick() {
    if (busy || dialog || recoveryOpen) return;
    menu = false;
    quickOpen = true;
  }
  async function openQuick(item: QuickItem) {
    quickOpen = false;
    if (item.id) {
      selectTab(item.id);
      return;
    }
    await openPath(item.path);
  }

  $: active = tabs.find((t) => t.id === activeId);
  $: dark = theme === 'dark' || (theme === 'system' && systemDark);
  $: if (typeof document !== 'undefined')
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $: if (ready)
    persist(
      theme,
      sidebar,
      ratio,
      recent,
      workspace,
      tabs.map((t) => t.path).filter(Boolean),
      active?.path || '',
      zoom,
    );
  $: if (desktop && ready)
    getCurrentWindow()
      .setTitle(
        `${active ? `${active.content !== active.saved ? '● ' : ''}${active.name} — ` : ''}墨页 · Inkdown`,
      )
      .catch(() => {});
  function persist(
    theme: Settings['theme'],
    sidebar: boolean,
    ratio: number,
    recent: string[],
    workspace: string,
    paths: string[],
    activePath: string,
    zoom: number,
  ) {
    try {
      localStorage.setItem(
        'inkdown.settings',
        JSON.stringify({ theme, sidebar, ratio, zoom, recent, workspace, paths, activePath }),
      );
    } catch {
      /* Storage can be disabled by the host. */
    }
  }
  function notify(text: string) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 3200);
  }
  function fail(e: unknown) {
    error = String(e).replace(/^Error: /, '');
  }
  let exporting = false;
  let pdfPreview: { prepared: PreparedPdf; resolve: (options: PdfPreferences | null) => void } | null = null;
  function answerPdf(options: PdfPreferences | null) { const value = pdfPreview; pdfPreview = null; value?.resolve(options); }
  async function exportCurrentPdf() {
    flushDocuments();
    const current = tabs.find((t) => t.id === activeId);
    if (!current) return;
    if (!desktop) throw new Error('请在桌面版中导出 PDF');
    const { content, path, name } = current;
    exporting = true;
    const { preparePdf } = await import('./lib/pdf');
    let prepared: PreparedPdf | undefined;
    try {
      prepared = await preparePdf(content, path, pdfOptions);
      exporting = false;
      const options = await new Promise<PdfPreferences | null>((resolve) => pdfPreview = { prepared: prepared!, resolve });
      if (!options) return;
      const output = await api.choosePdf(name.replace(/\.(md|markdown|mdown)$/i, '') + '.pdf');
      if (!output) return;
      exporting = true;
      await prepared.export(/\.pdf$/i.test(output) ? output : output + '.pdf', options);
      notify('PDF 已导出');
    } finally { pdfPreview = null; prepared?.dispose(); exporting = false; }
  }
  async function run(action: () => Promise<unknown>) {
    flushDocuments();
    if (busy) return;
    busy = true;
    error = '';
    menu = false;
    try {
      await action();
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
      if (queuedOpen && ready) queueMicrotask(drainIncoming);
    }
  }
  async function drainIncoming() {
    queuedOpen = true;
    if (busy || !ready) return;
    queuedOpen = false;
    await run(async () => {
      for (const path of await api.pending()) await openPath(path);
    });
  }
  function requireDesktop() {
    if (!desktop) throw new Error('当前为网页预览。请运行桌面版以打开、保存本地文件。');
  }
  function choose(
    title: string,
    text: string,
    choices: { label: string; value: string; primary?: boolean }[],
  ) {
    return new Promise<string>((resolve) => {
      dialog = { title, text, choices, resolve };
    });
  }
  function answer(value: string) {
    const current = dialog;
    dialog = null;
    current?.resolve(value);
  }
  function newTab(content = '', name = '未命名.md', edit = true) {
    flushDocuments();
    const id = crypto.randomUUID();
    const byteLength = new TextEncoder().encode(content).length;
    tabs = [
      ...tabs,
      {
        id,
        path: '',
        name,
        content,
        byteLength,
        livePreview: byteLength >= 5 * 1024 * 1024 ? false : undefined,
        previewSource: content,
        saved: content,
        fingerprint: '',
        bom: false,
        newline: 'LF',
        scroll: 0,
        edit,
        external: false,
        revision: 0,
      },
    ];
    activeId = id;
    headings = [];
  }
  function patch(id: string, data: Partial<Tab>) {
    tabs = tabs.map((t) => {
      if (t.id !== id) return t;
      if (data.content !== undefined && data.content !== t.content) {
        data = { ...data, bodyVersion: (t.bodyVersion || 0) + 1 };
        searchRevision++;
      }
      if (data.path !== undefined || data.saved !== undefined) searchRevision++;
      return { ...t, ...data };
    });
  }
  function remember(path: string) {
    recent = [path, ...recent.filter((p) => pathKey(p) !== pathKey(path))].slice(0, 12);
  }
  async function openPath(path: string) {
    flushDocuments();
    const normalized = pathKey(normalizePath(path));
    if (library?.trash.some(t => t.items.some(i => pathKey(absolute(library!.root,i.path)) === normalized))) throw new Error('这篇笔记在回收站中，请先从笔记库回收站恢复');
    selection = undefined;
    const opened = tabs.find((t) => t.path && pathKey(t.path) === pathKey(path));
    if (opened) {
      activeId = opened.id;
      return;
    }
    const document = await api.read(path);
    const existing = tabs.find((t) => pathKey(t.path) === pathKey(document.path));
    if (existing) {
      activeId = existing.id;
      return;
    }
    const id = crypto.randomUUID();
    tabs = [
      ...tabs,
      {
        ...document,
        id,
        name: basename(document.path),
        saved: document.content,
        scroll: 0,
        position: backups.positions.get(pathKey(document.path)),
        edit: backups.positions.get(pathKey(document.path))?.edit ?? false,
        external: false,
        revision: 0,
        livePreview: (document.byteLength || 0) >= 5 * 1024 * 1024 ? false : undefined,
        previewSource: document.content,
      },
    ];
    activeId = id;
    headings = [];
    remember(document.path);
  }
  async function openFiles() {
    requireDesktop();
    const selected = await api.chooseFiles();
    if (selected)
      for (const path of Array.isArray(selected) ? selected : [selected]) await openPath(path);
  }
  async function confirmTab(tab: Tab): Promise<boolean> {
    flushDocuments();
    tab = tabs.find((t) => t.id === tab.id) || tab;
    if (noteForPath(library, tab.path) && !tab.external && dirty(tab) && !library?.pending.length) {
      if (await saveTab(tab)) return !dirty(tabs.find(t => t.id === tab.id) || tab) || confirmTab(tabs.find(t => t.id === tab.id)!);
    }
    if (tab.content === tab.saved) return true;
    const choice = await choose('保存这份修改？', `“${tab.name}”有尚未保存的内容。`, [
      { label: '取消', value: 'cancel' },
      { label: '放弃修改', value: 'discard' },
      { label: '保存', value: 'save', primary: true },
    ]);
    if (choice === 'discard') return true;
    if (choice !== 'save' || !(await saveTab(tab))) return false;
    const current = tabs.find((t) => t.id === tab.id);
    return !current || current.content === current.saved || (await confirmTab(current));
  }
  async function closeTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab || !(await confirmTab(tab))) return;
    autosave.cancel(id);
    rememberPosition(tab);
    navigation.close(visitOf(tab)); navigationTick++;
    if (desktop) await backups.clear(tab.id);
    const index = tabs.indexOf(tab);
    tabs = tabs.filter((t) => t.id !== id);
    if (activeId === id) activeId = tabs[Math.min(index, tabs.length - 1)]?.id || '';
    if (!tabs.length) headings = [];
    await tick();
    const { forgetEditor } = await import('./lib/editor');
    forgetEditor(id);
    clearRenderCaches();
  }
  async function switchWorkspace(path: string) {
    const root = await api.workspace(path);
    const listed = await api.list(root);
    for (const tab of tabs) if (!(await confirmTab(tab))) return;
    for (const tab of tabs) {
      rememberPosition(tab);
      if (desktop) await backups.clear(tab.id);
    }
    if (desktop) await api.cancelIndex();
    quickOpen = false;
    navigation.clear(); navigationTick++; historyActive = '';
    workspace = root;
    entries = listed;
    const closedIds = tabs.map((tab) => tab.id);
    tabs = [];
    await tick();
    const { forgetEditor } = await import('./lib/editor');
    closedIds.forEach(forgetEditor);
    clearRenderCaches();
    activeId = '';
    headings = [];
    treeVersion++;
    sideMode = 'files';
    sidebar = true;
  }
  async function openFolder() {
    requireDesktop();
    const selected = await api.chooseFolder();
    if (typeof selected === 'string') await switchWorkspace(selected);
  }
  async function reloadTab(tab: Tab, confirmed = false) {
    if (!confirmed && !(await confirmTab(tab))) return;
    flushDocuments();
    tab = tabs.find((t) => t.id === tab.id) || tab;
    const document = await api.read(tab.path);
    flushDocuments();
    if(!canApplyDocumentRead(tab, tabs.find((t) => t.id === tab.id))) {
      patch(tab.id, { external:true });
      throw new Error('读取期间编辑内容已变化，已保留当前修改，请重新处理冲突');
    }
    patch(tab.id, {
      ...document,
      saved: document.content,
      external: false,
      revision: tab.revision + 1,
    });
    autosave.resume(tab.id);
  }
  async function saveTab(tab: Tab, saveAs = false, overwrite?: { fingerprint: string | null }): Promise<boolean> {
    autosave.cancel(tab.id);
    return autosave.serial(tab.id,async () => {
      if (noteForPath(library,tab.path) && library?.pending.length) throw new Error('请先恢复笔记库未完成的操作');
      const ok = await saveTabNow(tabs.find(t => t.id === tab.id) || tab,saveAs,overwrite);
      if (ok) { autosave.resume(tab.id); savingNotes = {...savingNotes,[tab.id]:'已保存'}; }
      return ok;
    });
  }
  async function saveTabNow(tab: Tab, saveAs = false, overwrite?: { fingerprint: string | null }): Promise<boolean> {
    flushDocuments();
    tab = tabs.find((t) => t.id === tab.id) || tab;
    requireDesktop();
    let path = tab.path;
    if (saveAs || !path) {
      const selected = await api.chooseSave(path || (workspace ? workspace + '/' : '') + tab.name);
      if (!selected) return false;
      path = isMarkdown(selected) ? selected : selected + '.md';
    }
    const duplicate = tabs.find(
      (t) => t.id !== tab.id && t.path && pathKey(t.path) === pathKey(path),
    );
    if (duplicate) throw new Error('目标文件已在另一个标签中打开，请先关闭该标签。');
    let expected: string | null =
      overwrite ? overwrite.fingerprint : pathKey(path) === pathKey(tab.path) ? tab.fingerprint : await api.fingerprint(path);
    if (pathKey(path) !== pathKey(tab.path) && expected !== null) {
      const overwrite = await choose(
        '替换已有文件？',
        `“${basename(path)}”已存在。替换后将写入当前内容。`,
        [
          { label: '取消', value: 'cancel' },
          { label: '替换', value: 'replace', primary: true },
        ],
      );
      if (overwrite !== 'replace') return false;
    }
    for (;;) {
      try {
        const document = await api.save(path, tab.content, expected, tab.bom, tab.newline);
        // An edit made while I/O was in flight remains dirty.
        const current = tabs.find((t) => t.id === tab.id);
        patch(tab.id, {
          path: document.path,
          name: basename(document.path),
          fingerprint: document.fingerprint,
          bom: document.bom,
          newline: document.newline,
          saved: tab.content,
          content: current?.content ?? tab.content,
          external: false,
        });
        const savedTab = tabs.find((t) => t.id === tab.id);
        if (savedTab) rememberPosition(savedTab);
        if (savedTab?.content === savedTab?.saved) await backups.clear(tab.id);
        remember(document.path);
        void changes.enqueue([document.path]);
        notify('已保存到本地');
        return true;
      } catch (e) {
        if (String(e) !== 'CONFLICT') throw e;
        const current = await api.fingerprint(path);
        let comparedFingerprint = current;
        let choice = await choose(
          '文件在外部发生了变化',
          `“${basename(path)}”${current === null ? '已被移动或删除' : '有更新的磁盘版本'}。请选择如何保留你的内容。`,
          [
            { label: '取消', value: 'cancel' },
            { label: '比较版本', value: 'compare' },
            { label: '重新加载', value: 'reload' },
            { label: '另存为', value: 'saveAs' },
            { label: '覆盖磁盘版本', value: 'overwrite', primary: true },
          ],
        );
        if (choice === 'compare') { const result = await compareVersions({ ...tab, path }); choice = result.choice; comparedFingerprint = result.fingerprint; }
        if (choice === 'reload') {
          await reloadTab({ ...tab, path }, true);
          return true;
        }
        if (choice === 'saveAs') return saveTabNow(tab, true);
        if (choice !== 'overwrite') return false;
        expected = comparedFingerprint;
      }
    }
  }
  let externalTimer: ReturnType<typeof setTimeout>;
  let checkingExternal = false,
    watchFailed = true,
    watchGeneration = 0;
  let selection: { from: number; to: number; nonce: number } | undefined;
  let watchSignature = '';
  let watchConnecting = false, retryAttempt = 0, retryAt = 0;
  $: if (ready && desktop)
    configureWatch(
      workspace,
      tabs
        .map((t) => t.path)
        .filter(Boolean)
        .join('\n'),
      library?.root || '',
    );
  async function configureWatch(root: string, list: string, notebookRoot = library?.root || '') {
    const signature = root + '\0' + list + '\0' + notebookRoot;
    if (signature === watchSignature && (!watchFailed || Date.now() < retryAt)) return;
    if (watchConnecting) return;
    watchConnecting = true;
    watchSignature = signature;
    const generation = ++watchGeneration;
    setWorkspace(root);
    try {
      await api.watch(root, list ? list.split('\n') : [], generation, notebookRoot ? [notebookRoot] : []);
      if (generation === watchGeneration && root === workspace && list === tabs.map((t) => t.path).filter(Boolean).join('\n')) {
        if (watchFailed) await changes.enqueue([], true, true);
        if (retryAttempt) { if(error.startsWith('文件监听')) error = ''; notify('文件监听已恢复'); }
        watchFailed = false;
        retryAttempt = 0;
        retryAt = 0;
      }
    } catch (e) {
      if (generation === watchGeneration) {
        watchFailed = true;
        retryAt = Date.now() + [10000, 20000, 40000, 60000][Math.min(retryAttempt++, 3)];
        fail('文件监听不可用，已改为定时检查：' + String(e));
      }
    } finally {
      watchConnecting = false;
      const latest = tabs.map((t) => t.path).filter(Boolean).join('\n');
      if (root !== workspace || list !== latest || notebookRoot !== (library?.root || '')) void configureWatch(workspace, latest);
    }
  }
  async function checkExternal(changed?: string[]) {
    if (notebookMutation || library?.pending.length) return;
    if (!desktop) return;
    if (busy || dialog || checkingExternal) {
      clearTimeout(externalTimer);
      externalTimer = setTimeout(() => checkExternal(), 400);
      return;
    }
    checkingExternal = true;
    try {
      for (const tab of tabs.filter(
        (t) => t.path && (!changed || changed.some((p) => pathKey(p) === pathKey(t.path))),
      )) {
        try {
          const fingerprint = await api.fingerprint(tab.path);
          const latest = tabs.find((t) => t.id === tab.id);
          if (!latest || latest.fingerprint !== tab.fingerprint || latest.path !== tab.path)
            continue;
          if (fingerprint === tab.fingerprint) {
            if (latest.external) patch(tab.id, { external: false });
            continue;
          }
          if (dirty(latest) || fingerprint === null) {
            patch(tab.id, { external: true });
            continue;
          }
          const document = await api.read(tab.path);
          const current = tabs.find((t) => t.id === tab.id);
          if (!current) continue;
          if (!canApplyDocumentRead(tab, current)) {
            patch(tab.id, { external: true });
            continue;
          }
          const { forgetEditor } = await import('./lib/editor');
          if(!canApplyDocumentRead(tab, tabs.find((t) => t.id === tab.id))) { patch(tab.id, { external:true }); continue; }
          forgetEditor(tab.id);
          if (activeId === tab.id) preview?.restorePosition(positionOf(current));
          patch(tab.id, {
            ...document,
            saved: document.content,
            external: false,
            revision: current.revision + 1,
          });
        } catch {
          patch(tab.id, { external: true });
        }
      }
    } finally {
      checkingExternal = false;
    }
  }
  async function openSearchHit(hit: SearchHit) {
    flushDocuments();
    if(active) navigation.update(visitOf(active));
    navigating = true;
    try {
      await openPath(hit.path);
      let tab = tabs.find((t) => t.id === activeId)!;
      let selected: SearchHit | undefined = hit;
      const diskChanged = !dirty(tab) && await api.fingerprint(tab.path) !== tab.fingerprint;
      if (diskChanged) { await reloadTab(tab, true); tab = tabs.find((t) => t.id === activeId)!; }
      if (sourceVersion(tab) !== hit.sourceVersion || diskChanged) {
        const matches = await api.searchDocument(tab.path, hit.query, hit.sensitive,
          { path: tab.path, content: tab.content, sourceVersion: sourceVersion(tab) });
        selected = matches.sort((a,b) => Math.abs(a.from-hit.from)-Math.abs(b.from-hit.from) || a.from-b.from)[0];
        searchRevision++;
        if (!selected) notify('匹配已变化，已刷新搜索');
      }
      const from = selected?.from ?? tab.content.split('\n').slice(0, Math.max(0, hit.line-1)).join('\n').length;
      const line = tab.content.slice(0,from).split('\n').length-1;
      patch(activeId, { edit: true });
      const target = tabs.find((t) => t.id === activeId)!;
      navigation.visit(visitOf(target));
      rememberPosition(target, { cursor:from, editorLine:line, line, atStart:from===0, atEnd:false });
      selection = { from, to: selected?.to ?? from, nonce: Date.now() };
    } finally { navigating = false; historyActive = activeId; navigationTick++; }
  }
  async function openLink(href: string) {
    if (/^(https?:|mailto:)/i.test(href)) { await api.external(href); return; }
    if (!active?.path) throw new Error('请先保存文档，或从本地打开文档，再访问相对路径链接。');
    navigation.update(visitOf(active));
    const path = localReference(active.path, href);
    if (!isMarkdown(path)) throw new Error('仅支持打开 Markdown 文档链接');
    navigating = true;
    try {
      await openPath(path);
      const hash = href.split('#')[1];
      if (hash) {
        await tick(); const name = decodeURIComponent(hash); preview?.anchor(name);
        const target = tabs.find((t) => t.id === activeId)!;
        const heading = headings.find((h) => h.id === name || h.text.trim().replace(/\s+/g,'-').toLowerCase() === name.toLowerCase());
        rememberPosition(target, { line:heading?.line || 0, atStart:false, atEnd:false });
      }
      const target = tabs.find((t) => t.id === activeId); if(target) navigation.visit(visitOf(target));
    } finally { navigating = false; historyActive = activeId; navigationTick++; }
  }
  function toggleEdit() {
    flushDocuments();
    if (active) {
      patch(active.id, { edit: !active.edit });
      const tab = tabs.find((t) => t.id === active!.id);
      if (tab) rememberPosition(tab);
    }
  }
  function find() {
    if (active?.edit) editor?.find();
    else preview?.find();
  }
  function cycleTheme() {
    theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  }
  function shortcuts(event: KeyboardEvent) {
    if (quickOpen || recoveryOpen || actionForm || preferencesOpen || comparison || pdfPreview || renamePreview) return;
    if (active && !active.edit && event.ctrlKey && ['z','y'].includes(event.key.toLowerCase()) && !dialog && !busy) {
      event.preventDefault();
      const direction = event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo';
      const content = documentHistory(active.id, active.content, direction);
      patch(active.id, { content, previewSource: content });
      return;
    }

    if (event.altKey && ['ArrowLeft','ArrowRight'].includes(event.key) && !busy && !dialog) {
      event.preventDefault(); void run(() => navigate(event.key === 'ArrowLeft' ? -1 : 1)); return;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't' && !busy && !dialog) {
      event.preventDefault(); void run(reopenClosed); return;
    }
    if (event.key === 'Escape') {
      menu = false;
      if (dialog) answer('cancel');
      return;
    }
    if (!event.ctrlKey || event.altKey || dialog || busy) return;
    const key = event.key.toLowerCase();
    if (['+', '=', '-', '_', '0'].includes(key)) {
      event.preventDefault();
      zoom = key === '0' ? 100 : normalizeZoom(zoom + (key === '-' || key === '_' ? -10 : 10));
      return;
    }
    if (key === 'p' && !event.shiftKey) {
      event.preventDefault();
      showQuick();
      return;
    }
    if (key === 'p' && event.shiftKey) {
      event.preventDefault();
      run(exportCurrentPdf);
      return;
    }
    if (!['o', 's', 'n', 'w', 'e', 'f', 'b'].includes(key)) return;
    event.preventDefault();
    if (key === 'o') run(event.shiftKey ? openFolder : openFiles);
    if (key === 's' && active) run(() => saveTab(active!, event.shiftKey));
    if (key === 'n') { if (notebookMode) notebookPanel?.newNote(); else newTab(); }
    if (key === 'w' && active) run(() => closeTab(active!.id));
    if (key === 'e') toggleEdit();
    if (key === 'f') {
      if (event.shiftKey) {
        sidebar = true;
        sideMode = 'search';
        tick().then(() => document.getElementById('workspace-query')?.focus());
      } else find();
    }
    if (key === 'b') { if (notebookMode) notebookPanel?.toggleTree(); else sidebar = !sidebar; }
  }
  function resize(event: PointerEvent) {
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const rect = splitHost.getBoundingClientRect();
      ratio = Math.max(28, Math.min(72, ((e.clientX - rect.left) / rect.width) * 100));
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }
  onMount(() => {
    const cleanup: (() => void)[] = [];
    let lastWheel = 0;
    const wheelZoom = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (
        busy ||
        dialog ||
        !event.deltaY ||
        !(event.target instanceof Element) ||
        !event.target.closest('.preview-scroll, .editor-host')
      )
        return;
      const now = performance.now();
      if (now - lastWheel < 80) return;
      lastWheel = now;
      zoom = normalizeZoom(zoom + (event.deltaY < 0 ? 10 : -10));
    };
    window.addEventListener('wheel', wheelZoom, { passive: false, capture: true });
    cleanup.push(() => window.removeEventListener('wheel', wheelZoom, true));
    let disposed = false;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => (systemDark = media.matches);
    media.addEventListener('change', change);
    cleanup.push(() => media.removeEventListener('change', change));
    const workspaceShortcut = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === 'f' &&
        !dialog &&
        !actionForm &&
        !preferencesOpen &&
        !quickOpen &&
        !recoveryOpen
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        sidebar = true;
        sideMode = 'search';
        tick().then(() => document.getElementById('workspace-query')?.focus());
      }
    };
    window.addEventListener('keydown', workspaceShortcut, true);
    cleanup.push(() => window.removeEventListener('keydown', workspaceShortcut, true));
    const poll = setInterval(() => {
      if (watchFailed) {
        void changes.enqueue([], true, true);
        if (!watchConnecting && Date.now() >= retryAt) void configureWatch(workspace, tabs.map((t) => t.path).filter(Boolean).join('\n'));
      }
    }, 10000);
    cleanup.push(() => { autosave.dispose(); clearInterval(poll); changes.dispose(); clearTimeout(externalTimer); clearTimeout(countTimer); countWorker?.terminate(); });
    (async () => {
      if (desktop) {
        const addCleanup = (fn: () => void) => (disposed ? fn() : cleanup.push(fn));
        addCleanup(
          await getCurrentWindow().onDragDropEvent(({ payload }) => {
            dragging = payload.type === 'over' || payload.type === 'enter';
            if (payload.type === 'drop')
              run(async () => {
                for (const path of payload.paths)
                  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(path) && active?.edit) await insertContent('image',undefined,path);
                  else if (isMarkdown(path)) await openPath(path);
                  else await switchWorkspace(path);
              });
          }),
        );
        addCleanup(await listen('open-paths', drainIncoming));
        addCleanup(
          await listen<FileChanges>('workspace-changed', ({ payload }) => {
            if (payload.generation !== watchGeneration) return;
            if (payload.failed) {
              watchFailed = true;
              fail('文件监听中断，已改为定时检查');
            }
            if (payload.failed) retryAt = Date.now() + 10000;
            void changes.enqueue(payload.paths, payload.structural || payload.failed);
          }),
        );
        addCleanup(
          await getCurrentWindow().onCloseRequested(async (event) => {
            event.preventDefault();
            if (busy || dialog || recoveryOpen || notebookInterfaceBusy || notebookMutation) return;
            await run(async () => {
              for (const tab of tabs) if (!(await confirmTab(tab))) return;
              persist(
                theme,
                sidebar,
                ratio,
                recent,
                workspace,
                tabs.map((t) => t.path).filter(Boolean),
                active?.path || '',
                zoom,
              );
              for (const tab of tabs) {
                rememberPosition(tab);
                await backups.clear(tab.id);
              }
              await backups.settle();
              await getCurrentWindow().destroy();
            });
          }),
        );
        try {
          for (const position of await api.positions())
            backups.positions.set(pathKey(position.path), position);
        } catch (e) {
          fail('读取位置记录失败：' + String(e));
        }
        const incoming = await api.pending();
        const savedLibrary = localStorage.getItem('inkdown.notebooks.root');
        if (savedLibrary) try { library = await notebookApi.open(savedLibrary); autosave.paused = !!library.pending.length; } catch (e) { fail('笔记库打开失败：'+String(e)); }
        if (initial.workspace)
          try {
            workspace = await api.workspace(initial.workspace);
            entries = await api.list(workspace);
          } catch {
            workspace = '';
          }
        for (const path of incoming.length ? incoming : initial.paths) {
          try {
            await openPath(path);
          } catch (e) {
            fail(e);
          }
        }
        if (!incoming.length) {
          const restored = tabs.find((t) => pathKey(t.path) === pathKey(initial.activePath));
          if (restored) activeId = restored.id;
        }
      }
      if (!tabs.length && !workspace) newTab(welcome, '欢迎使用.md', false);
      ready = true;
      if (desktop) {
        const result = await api.drafts();
        drafts = result.drafts;
        if (result.warnings.length) fail(result.warnings.join('；'));
        recoveryOpen = drafts.length > 0;
      }
      if (queuedOpen) await drainIncoming();
    })().catch(fail);
    return () => {
      disposed = true;
      cleanup.forEach((fn) => fn());
      clearTimeout(toastTimer);
      clearTimeout(externalTimer);
    };
  });
</script>

{#if renamePreview}<RenamePreview plan={renamePreview.plan} result={renamePreview.result} loading={renamePreview.loading} onapply={applySelectedReferences} onrescan={rescanReferences} onclose={closeRename} />{/if}
{#if pdfPreview}<PdfPreview prepared={pdfPreview.prepared} initial={pdfOptions} onchoose={answerPdf} />{/if}
{#if comparison}<CompareDialog left={comparison.left} right={comparison.right} name={comparison.name} onchoose={answerComparison} />{/if}
{#if preferencesOpen}<SettingsPanel
    {reading}
    pdf={pdfOptions}
    onclose={() => (preferencesOpen = false)}
    onsave={(r, p) => {
      reading = r;
      pdfOptions = p;
      try {
        localStorage.setItem('inkdown.preferences', JSON.stringify({ reading: r, pdf: p }));
      } catch (e) {
        fail('设置已应用，但无法持久化：' + String(e));
      }
      preferencesOpen = false;
    }}
  />{/if}
{#if actionForm}<ActionDialog
    title={actionForm.title}
    note={actionForm.note || ''}
    fields={actionForm.fields}
    onsubmit={answerForm}
    onclose={() => answerForm(null)}
  />{/if}
{#if quickOpen}<QuickOpen
    {workspace}
    items={[
      ...tabs.map((t) => ({ id: t.id, name: t.name, path: t.path })),
      ...recent.map((path) => ({ name: basename(path), path })),
    ]}
    onopen={(item) => run(() => openQuick(item))}
    onclose={() => (quickOpen = false)}
  />{/if}
{#if recoveryOpen}<DraftRecovery
    {drafts}
    {busy}
    onrestore={(ids) => run(() => restoreDrafts(ids))}
    ondiscard={(ids) => run(() => discardDrafts(ids))}
    onclose={() => (recoveryOpen = false)}
  />{/if}
<svelte:window on:keydown={shortcuts} on:focus={() => checkExternal()} />
{#if exporting}<div class="pdf-progress" role="status" aria-live="polite">
    正在排版并导出 PDF，请稍候…
  </div>{/if}
<div class="app-shell" class:notebook-mode={notebookMode} class:sidebar-hidden={!sidebar && !notebookMode} inert={!!dialog || !!comparison || !!pdfPreview || !!renamePreview}>
  {#if !notebookMode}
  <aside class="sidebar" aria-label="侧边栏">
    <div class="brand">
      <span class="brand-icon"><Feather size={22} strokeWidth={1.6} /></span><strong
        >墨页<span>INKDOWN</span></strong
      ><span class="version">v0.4</span>
    </div>
    <div class="side-actions">
      <button class="notebook-entry" on:click={() => notebookMode = true}><BookOpen size={17}/>笔记本</button>
      <button class="open-folder" disabled={busy} on:click={() => run(openFolder)}
        ><FolderOpen size={17} />打开文件夹<kbd>⌃ O</kbd></button
      >
      <div class="side-quick">
        <button disabled={busy} on:click={() => run(openFiles)}
          ><FileText size={15} />打开文件</button
        ><button disabled={busy} on:click={() => newTab()}><Plus size={16} />新建</button>
      </div>
    </div>
    <div class="side-switch" role="group" aria-label="侧边栏内容">
      <button class:chosen={sideMode === 'files'} on:click={() => (sideMode = 'files')}
        ><Folder size={14} />文件</button
      ><button class:chosen={sideMode === 'outline'} on:click={() => (sideMode = 'outline')}
        ><List size={15} />大纲</button
      ><button class:chosen={sideMode === 'search'} on:click={() => (sideMode = 'search')}
        ><Search size={14} />搜索</button
      >
    </div>
    {#if workspace && sideMode === 'files'}<div class="tree-root-actions">
        <button
          disabled={busy}
          on:click={() =>
            run(() =>
              treeAction('new', { path: workspace, name: basename(workspace), directory: true }),
            )}>新建文档</button
        ><button
          disabled={busy}
          on:click={() =>
            run(() =>
              treeAction('folder', { path: workspace, name: basename(workspace), directory: true }),
            )}>新建文件夹</button
        >
      </div>{/if}
    <div class="side-content">
      {#if sideMode === 'files'}
        <div class="section-label">
          <span>{workspace ? basename(workspace) : '工作空间'}</span>{#if workspace}<button
              title="刷新文件树"
              aria-label="刷新文件树"
              disabled={busy}
              on:click={() =>
                run(async () => {
                  await changes.enqueue([], true, true);
                })}><RefreshCw size={13} /></button
            >{/if}
        </div>
        {#if workspace}<Tree
            {entries}
            bind:expanded
            bind:opened
            bind:limits
            directory={workspace}
            onstate={saveTree}
            onaction={(action, entry) => run(() => treeAction(action, entry))}
            activePath={active?.path || ''}
            onopen={(path) => run(() => openPath(path))}
            onerror={fail}
          />{#if !entries.length}<p class="side-hint">此文件夹中还没有 Markdown 文档。</p>{/if}
        {:else}<div class="workspace-empty">
            <FolderOpen size={28} strokeWidth={1.2} />
            <p>把文档放在一起</p>
            <span>打开一个文件夹，<br />让想法井然有序。</span>
          </div>{/if}
        {#if tabs.some((t) => !t.path)}<div class="section-label">当前文档</div>
          {#each tabs.filter((t) => !t.path) as tab}<button
              class="tree-row"
              class:selected={activeId === tab.id}
              on:click={() => (activeId = tab.id)}
              ><FileText size={15} /><span class="truncate">{tab.name}</span></button
            >{/each}{/if}
        {#if recent.length}<div class="section-label recent-label">
            <span>最近打开</span><Clock3 size={13} />
          </div>
          {#each recent as path}<button
              class="tree-row recent-row"
              title={path}
              disabled={busy}
              on:click={() => run(() => openPath(path))}
              ><FileText size={14} /><span class="truncate">{basename(path)}</span></button
            >{/each}{/if}
      {:else if sideMode === 'search'}<WorkspaceSearch revision={searchRevision} beforeSearch={() => editor?.flush()}
          {workspace}
          {tabs}
          onopen={(hit) => run(() => openSearchHit(hit))}
        />
      {:else}<Outline
          {headings}
          line={active?.position?.line || 0}
          onjump={navigateHeading}
        />{/if}
    </div>
    <div class="side-footer">
      <span><span class="status-dot"></span>本地存储 · 离线可用</span><button
        aria-label="切换主题"
        title={`主题：${theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'}`}
        on:click={cycleTheme}
        >{#if theme === 'system'}<Monitor size={16} />{:else if theme === 'light'}<Sun
            size={16}
          />{:else}<Moon size={16} />{/if}</button
      >
    </div>
  </aside>
  {:else}
    <NotebookPanel bind:this={notebookPanel} bind:library bind:working={notebookInterfaceBusy} {tabs} activePath={active?.path || ''} revision={searchRevision}
      onopen={openNote} onhit={openSearchHit} onbefore={beforeNotebookOperation} onafter={afterNotebookOperation}
      onrelease={releaseNotebookOperation} onlink={insertNoteLink} onfiles={() => notebookMode = false} onerror={fail}/>
  {/if}
  <main class="main-panel" inert={notebookInterfaceBusy || notebookMutation || !!library?.pending.length}>
    <header class="toolbar">
      <div class="toolbar-left">
        <button class="icon-button" title={notebookMode ? '文件' : '笔记本'} aria-label={notebookMode ? '切换到文件' : '切换到笔记本'} on:click={() => notebookMode = !notebookMode}><BookOpen size={17}/></button>
        <button
          class="icon-button"
          title="侧边栏 Ctrl+B"
          aria-label="切换侧边栏"
          on:click={() => notebookMode ? notebookPanel?.toggleTree() : (sidebar = !sidebar)}><PanelLeft size={18} /></button
        ><button class="icon-button" aria-label="后退" title="后退 Alt+←" disabled={!navState.back || busy} on:click={() => run(() => navigate(-1))}>←</button
        ><button class="icon-button" aria-label="前进" title="前进 Alt+→" disabled={!navState.forward || busy} on:click={() => run(() => navigate(1))}>→</button
        ><span class="toolbar-divider"></span><span class="breadcrumb"
          ><span>{workspace ? basename(workspace) : '我的文档'}</span><span class="crumb-slash"
            >/</span
          ><strong>{active?.name || '工作空间'}</strong></span
        >
      </div>
      <div class="toolbar-right">
        <button
          class="icon-button"
          title="快速打开 Ctrl+P"
          aria-label="快速打开"
          disabled={busy}
          on:click={showQuick}><FolderOpen size={17} /></button
        >
        <div class="zoom-controls" role="group" aria-label="文档缩放">
          <button
            aria-label="缩小文档"
            title="缩小 Ctrl+-"
            disabled={busy || zoom <= MIN_ZOOM}
            on:click={() => (zoom = normalizeZoom(zoom - 10))}><Minus size={14} /></button
          >
          <button
            class="zoom-reset"
            aria-label={`当前缩放 ${zoom}%，点击恢复 100%`}
            title="恢复 100% Ctrl+0"
            disabled={busy}
            on:click={() => (zoom = 100)}>{zoom}%</button
          >
          <button
            aria-label="放大文档"
            title="放大 Ctrl++"
            disabled={busy || zoom >= MAX_ZOOM}
            on:click={() => (zoom = normalizeZoom(zoom + 10))}><Plus size={14} /></button
          >
        </div>
        <button
          class="icon-button"
          title="查找 Ctrl+F"
          aria-label="查找"
          disabled={!active}
          on:click={find}><Search size={17} /></button
        ><button
          class="icon-button save-button"
          title="保存 Ctrl+S"
          aria-label="保存"
          disabled={!active || busy}
          on:click={() => run(() => saveTab(active!))}><Save size={17} /></button
        >
        {#if active?.edit}<div class="insert-actions">
            <button disabled={busy} on:click={() => run(() => insertContent('link'))}>链接</button
            ><button disabled={busy} on:click={() => run(() => insertContent('table'))}>表格</button
            ><button disabled={busy} on:click={() => run(() => insertContent('image'))}>图片</button
            >
          </div>{/if}
        <div class="mode-toggle">
          <button
            class:chosen={!active?.edit}
            disabled={!active}
            on:click={() => { flushDocuments(); if (active) patch(active.id, { edit: false }); }}
            ><BookOpen size={15} /><span>阅读</span></button
          ><button
            class:chosen={active?.edit}
            disabled={!active}
            on:click={() => active && patch(active.id, { edit: true })}
            ><Columns2 size={15} /><span>编辑</span></button
          >
        </div>
        <div class="menu-host">
          <button
            class="icon-button"
            aria-label="更多操作"
            title="更多操作"
            on:click={() => (menu = !menu)}><Ellipsis size={19} /></button
          >{#if menu}<div class="dropdown">
              <button
                on:click={() => {
                  menu = false;
                  preferencesOpen = true;
                }}>设置</button
              >
              <button disabled={busy} on:click={() => run(showRecovery)}
                ><Clock3 size={16} />恢复草稿</button
              >
              <button disabled={!navState.closed || busy} on:click={() => run(reopenClosed)}>重新打开关闭的标签 <kbd>Ctrl Shift T</kbd></button>
              <button disabled={!active || busy} on:click={() => { menu = false; historyAction('undo'); }}>撤销 <kbd>Ctrl Z</kbd></button>
              <button disabled={!active || busy} on:click={() => { menu = false; historyAction('redo'); }}>重做 <kbd>Ctrl Y</kbd></button>
              <button on:click={() => run(openFiles)}>打开文件 <kbd>Ctrl O</kbd></button><button
                on:click={() => run(openFolder)}>打开文件夹 <kbd>Ctrl Shift O</kbd></button
              ><button disabled={!active} on:click={() => run(() => saveTab(active!, true))}
                >另存为 <kbd>Ctrl Shift S</kbd></button
              ><button disabled={!active || busy} on:click={() => run(exportCurrentPdf)}
                >导出为 PDF <kbd>Ctrl Shift P</kbd></button
              ><button
                on:click={() => {
                  cycleTheme();
                  menu = false;
                }}>切换主题</button
              ><button
                on:click={() => {
                  newTab(welcome, '欢迎使用.md', false);
                  menu = false;
                }}>使用指南</button
              >
            </div>{/if}
        </div>
      </div>
    </header>
    <div class="tabbar" aria-label="已打开文档">
      <div class="tabs" role="tablist">
        {#each tabs as tab}<div class="tab" class:active={tab.id === activeId}>
            <button
              role="tab"
              aria-selected={tab.id === activeId}
              class="tab-select"
              title={tab.path || tab.name}
              on:click={() => {
                selectTab(tab.id);
              }}
              ><FileText size={14} /><span>{tab.name}</span>{#if dirty(tab)}<span
                  class="dirty-dot"
                  aria-label="未保存"
                ></span>{/if}</button
            ><button
              class="tab-close"
              aria-label={`关闭 ${tab.name}`}
              disabled={busy}
              on:click={() => run(() => closeTab(tab.id))}><X size={13} /></button
            >
          </div>{/each}
      </div>
      <button class="tab-new" aria-label="新建文档" title="新建 Ctrl+N" on:click={() => notebookMode ? notebookPanel?.newNote() : newTab()}
        ><Plus size={17} /></button
      >
    </div>
    {#if error}<div class="error-banner" role="alert">
        <span>{error}</span><button aria-label="关闭错误提示" on:click={() => (error = '')}
          ><X size={16} /></button
        >
      </div>{/if}
    {#if active?.external}<div class="external-banner">
        <span>此文件已被外部修改或移动。保存时将检查冲突。</span><button disabled={busy} on:click={() => run(() => compareExternal(active!))}>比较版本</button><button
          disabled={busy}
          on:click={() => run(() => reloadTab(active!))}>重新加载</button
        ><button on:click={() => patch(active!.id, { external: false })} aria-label="暂时关闭提示"
          ><X size={14} /></button
        >
      </div>{/if}
    {#if active}
      {#if active.livePreview !== undefined}<div class="large-document-bar" role="status">
        <span>{active.livePreview ? '大文档 · 实时预览' : '大文档 · 手动预览'}{active.livePreview === false && active.previewSource !== active.content ? ' · 预览待刷新' : ''}</span>
        <button on:click={() => { flushDocuments(); if (active) patch(active.id, { previewSource: active.content }); }}>刷新预览</button>
        <button on:click={() => { flushDocuments(); if (active) patch(active.id, { livePreview: !active.livePreview, previewSource: active.content }); }}>{active.livePreview ? '改为手动预览' : '启用实时预览'}</button>
      </div>{/if}
      <div class="document-meta">
        {#if noteForPath(library, active.path)}<span class="note-save-status" role="status">{active.external || autosave.blocked.has(active.id) ? '保存失败 · 请处理冲突或重试保存' : library?.pending.length ? '保存暂停 · 请恢复文件操作' : savingNotes[active.id] === '保存中' ? '保存中' : dirty(active) ? '待保存' : '已保存'}</span><button disabled={notebookMutation} on:click={() => { notebookMode = true; tick().then(() => notebookPanel?.insertLink()); }}>插入笔记链接</button>{/if}
        <span>{active.edit ? '书写，让想法成形' : '专注此刻，静心阅读'}</span><span
          >{active.edit ? 'MARKDOWN / PREVIEW' : 'READING MODE'}</span
        >
      </div>
      <div
        class="document-split"
        bind:this={splitHost}
        class:editing={active.edit}
        style={`--editor-ratio:${ratio}%`}
      >
        {#if active.edit}<div class="editor-panel">
            {#key active.id + ':' + active.revision}<Editor
                bind:this={editor}
                id={active.id}
                {zoom}
                content={active.content}
                position={active.position}
                {selection}
                onpasteimage={(file) => run(() => insertContent('image', file))}
                onposition={(cursor, line) => {
                  if (active) rememberPosition(active, { cursor, editorLine: line });
                }}
                onpending={(byteLength, owner) => {
                  const target = tabs.find((t) => t.id === owner);
                  if (!target) return;
                  if (desktop) backups.markPending(owner, flushDocuments);
                  if (byteLength >= 5 * 1024 * 1024 && target.livePreview === undefined)
                    patch(owner, { byteLength, pending: true, livePreview: false, previewSource: target.content });
                  else patch(owner, { byteLength, pending: true });
                }}
                onchange={(value, owner) => patch(owner, { content: value, pending: false })}
                onscroll={(position) => preview?.syncFromEditor(position)}
              />{/key}
          </div>
          <!-- A focusable separator is the WAI-ARIA window splitter pattern. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
          <div
            class="splitter"
            role="separator"
            aria-label="调整编辑区宽度"
            aria-orientation="vertical"
            aria-valuenow={Math.round(ratio)}
            aria-valuemin={28}
            aria-valuemax={72}
            tabindex="0"
            on:pointerdown={resize}
            on:keydown={(e) => {
              if (e.key === 'ArrowLeft') ratio = Math.max(28, ratio - 2);
              if (e.key === 'ArrowRight') ratio = Math.min(72, ratio + 2);
            }}
          ></div>{/if}
        {#key active.id}<Preview
            bind:this={preview}
            content={active.livePreview === false ? active.previewSource ?? active.content : active.content}
            stale={active.pending || (active.livePreview === false && active.previewSource !== active.content)}
            ontask={(offset, checked, source) => {
              if (!active || active.pending || source !== active.content) return;
              if (!/^\[[ xX]\]$/.test(active.content.slice(offset, offset + 3))) return;
              const content = changeDocument(active.id, active.content, { from: offset + 1, to: offset + 2, insert: checked ? 'x' : ' ' });
              patch(active.id, { content, pending: false, previewSource: content });
            }}
            {reading}
            path={active.path}
            {dark}
            {zoom}
            syncEnabled={active.edit}
            scroll={active.scroll}
            location={active.position}
            onposition={(position) => {
              if (active) rememberPosition(active, position);
            }}
            onerror={fail}
            onscroll={(position) => {
              if (active) active.scroll = position;
            }}
            onheadings={(value) => (headings = value)}
            onanchor={navigateAnchor}
            onlink={(href) => run(() => openLink(href))}
          />{/key}
      </div>
    {:else}<div class="empty-main">
        <div class="empty-symbol"><Feather size={42} strokeWidth={1.2} /></div>
        <span class="eyebrow">YOUR QUIET SPACE</span>
        <h1>下一页，新的想法。</h1>
        <p>打开一份 Markdown 文档，<br />或从空白开始，记录此刻的灵感。</p>
        <div>
          <button class="primary" disabled={busy} on:click={() => run(openFiles)}
            ><FolderOpen size={17} />打开文档</button
          ><button class="secondary" on:click={() => newTab()}><Plus size={17} />新建文档</button>
        </div>
        <span class="drop-hint">也可以将 .md 文件拖到这里</span>
      </div>{/if}
    <footer class="statusbar">
      <span
        >{#if busy}<span class="status-dot pending"></span>正在处理…{:else}<Check
            size={13}
          />{active && dirty(active) ? '有未保存的修改' : '一切就绪'}{/if}</span
      >
      <div>
        {#if active}<span
            >{characterCount.toLocaleString()} 字符 · {Math.round(
              (active.position?.progress || 0) * 100,
            )}%</span
          ><span>UTF-8{active.bom ? ' BOM' : ''}</span><span>{active.newline}</span><span
            >Markdown</span
          >{/if}
      </div>
    </footer>
  </main>
</div>
{#if toast}<div class="toast" role="status"><Check size={16} />{toast}</div>{/if}
{#if dragging}<div class="drop-overlay">
    <FolderOpen size={44} /><strong>在这里放下文档</strong><span>打开 Markdown 文件或文件夹</span>
  </div>{/if}
{#if dialog}
  <div class="modal-backdrop">
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      tabindex="-1"
      use:focusDialog
    >
      <div class="modal-icon"><FileText size={24} /></div>
      <h2 id="dialog-title">{dialog.title}</h2>
      <p>{dialog.text}</p>
      <div class="modal-actions">
        {#each dialog.choices as choice}<button
            class:primary={choice.primary}
            class:secondary={!choice.primary}
            on:click={() => answer(choice.value)}>{choice.label}</button
          >{/each}
      </div>
    </div>
  </div>
{/if}
