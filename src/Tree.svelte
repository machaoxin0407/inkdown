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
  let expanded: Record<string, Entry[]> = {};
  let loading = '';
  let limit = 150;
  async function toggle(entry: Entry) {
    if (expanded[entry.path]) {
      const next = { ...expanded };
      delete next[entry.path];
      expanded = next;
      return;
    }
    loading = entry.path;
    try {
      expanded = { ...expanded, [entry.path]: await api.list(entry.path) };
    } catch (e) {
      onerror(e);
    } finally {
      loading = '';
    }
  }
</script>

{#each entries.slice(0, limit) as entry (entry.path)}
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
  {#if entry.directory && expanded[entry.path]}
    <svelte:self entries={expanded[entry.path]} {activePath} depth={depth + 1} {onopen} {onerror} />
    {#if !expanded[entry.path].length}<p
        class="tree-empty"
        style:padding-left={`${42 + depth * 14}px`}
      >
        没有 Markdown 文件
      </p>{/if}
  {/if}
{/each}
{#if entries.length > limit}<button class="tree-more" on:click={() => (limit += 150)}
    >显示更多（剩余 {entries.length - limit}）</button
  >{/if}
