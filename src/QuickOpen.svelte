<script lang="ts">
  import { onMount } from 'svelte';
  import { api, desktop } from './lib/api';
  import { basename } from './lib/types';
  import { quickMatches, type QuickItem } from './lib/local-state';
  import { modalFocus } from './lib/focus';
  export let items: QuickItem[];
  export let workspace: string;
  export let onopen: (item: QuickItem) => void;
  export let onclose: () => void;
  let query = '',
    paths: string[] = [],
    loading = false,
    message = '',
    selected = 0,
    request = 0;
  $: results = quickMatches(
    [...items, ...paths.map((path) => ({ path, name: basename(path) }))],
    query,
  );
  $: if (query !== undefined) selected = 0;
  function displayPath(path: string) {
    const prefix = workspace.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    const normalized = path.replace(/\\/g, '/');
    return workspace && normalized.toLowerCase().startsWith(prefix.toLowerCase())
      ? normalized.slice(prefix.length)
      : path || '未命名文档 · 已打开';
  }
  async function refresh() {
    if (!desktop || !workspace) return;
    const token = ++request;
    loading = true;
    message = '';
    try {
      const result = await api.index(workspace);
      if (token !== request) return;
      if (!result.cancelled) {
        paths = result.paths;
        message = result.skipped ? `有 ${result.skipped} 个目录或文件无法访问，已跳过` : '';
      }
    } catch (e) {
      if (token === request) message = String(e);
    } finally {
      if (token === request) loading = false;
    }
  }
  onMount(() => {
    void refresh();
    return () => {
      request++;
      if (desktop) void api.cancelIndex().catch(() => {});
    };
  });
  function keys(event: KeyboardEvent) {
    if (event.ctrlKey && event.key.toLowerCase() === 'p') event.preventDefault();
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      selected = Math.max(
        0,
        Math.min(results.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)),
      );
      queueMicrotask(() =>
        document.getElementById('quick-' + selected)?.scrollIntoView({ block: 'nearest' }),
      );
    }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      if (results[selected]) onopen(results[selected]);
    }
    if (event.key !== 'Tab') event.stopPropagation();
  }
</script>

<div class="feature-overlay">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    tabindex="-1"
    class="feature-dialog quick-dialog"
    role="dialog"
    aria-modal="true"
    aria-label="快速打开"
    use:modalFocus
    on:keydown={keys}
  >
    <header>
      <h2>快速打开</h2>
      <button aria-label="关闭快速打开" on:click={onclose}>×</button>
    </header>
    <input
      class="quick-input"
      aria-label="搜索文件名或路径"
      placeholder="搜索文件名或路径…"
      bind:value={query}
      aria-controls="quick-results"
    />
    <div class="feature-note">
      <span>{loading ? '正在索引工作区…' : `${results.length} 个结果 · ↑↓ 选择，Enter 打开`}</span
      ><button disabled={!workspace} on:click={refresh}>刷新索引</button>
    </div>
    {#if message}<p role="status">{message}</p>{/if}
    <div class="quick-results" id="quick-results">
      {#each results as item, i}<button
          id={'quick-' + i}
          class:highlighted={i === selected}
          class="quick-result"
          on:click={() => onopen(item)}
          ><strong>{item.name}</strong><span title={item.path}>{displayPath(item.path)}</span
          ></button
        >{/each}
      {#if !results.length}<p class="feature-note">
          {loading ? '正在查找 Markdown 文件…' : '没有匹配的文件'}
        </p>{/if}
    </div>
  </div>
</div>
