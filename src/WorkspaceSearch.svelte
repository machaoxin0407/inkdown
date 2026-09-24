<script lang="ts">
  import { onDestroy } from 'svelte';
  import { api, desktop } from './lib/api';
  import type { Tab } from './lib/types';
  import type { SearchHit } from './lib/workspace';
  export let workspace: string;
  export let tabs: Tab[];
  export let onopen: (hit: SearchHit) => void;
  let query = '',
    sensitive = false,
    loading = false,
    message = '';
  let hits: SearchHit[] = [],
    token = 0,
    composing = false;
  let timer: ReturnType<typeof setTimeout>;
  function schedule() {
    clearTimeout(timer);
    const id = ++token;
    if (desktop) void api.cancelSearch();
    if (!query || !workspace) {
      hits = [];
      loading = false;
      return;
    }
    if (composing) return;
    loading = true;
    timer = setTimeout(async () => {
      try {
        const result = await api.search(
          workspace,
          query,
          sensitive,
          tabs.filter((t) => t.path).map((t) => ({ path: t.path, content: t.content })),
        );
        if (id !== token) return;
        if (!result.cancelled) hits = result.hits;
        message = `${result.truncated ? '仅显示前 500 个匹配，请缩小搜索范围。' : ''}${result.skipped ? `跳过 ${result.skipped} 个无法读取的文件。` : ''}`;
      } catch (e) {
        if (id === token) message = String(e);
      } finally {
        if (id === token) loading = false;
      }
    }, 250);
  }
  $: {
    workspace;
    schedule();
  }
  onDestroy(() => {
    token++;
    clearTimeout(timer);
    if (desktop) void api.cancelSearch();
  });
</script>

<section class="workspace-search" aria-label="搜索工作区">
  <label for="workspace-query">搜索工作区正文</label>
  <input
    id="workspace-query"
    bind:value={query}
    on:input={schedule}
    on:compositionstart={() => {
      composing = true;
      clearTimeout(timer);
      token++;
    }}
    on:compositionend={() => {
      composing = false;
      schedule();
    }}
    placeholder="输入要查找的内容…"
  />
  <label><input type="checkbox" bind:checked={sensitive} on:change={schedule} />区分大小写</label>
  <p role="status">
    {!workspace ? '请先打开文件夹' : loading ? '正在搜索…' : `${hits.length} 个匹配`}
  </p>
  {#if message}<p role="status">{message}</p>{/if}
  {#each hits as hit}<button class="workspace-hit" on:click={() => onopen(hit)}
      ><strong>{hit.path.replace(workspace, '').replace(/^[\\/]/, '')}:{hit.line}</strong><span
        >{hit.snippet}</span
      ></button
    >{/each}
</section>
