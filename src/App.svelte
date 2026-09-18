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
  import { onMount } from 'svelte';
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
  import Preview from './Preview.svelte';
  import Tree from './Tree.svelte';
  import { api, desktop } from './lib/api';
  import { normalizeZoom, MIN_ZOOM, MAX_ZOOM } from './lib/zoom';
  import type { Tab, Heading, Entry, DocumentData } from './lib/types';
  import { basename, pathKey, localReference, isMarkdown } from './lib/types';
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
    sideMode: 'files' | 'outline' = 'files';
  let busy = false,
    toast = '',
    error = '',
    dragging = false,
    menu = false,
    ready = false;
  let preview: Preview, editor: Editor, splitHost: HTMLDivElement;
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
  async function exportCurrentPdf() {
    if (!active) return;
    if (!desktop) throw new Error('请在桌面版中导出 PDF');
    const { content, path, name } = active;
    const output = await api.choosePdf(name.replace(/\.(md|markdown|mdown)$/i, '') + '.pdf');
    if (!output) return;
    exporting = true;
    try {
      const { exportPdf } = await import('./lib/pdf');
      await exportPdf(content, path, /\.pdf$/i.test(output) ? output : output + '.pdf');
      notify('PDF 已导出');
    } finally {
      exporting = false;
    }
  }
  async function run(action: () => Promise<unknown>) {
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
    const id = crypto.randomUUID();
    tabs = [
      ...tabs,
      {
        id,
        path: '',
        name,
        content,
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
    tabs = tabs.map((t) => (t.id === id ? { ...t, ...data } : t));
  }
  function remember(path: string) {
    recent = [path, ...recent.filter((p) => pathKey(p) !== pathKey(path))].slice(0, 12);
  }
  async function openPath(path: string) {
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
        edit: false,
        external: false,
        revision: 0,
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
    const index = tabs.indexOf(tab);
    tabs = tabs.filter((t) => t.id !== id);
    if (activeId === id) activeId = tabs[Math.min(index, tabs.length - 1)]?.id || '';
    if (!tabs.length) headings = [];
    if (tab.edit) {
      const { forgetEditor } = await import('./lib/editor');
      setTimeout(() => forgetEditor(id));
    }
  }
  async function switchWorkspace(path: string) {
    const root = await api.workspace(path);
    const listed = await api.list(root);
    for (const tab of tabs) if (!(await confirmTab(tab))) return;
    workspace = root;
    entries = listed;
    tabs = [];
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
    const document = await api.read(tab.path);
    patch(tab.id, {
      ...document,
      saved: document.content,
      external: false,
      revision: tab.revision + 1,
    });
  }
  async function saveTab(tab: Tab, saveAs = false): Promise<boolean> {
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
      pathKey(path) === pathKey(tab.path) ? tab.fingerprint : await api.fingerprint(path);
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
        remember(document.path);
        notify('已保存到本地');
        return true;
      } catch (e) {
        if (String(e) !== 'CONFLICT') throw e;
        const current = await api.fingerprint(path);
        const choice = await choose(
          '文件在外部发生了变化',
          `“${basename(path)}”${current === null ? '已被移动或删除' : '有更新的磁盘版本'}。请选择如何保留你的内容。`,
          [
            { label: '取消', value: 'cancel' },
            { label: '重新加载', value: 'reload' },
            { label: '另存为', value: 'saveAs' },
            { label: '覆盖磁盘版本', value: 'overwrite', primary: true },
          ],
        );
        if (choice === 'reload') {
          await reloadTab({ ...tab, path }, true);
          return true;
        }
        if (choice === 'saveAs') return saveTab(tab, true);
        if (choice !== 'overwrite') return false;
        expected = current;
      }
    }
  }
  async function checkExternal() {
    if (!desktop || busy || dialog) return;
    for (const tab of tabs.filter((t) => t.path)) {
      try {
        const fingerprint = await api.fingerprint(tab.path);
        if (fingerprint !== tab.fingerprint) patch(tab.id, { external: true });
      } catch {
        patch(tab.id, { external: true });
      }
    }
  }
  async function openLink(href: string) {
    if (/^(https?:|mailto:)/i.test(href)) {
      await api.external(href);
      return;
    }
    if (!active?.path) throw new Error('请先保存文档，或从本地打开文档，再访问相对路径链接。');
    const path = localReference(active.path, href);
    if (!isMarkdown(path)) throw new Error('仅支持打开 Markdown 文档链接');
    await openPath(path);
    const hash = href.split('#')[1];
    if (hash) setTimeout(() => preview?.anchor(decodeURIComponent(hash)), 400);
  }
  function toggleEdit() {
    if (active) patch(active.id, { edit: !active.edit });
  }
  function find() {
    if (active?.edit) editor?.find();
    else preview?.find();
  }
  function cycleTheme() {
    theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  }
  function shortcuts(event: KeyboardEvent) {
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
    if (key === 'p' && event.shiftKey) {
      event.preventDefault();
      run(exportCurrentPdf);
      return;
    }
    if (!['o', 's', 'n', 'w', 'e', 'f', 'b'].includes(key)) return;
    event.preventDefault();
    if (key === 'o') run(event.shiftKey ? openFolder : openFiles);
    if (key === 's' && active) run(() => saveTab(active!, event.shiftKey));
    if (key === 'n') newTab();
    if (key === 'w' && active) run(() => closeTab(active!.id));
    if (key === 'e') toggleEdit();
    if (key === 'f') find();
    if (key === 'b') sidebar = !sidebar;
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
    const poll = setInterval(checkExternal, 10000);
    cleanup.push(() => clearInterval(poll));
    (async () => {
      if (desktop) {
        const addCleanup = (fn: () => void) => (disposed ? fn() : cleanup.push(fn));
        addCleanup(
          await getCurrentWindow().onDragDropEvent(({ payload }) => {
            dragging = payload.type === 'over' || payload.type === 'enter';
            if (payload.type === 'drop')
              run(async () => {
                for (const path of payload.paths)
                  if (isMarkdown(path)) await openPath(path);
                  else await switchWorkspace(path);
              });
          }),
        );
        addCleanup(await listen('open-paths', drainIncoming));
        addCleanup(
          await getCurrentWindow().onCloseRequested(async (event) => {
            event.preventDefault();
            if (busy || dialog) return;
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
              await getCurrentWindow().destroy();
            });
          }),
        );
        const incoming = await api.pending();
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
      if (queuedOpen) await drainIncoming();
    })().catch(fail);
    return () => {
      disposed = true;
      cleanup.forEach((fn) => fn());
      clearTimeout(toastTimer);
    };
  });
</script>

<svelte:window on:keydown={shortcuts} on:focus={checkExternal} />
{#if exporting}<div class="pdf-progress" role="status" aria-live="polite">
    正在排版并导出 PDF，请稍候…
  </div>{/if}
<div class="app-shell" class:sidebar-hidden={!sidebar} inert={!!dialog}>
  <aside class="sidebar" aria-label="侧边栏">
    <div class="brand">
      <span class="brand-icon"><Feather size={22} strokeWidth={1.6} /></span><strong
        >墨页<span>INKDOWN</span></strong
      ><span class="version">v0.1</span>
    </div>
    <div class="side-actions">
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
      >
    </div>
    <div class="side-content">
      {#if sideMode === 'files'}
        <div class="section-label">
          <span>{workspace ? basename(workspace) : '工作空间'}</span>{#if workspace}<button
              title="刷新文件树"
              aria-label="刷新文件树"
              disabled={busy}
              on:click={() =>
                run(async () => {
                  entries = await api.list(workspace);
                  treeVersion++;
                })}><RefreshCw size={13} /></button
            >{/if}
        </div>
        {#if workspace}{#key treeVersion}<Tree
              {entries}
              activePath={active?.path || ''}
              onopen={(path) => run(() => openPath(path))}
              onerror={fail}
            />{/key}{#if !entries.length}<p class="side-hint">
              此文件夹中还没有 Markdown 文档。
            </p>{/if}
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
      {:else}<div class="section-label">文档大纲 <span>{headings.length}</span></div>
        {#each headings as heading}<button
            class="outline-row"
            style:padding-left={`${16 + (heading.level - 1) * 12}px`}
            on:click={() => preview?.jump(heading.id)}>{heading.text}</button
          >{/each}{#if !headings.length}<p class="side-hint">
            文档中的标题会显示在这里。
          </p>{/if}{/if}
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
  <main class="main-panel">
    <header class="toolbar">
      <div class="toolbar-left">
        <button
          class="icon-button"
          title="侧边栏 Ctrl+B"
          aria-label="切换侧边栏"
          on:click={() => (sidebar = !sidebar)}><PanelLeft size={18} /></button
        ><span class="toolbar-divider"></span><span class="breadcrumb"
          ><span>{workspace ? basename(workspace) : '我的文档'}</span><span class="crumb-slash"
            >/</span
          ><strong>{active?.name || '工作空间'}</strong></span
        >
      </div>
      <div class="toolbar-right">
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
        <div class="mode-toggle">
          <button
            class:chosen={!active?.edit}
            disabled={!active}
            on:click={() => active && patch(active.id, { edit: false })}
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
                activeId = tab.id;
              }}
              ><FileText size={14} /><span>{tab.name}</span>{#if tab.content !== tab.saved}<span
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
      <button class="tab-new" aria-label="新建文档" title="新建 Ctrl+N" on:click={() => newTab()}
        ><Plus size={17} /></button
      >
    </div>
    {#if error}<div class="error-banner" role="alert">
        <span>{error}</span><button aria-label="关闭错误提示" on:click={() => (error = '')}
          ><X size={16} /></button
        >
      </div>{/if}
    {#if active?.external}<div class="external-banner">
        <span>此文件已被外部修改或移动。保存时将检查冲突。</span><button
          disabled={busy}
          on:click={() => run(() => reloadTab(active!))}>重新加载</button
        ><button on:click={() => patch(active!.id, { external: false })} aria-label="暂时关闭提示"
          ><X size={14} /></button
        >
      </div>{/if}
    {#if active}
      <div class="document-meta">
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
                onchange={(value) => active && patch(active.id, { content: value })}
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
            content={active.content}
            path={active.path}
            {dark}
            {zoom}
            syncEnabled={active.edit}
            scroll={active.scroll}
            onscroll={(position) => {
              if (active) active.scroll = position;
            }}
            onheadings={(value) => (headings = value)}
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
          />{active?.content !== active?.saved ? '有未保存的修改' : '一切就绪'}{/if}</span
      >
      <div>
        {#if active}<span>{active.content.replace(/\s/g, '').length.toLocaleString()} 字符</span
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
