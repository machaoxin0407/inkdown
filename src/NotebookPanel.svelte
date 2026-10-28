<script lang="ts">
  import { onMount } from 'svelte';
  import {
    BookOpen,
    Plus,
    ChevronDown,
    PanelLeft,
    Search,
    FileText,
    Trash2,
    FolderOpen,
  } from 'lucide-svelte';
  import { api, desktop } from './lib/api';
  import {
    absolute,
    notebookApi,
    prepareImport,
    structureEdits,
    type NotebookLibrary,
    type LibraryItem,
    type OperationOutcome,
  } from './lib/notebook';
  import type { Tab } from './lib/types';
  import { pathKey, sourceVersion } from './lib/types';
  import type { SearchHit } from './lib/workspace';
  import { modalFocus } from './lib/focus';
  export let library: NotebookLibrary | null = null;
  export let tabs: Tab[] = [];
  export let activePath = '';
  export let revision = 0;
  export let onopen: (path: string, edit?: boolean) => Promise<void>;
  export let onhit: (hit: SearchHit) => Promise<void>;
  export let onbefore: () => Promise<void>;
  export let onafter: (result: OperationOutcome, action: string, paths: string[]) => Promise<void>;
  export let onrelease: () => void;
  export let onlink: (item: LibraryItem) => void;
  export let onfiles: () => void;
  export let onerror: (e: unknown) => void;
  let selected = '',
    sort = 'manual',
    treeVisible = true,
    listVisible = true,
    collapsed: string[] = [];
  export let working = false;
  let query = '',
    scope = 'library',
    trashVisible = false,
    dragId = '',
    searchToken = 0;
  let results: { item: LibraryItem; hit?: SearchHit }[] = [],
    searching = false;
  let form: {
    kind: string;
    item?: LibraryItem;
    name: string;
    parent: string;
    template: boolean;
    trashId?: string;
  } | null = null;
  let confirmation: { title: string; text: string; resolve: (ok: boolean) => void } | null = null;
  let linkMode = false;
  let status = '';
  const colors = ['#68866f', '#6285a8', '#b17c64', '#9a7eaf', '#b39956'];
  const preferences = () => {
    try {
      return JSON.parse(localStorage.getItem('inkdown.notebooks.ui') || '{}');
    } catch {
      return {};
    }
  };
  const pref = preferences();
  selected = pref.selected || '';
  sort = pref.sort || 'manual';
  collapsed = pref.collapsed || [];
  treeVisible = pref.treeVisible !== false;
  $: if (library)
    localStorage.setItem(
      'inkdown.notebooks.ui',
      JSON.stringify({ selected, sort, collapsed, treeVisible }),
    );
  $: books =
    library?.items.filter((i) => i.kind === 'notebook').sort((a, b) => a.order - b.order) || [];
  $: chosen = library?.items.find((i) => i.id === selected);
  $: bookId = chosen?.kind === 'chapter' ? chosen.parent : chosen?.id;
  $: folders = library?.items.filter((i) => i.kind !== 'note') || [];
  $: notes = (
    library?.items.filter((i) => i.kind === 'note' && (!selected || i.parent === selected)) || []
  ).sort((a, b) =>
    sort === 'recent'
      ? (library?.summaries[b.id]?.updatedAt || 0) - (library?.summaries[a.id]?.updatedAt || 0)
      : a.order - b.order,
  );
  $: if (library && selected && !library.items.some((i) => i.id === selected))
    selected = library.items.find((i) => i.kind === 'notebook')?.id || '';
  $: scheduleSearch(query, scope, bookId, library, revision);
  let searchTimer: ReturnType<typeof setTimeout>;
  function scheduleSearch(
    q: string,
    searchScope: string,
    book: string | undefined,
    l: NotebookLibrary | null,
    _revision: number,
  ) {
    clearTimeout(searchTimer);
    const token = ++searchToken;
    if (!q.trim() || !l) {
      results = [];
      searching = false;
      return;
    }
    searchTimer = setTimeout(async () => {
      searching = true;
      const out: typeof results = [];
      try {
        for (const item of l.items.filter(
          (i) =>
            i.kind === 'note' &&
            (searchScope === 'library' ||
              i.parent === book ||
              l.items.find((p) => p.id === i.parent)?.parent === book),
        )) {
          if (token !== searchToken) return;
          const path = absolute(l.root, item.path),
            tab = tabs.find((t) => pathKey(t.path) === pathKey(path));
          const hits = await api.searchDocument(
            path,
            q.trim(),
            false,
            tab ? { path, content: tab.content, sourceVersion: sourceVersion(tab) } : undefined,
          );
          if (hits.length || item.name.toLowerCase().includes(q.trim().toLowerCase()))
            out.push({ item, hit: hits[0] });
          if (out.length >= 500) break;
        }
        if (token === searchToken) results = out;
      } catch (e) {
        if (token === searchToken) onerror(e);
      } finally {
        if (token === searchToken) searching = false;
      }
    }, 250);
  }
  function confirm(title: string, text: string) {
    return new Promise<boolean>((resolve) => (confirmation = { title, text, resolve }));
  }
  function answer(ok: boolean) {
    const c = confirmation;
    confirmation = null;
    c?.resolve(ok);
  }
  async function run(work: () => Promise<void>) {
    if (working) return;
    working = true;
    try {
      await work();
    } catch (e) {
      onerror(e);
    } finally {
      working = false;
      onrelease();
    }
  }
  export async function refresh() {
    if (!library || working) return;
    const root = library.root;
    const updated = await notebookApi.refresh(root);
    if (library?.root === root && !working) library = updated;
  }
  async function openLibrary(create: boolean) {
    if (!desktop) throw new Error('笔记库需要在桌面版中使用');
    const path = await api.chooseFolder();
    if (typeof path !== 'string') return;
    await onbefore();
    try {
      library = await notebookApi.open(path, create);
    } catch (e) {
      if (!String(e).includes('元数据损坏')) throw e;
      if (
        !(await confirm(
          '重建笔记库目录？',
          '原元数据会保留为备份，按现有文件夹重新识别笔记。颜色和手动排序会重置；旧回收站文件仍保留在 .inkdown/trash 中。',
        ))
      )
        throw e;
      library = await notebookApi.open(path, false, true);
    }
    localStorage.setItem('inkdown.notebooks.root', library.root);
    selected = library.items.find((i) => i.kind === 'notebook')?.id || '';
  }
  function newForm(kind: string) {
    form = {
      kind,
      name: '',
      parent: kind === 'notebook' ? '' : kind === 'chapter' ? bookId || '' : selected,
      template: false,
    };
  }
  export function newNote() {
    if (!library || !selected) {
      status = '请先创建或选择笔记本';
      return;
    }
    newForm('note');
  }
  export function insertLink() {
    linkMode = true;
    query = '';
    listVisible = true;
  }
  export function toggleTree() {
    treeVisible = !treeVisible;
    if (treeVisible && matchMedia('(max-width:1050px)').matches) listVisible = false;
  }
  function toggleList() {
    listVisible = !listVisible;
    if (listVisible && matchMedia('(max-width:1050px)').matches) treeVisible = false;
  }
  async function submit() {
    if (!form || !library) return;
    const f = form;
    form = null;
    await run(async () => {
      if (f.kind === 'move' || f.kind === 'restore') {
        await structure(f.item!, f.kind, f.parent, f.name, f.trashId);
        return;
      }
      await onbefore();
      const oldIds = new Set(library!.items.map((i) => i.id));
      const content = f.template
        ? `# ${f.name}\n\n## 我的理解\n\n## 参考资料\n\n## 相关知识\n\n## 还没弄懂的问题\n`
        : '';
      library = await notebookApi.create(library!, f.parent, f.kind, f.name, content);
      const created = library.items.find((i) => !oldIds.has(i.id));
      if (created?.kind === 'note') {
        selected = created.parent;
        await onopen(absolute(library.root, created.path), true);
      } else if (created) selected = created.id;
    });
  }
  async function structure(
    item: LibraryItem,
    action: string,
    parent = '',
    name = '',
    trashId?: string,
  ) {
    if (!library) return;
    await onbefore();
    library = await notebookApi.refresh(library.root);
    const plan = await notebookApi.prepare(library, trashId || item.id, action, parent, name);
    const edits = await structureEdits(library, plan);
    const title =
      action === 'trash'
        ? '移入回收站？'
        : action === 'restore'
          ? '恢复笔记？'
          : '整理笔记位置与名称？';
    const text =
      action === 'trash'
        ? `“${item.name}”及其内容将移入回收站，可恢复。指向它的链接会保留。`
        : `${plan.moves.map((m) => `${m.oldPath} → ${m.newPath}`).join('\n')}\n将更新库内 ${edits.length} 篇笔记的相对链接和图片引用。库外引用不会修改。`;
    if (!(await confirm(title, text))) return;
    let result: OperationOutcome;
    try {
      result = await notebookApi.execute(library.root, plan.id, edits);
    } finally {
      library = await notebookApi.refresh(library.root);
    }
    await onafter(
      result!,
      action,
      plan.moves.map((m) => m.oldPath),
    );
    if (result!.errors.length) status = result!.errors.join('\n');
    else status = action === 'trash' ? '已移入回收站' : '已完成整理';
  }
  function moveForm(item: LibraryItem) {
    form = { kind: 'move', item, name: item.name, parent: item.parent, template: false };
  }
  async function reorder(item: LibraryItem, direction: number) {
    if (!library) return;
    const siblings = library.items
      .filter((i) => i.parent === item.parent && i.kind === item.kind)
      .sort((a, b) => a.order - b.order);
    const index = siblings.findIndex((i) => i.id === item.id),
      next = index + direction;
    if (next < 0 || next >= siblings.length) return;
    [siblings[index], siblings[next]] = [siblings[next], siblings[index]];
    library = await notebookApi.style(
      library,
      siblings.map((i) => i.id),
    );
  }
  async function drop(target: LibraryItem) {
    const item = library?.items.find((i) => i.id === dragId);
    dragId = '';
    if (!item || item.id === target.id || !library) return;
    if (item.kind === target.kind && item.parent === target.parent) {
      const siblings = library.items
        .filter((i) => i.parent === item.parent && i.kind === item.kind && i.id !== item.id)
        .sort((a, b) => a.order - b.order);
      siblings.splice(
        siblings.findIndex((i) => i.id === target.id),
        0,
        item,
      );
      library = await notebookApi.style(
        library,
        siblings.map((i) => i.id),
      );
    } else if (
      (item.kind === 'note' && target.kind !== 'note') ||
      (item.kind === 'chapter' && target.kind === 'notebook')
    )
      await structure(item, 'move', target.id, item.name);
  }
  async function importNotes() {
    if (!library || !selected) return;
    const sources = await api.chooseFiles();
    if (!sources) return;
    await onbefore();
    const plan = await notebookApi.importPrepare(
      library,
      selected,
      Array.isArray(sources) ? sources : [sources],
    );
    const { prepared, warnings } = await prepareImport(library, plan);
    if (
      !(await confirm(
        '复制导入 Markdown',
        `将导入 ${prepared.length} 篇笔记并复制可读取的本地图片，来源文件保持不变。\n${warnings.join('\n')}`,
      ))
    )
      return;
    const messages: string[] = [];
    for (const p of prepared) {
      try {
        await notebookApi.importCommit(library.root, plan.id, p.file.id, p.content, p.images);
        messages.push(`已导入：${p.file.destination}`);
      } catch (e) {
        messages.push(`失败：${p.file.destination} — ${String(e)}；同批指向它的链接需检查`);
      }
    }
    library = await notebookApi.refresh(library.root);
    status = messages.join('\n');
  }
  async function recover(operation: string) {
    if (!library) return;
    await onbefore();
    let result = await notebookApi.recover(library.root, operation);
    if (
      result.errors.length &&
      (await confirm(
        '保留后来修改的文件并完成整理？',
        result.errors.join('\n') + '\n这些文件不会被覆盖，相关链接需要手动检查。',
      ))
    )
      result = await notebookApi.recover(library.root, operation, true);
    library = await notebookApi.refresh(library.root);
    await onafter(
      result,
      'recover',
      library.trash.map((t) => t.originalPath),
    );
    status = result.complete ? '已恢复操作' : result.errors.join('\n');
  }
  onMount(() => {
    const dismissMenus = (event: MouseEvent) => {
      const summary = (event.target as Element).closest('.notebook-menu > summary');
      for (const menu of document.querySelectorAll<HTMLDetailsElement>('.notebook-menu[open]'))
        if (menu !== summary?.parentElement) menu.open = false;
    };
    document.addEventListener('click', dismissMenus);
    const modalKeys = (event: KeyboardEvent) => {
      if (form || confirmation) {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          if (confirmation) answer(false);
          else form = null;
        }
      }
    };
    document.addEventListener('keydown', modalKeys);
    const narrow = matchMedia('(max-width: 1050px)');
    const resize = () => {
      if (narrow.matches) listVisible = false;
    };
    resize();
    narrow.addEventListener('change', resize);
    let stopped = false;
    const timer = setInterval(() => {
      if (!stopped && !working && library && !library.pending.length) void refresh().catch(onerror);
    }, 10000);
    return () => {
      stopped = true;
      narrow.removeEventListener('change', resize);
      document.removeEventListener('keydown', modalKeys);
      document.removeEventListener('click', dismissMenus);
      clearInterval(timer);
      clearTimeout(searchTimer);
      searchToken++;
      answer(false);
    };
  });
</script>

<section
  class="notebook-shell"
  class:tree-collapsed={!treeVisible}
  class:list-collapsed={!listVisible}
  aria-label="笔记库"
>
  <div class="notebook-tools">
    <button title="显示或隐藏笔记本" aria-label="显示或隐藏笔记本" on:click={toggleTree}
      ><PanelLeft size={16} /></button
    >
    <button on:click={toggleList}>{listVisible ? '收起列表' : '笔记列表'}</button>
    <button disabled={working} on:click={onfiles}>文件</button>
  </div>
  {#if !library}
    <div class="notebook-welcome">
      <BookOpen size={32} />
      <h2>把知识收进墨页</h2>
      <p>按科目建立笔记本，逐页整理你的理解。</p>
      <button class="primary" disabled={working} on:click={() => run(() => openLibrary(true))}
        >创建笔记库</button
      >
      <button disabled={working} on:click={() => run(() => openLibrary(false))}
        >打开已有笔记库</button
      >
      <small>新库请选择空文件夹。笔记和图片都保存在本地。</small>
    </div>
  {:else}
    {#if treeVisible}<nav class="notebook-tree" aria-label="笔记本与章节">
        <header>
          <strong>我的笔记本</strong><button
            aria-label="新建笔记本"
            disabled={working || !!library.pending.length}
            on:click={() => newForm('notebook')}><Plus size={17} /></button
          >
        </header>
        <div class="notebook-tree-scroll">
          {#each books as book (book.id)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="notebook-folder"
              on:dragover|preventDefault
              on:drop|preventDefault|stopPropagation={() => run(() => drop(book))}
            >
              <div class="notebook-folder-line">
                <button
                  class="notebook-collapse"
                  aria-label={`折叠 ${book.name}`}
                  aria-expanded={!collapsed.includes(book.id)}
                  on:click={() =>
                    (collapsed = collapsed.includes(book.id)
                      ? collapsed.filter((id) => id !== book.id)
                      : [...collapsed, book.id])}><ChevronDown size={13} /></button
                >
                <button
                  class:chosen={selected === book.id}
                  class="notebook-folder-title"
                  draggable={!working}
                  on:dragstart={() => (dragId = book.id)}
                  on:click={() => {
                    selected = book.id;
                    trashVisible = false;
                    listVisible = true;
                  }}><BookOpen size={16} color={book.color} /><span>{book.name}</span></button
                >
                <details class="notebook-menu">
                  <summary aria-label={`管理 ${book.name}`}>⋯</summary>
                  <div>
                    <button
                      on:click={() => {
                        selected = book.id;
                        form = { kind: 'chapter', name: '', parent: book.id, template: false };
                      }}>新建章节</button
                    >
                    <button on:click={() => moveForm(book)}>重命名</button>
                    <button on:click={() => run(() => reorder(book, -1))}>上移</button><button
                      on:click={() => run(() => reorder(book, 1))}>下移</button
                    >
                    <div class="notebook-colors">
                      {#each colors as color}<button
                          style:background={color}
                          aria-label={`颜色 ${color}`}
                          on:click={() =>
                            run(async () => {
                              library = await notebookApi.style(library!, [book.id], color);
                            })}
                        ></button>{/each}
                    </div>
                    <button on:click={() => run(() => structure(book, 'trash'))}>移入回收站</button>
                  </div>
                </details>
              </div>
              {#if !collapsed.includes(book.id)}{#each library.items
                  .filter((i) => i.kind === 'chapter' && i.parent === book.id)
                  .sort((a, b) => a.order - b.order) as chapter (chapter.id)}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="notebook-chapter"
                    on:dragover|preventDefault
                    on:drop|preventDefault|stopPropagation={() => run(() => drop(chapter))}
                  >
                    <button
                      class:chosen={selected === chapter.id}
                      draggable={!working}
                      on:dragstart={() => (dragId = chapter.id)}
                      on:click={() => {
                        selected = chapter.id;
                        trashVisible = false;
                        listVisible = true;
                      }}><span>{chapter.name}</span></button
                    >
                    <details class="notebook-menu">
                      <summary aria-label={`管理 ${chapter.name}`}>⋯</summary>
                      <div>
                        <button on:click={() => moveForm(chapter)}>重命名或移动</button><button
                          on:click={() => run(() => reorder(chapter, -1))}>上移</button
                        ><button on:click={() => run(() => reorder(chapter, 1))}>下移</button
                        ><button on:click={() => run(() => structure(chapter, 'trash'))}
                          >移入回收站</button
                        >
                      </div>
                    </details>
                  </div>
                {/each}{/if}
            </div>
          {/each}
          {#if !books.length}<p class="notebook-hint">创建第一个笔记本，开始记录。</p>{/if}
        </div>
        <footer>
          <button
            on:click={() => {
              trashVisible = !trashVisible;
              listVisible = true;
            }}><Trash2 size={14} />回收站 ({library.trash.length})</button
          ><button disabled={working} on:click={() => run(() => openLibrary(false))}
            ><FolderOpen size={14} />切换笔记库</button
          ><button disabled={working} on:click={() => run(() => openLibrary(true))}
            >创建另一个笔记库</button
          >
        </footer>
      </nav>{/if}
    {#if listVisible}<section class="notebook-list" aria-label="笔记列表">
        <header>
          <strong
            >{linkMode
              ? '选择要链接的笔记'
              : trashVisible
                ? '回收站'
                : chosen?.name || '所有笔记'}</strong
          ><button
            disabled={working || !selected || !!library.pending.length}
            aria-label="新建笔记"
            on:click={newNote}><Plus size={18} /></button
          >
        </header>
        {#if library.pending.length}<div class="notebook-warning">
            存在未完成的文件操作，自动保存已暂停。{#each library.pending as operation}<button
                disabled={working}
                on:click={() => run(() => recover(operation))}>恢复操作</button
              >{/each}
          </div>{/if}
        {#if linkMode}<button on:click={() => (linkMode = false)}>取消插入链接</button>{/if}
        {#if trashVisible}
          {#each library.trash as trash}<article class="notebook-card">
              <strong>{trash.items[0]?.name}</strong><small>{trash.originalPath}</small><button
                disabled={working}
                on:click={() => run(() => structure(trash.items[0], 'restore', '', '', trash.id))}
                >恢复原位置</button
              ><button
                on:click={() =>
                  (form = {
                    kind: 'restore',
                    item: trash.items[0],
                    name: trash.items[0].name,
                    parent: trash.items[0].parent,
                    template: false,
                    trashId: trash.id,
                  })}>恢复到…</button
              >
            </article>{/each}
          {#if !library.trash.length}<p class="notebook-hint">回收站为空</p>{/if}
        {:else}
          <div class="notebook-search">
            <Search size={15} /><input
              aria-label="搜索笔记"
              placeholder="搜索标题和正文"
              bind:value={query}
            />
          </div>
          <div class="notebook-list-options">
            <select aria-label="搜索范围" bind:value={scope}
              ><option value="library">整个笔记库</option><option value="book">当前笔记本</option
              ></select
            ><select aria-label="笔记排序" bind:value={sort}
              ><option value="manual">手动排序</option><option value="recent">最近修改</option
              ></select
            >
          </div>
          <div class="notebook-list-actions">
            <button
              disabled={working || !selected || !!library.pending.length}
              on:click={() => run(importNotes)}>导入 Markdown</button
            ><button
              disabled={working}
              on:click={() =>
                run(async () => {
                  library = await notebookApi.refresh(library!.root);
                })}>刷新</button
            >
          </div>
          {#if searching}<small class="notebook-hint">正在搜索…</small>{/if}
          <div class="notebook-cards">
            {#each query.trim() ? results : (linkMode ? library.items.filter((i) => i.kind === 'note') : notes).map( (item) => ({ item, hit: undefined }) ) as result (result.item.id)}
              {@const note = result.item}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <article
                class="notebook-card"
                class:active={pathKey(activePath) === pathKey(absolute(library.root, note.path))}
                draggable={!working && sort === 'manual'}
                on:dragstart={() => (dragId = note.id)}
                on:dragover|preventDefault
                on:drop|preventDefault|stopPropagation={() => run(() => drop(note))}
              >
                <button
                  class="notebook-card-body"
                  disabled={working}
                  on:click={() => {
                    if (linkMode) {
                      onlink(note);
                      linkMode = false;
                    } else
                      void run(() =>
                        result.hit ? onhit(result.hit) : onopen(absolute(library!.root, note.path)),
                      );
                  }}
                  ><strong><FileText size={14} />{note.name}</strong>
                  <p>
                    {result.hit?.snippet ||
                      library.summaries[note.id]?.excerpt ||
                      '空白笔记，开始写下你的理解…'}
                  </p>
                  <small
                    >{query
                      ? note.path
                      : new Date(
                          library.summaries[note.id]?.updatedAt || Date.now(),
                        ).toLocaleDateString('zh-CN')}</small
                  ></button
                >
                <details class="notebook-menu">
                  <summary aria-label={`管理 ${note.name}`}>⋯</summary>
                  <div>
                    <button on:click={() => moveForm(note)}>重命名或移动</button><button
                      on:click={() => run(() => reorder(note, -1))}>上移</button
                    ><button on:click={() => run(() => reorder(note, 1))}>下移</button><button
                      on:click={() => run(() => structure(note, 'trash'))}>移入回收站</button
                    >
                  </div>
                </details>
              </article>
            {/each}
            {#if !query && !notes.length && !linkMode}<p class="notebook-hint">
                在这里新建知识点笔记，或导入已有 Markdown。
              </p>{/if}
            {#if query && !searching && !results.length}<p class="notebook-hint">
                没有找到匹配的笔记
              </p>{/if}
          </div>
        {/if}
        {#if status}<div class="notebook-notice" role="status">
            <button aria-label="关闭笔记提示" on:click={() => (status = '')}>×</button>{status}
          </div>{/if}
        {#if library.warnings.length}<details class="notebook-warning">
            <summary>有 {library.warnings.length} 项读取提示</summary>{library.warnings.join('\n')}
          </details>{/if}
      </section>{/if}
  {/if}
</section>
{#if form}<div class="feature-overlay">
    <div
      class="feature-dialog settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="笔记管理"
      tabindex="-1"
      use:modalFocus
    >
      <form on:submit|preventDefault={submit}>
        <header>
          <h2>
            {form.kind === 'move'
              ? '重命名或移动'
              : form.kind === 'restore'
                ? '恢复到指定位置'
                : `新建${form.kind === 'notebook' ? '笔记本' : form.kind === 'chapter' ? '章节' : '笔记'}`}
          </h2>
          <button type="button" aria-label="关闭" on:click={() => (form = null)}>×</button>
        </header>
        <label
          >名称<input aria-label="名称" required maxlength="100" bind:value={form.name} /></label
        >{#if form.kind !== 'notebook' && form.item?.kind !== 'notebook'}<label
            >位置<select aria-label="位置" required bind:value={form.parent}
              >{#each folders.filter( (i) => (form?.kind === 'chapter' || form?.item?.kind === 'chapter' ? i.kind === 'notebook' : true) ) as folder}<option
                  value={folder.id}>{folder.path}</option
                >{/each}</select
            ></label
          >{/if}{#if form.kind === 'note'}<label class="notebook-template"
            ><input type="checkbox" bind:checked={form.template} />使用知识点笔记模板</label
          >{/if}
        <footer>
          <button type="button" on:click={() => (form = null)}>取消</button><button
            class="primary"
            type="submit">确定</button
          >
        </footer>
      </form>
    </div>
  </div>{/if}
{#if confirmation}<div class="feature-overlay">
    <div
      class="feature-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={confirmation.title}
      tabindex="-1"
      use:modalFocus
    >
      <h2>{confirmation.title}</h2>
      <p class="notebook-confirm-text">{confirmation.text}</p>
      <footer>
        <button on:click={() => answer(false)}>取消</button><button
          class="primary"
          on:click={() => answer(true)}>确定</button
        >
      </footer>
    </div>
  </div>{/if}
