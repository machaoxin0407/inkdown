<script lang="ts">
  import { ChevronRight, ChevronDown, Folder, FileText, LoaderCircle } from 'lucide-svelte';
  import { api } from './lib/api';
  import type { Entry } from './lib/types';
  import { pathKey } from './lib/types';
  export let entries: Entry[] = [];
  export let activePath = '';
  export let depth = 0;
  export let onopen: (path: string) => void;
  export let onerror: (error: unknown) => void;
  export let expanded: Record<string, Entry[]> = {};
  export let opened: string[] = [];
  export let limits: Record<string, number> = {};
  export let directory = '';
  export let onstate: () => void = () => {};
  export let onaction: (action: string, entry: Entry) => void = () => {};
  let limit = 150;
  const pending = new Set<string>();
  $: limit = limits[directory] || 150;
  $: for (const entry of entries)
    if (
      entry.directory &&
      opened.includes(entry.path) &&
      !expanded[entry.path] &&
      !pending.has(entry.path)
    )
      void toggle(entry);
  let loading = '';
  async function toggle(entry: Entry) {
    if (expanded[entry.path]) {
      const next = { ...expanded };
      delete next[entry.path];
      expanded = next;
      opened = opened.filter((path) => path !== entry.path);
      onstate();
      return;
    }
    if (pending.has(entry.path)) return;
    pending.add(entry.path);
    loading = entry.path;
    try {
      const children = await api.list(entry.path);
      expanded = { ...expanded, [entry.path]: children };
      if (!opened.includes(entry.path)) opened = [...opened, entry.path];
      onstate();
    } catch (e) {
      onerror(e);
    } finally {
      pending.delete(entry.path);
      loading = '';
    }
  }
</script>

{#each entries.slice(0, limit) as entry (entry.path)}
  <div class="tree-item">
    <button
      class="tree-row"
      class:selected={pathKey(entry.path) === pathKey(activePath)}
      style:padding-left={`${14 + depth * 14}px`}
      title={entry.path}
      aria-expanded={entry.directory ? !!expanded[entry.path] : undefined}
      on:click={() => (entry.directory ? toggle(entry) : onopen(entry.path))}
    >
      {#if entry.directory}{#if loading === entry.path}<LoaderCircle
            size={13}
            class="spin"
          />{:else if expanded[entry.path]}<ChevronDown size={13} />{:else}<ChevronRight
            size={13}
          />{/if}<Folder size={15} />{:else}<span class="tree-indent"></span><FileText
          size={15}
        />{/if}
      <span class="truncate">{entry.name}</span>
    </button>
    <details class="tree-actions">
      <summary aria-label={`操作 ${entry.name}`}>⋯</summary>
      <div class="tree-action-menu">
        {#if entry.directory}<button on:click={() => onaction('new', entry)}>新建文档</button
          ><button on:click={() => onaction('folder', entry)}>新建文件夹</button>{:else}<button
            on:click={() => onaction('rename', entry)}>重命名</button
          >{/if}
        <button on:click={() => onaction('reveal', entry)}>在资源管理器中定位</button>
      </div>
    </details>
  </div>
  {#if entry.directory && expanded[entry.path]}
    <svelte:self
      entries={expanded[entry.path]}
      {activePath}
      depth={depth + 1}
      {onopen}
      {onerror}
      bind:expanded
      bind:opened
      bind:limits
      directory={entry.path}
      {onstate}
      {onaction}
    />
    {#if !expanded[entry.path].length}<p
        class="tree-empty"
        style:padding-left={`${42 + depth * 14}px`}
      >
        没有 Markdown 文件
      </p>{/if}
  {/if}
{/each}
{#if entries.length > limit}<button
    class="tree-more"
    on:click={() => {
      limits = { ...limits, [directory]: limit + 150 };
    }}>显示更多（剩余 {entries.length - limit}）</button
  >{/if}
