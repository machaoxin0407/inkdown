<script lang="ts">
  import type { Heading } from './lib/types';
  export let headings: Heading[];
  export let line = 0;
  export let onjump: (id: string) => void;
  let query = '',
    collapsed = new Set<string>();
  $: current = [...headings].reverse().find((h) => (h.line || 0) <= line)?.id;
  $: visible = headings.filter((h, i) => {
    if (query) {
      if (h.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return true;
      for (let j = i + 1; j < headings.length && headings[j].level > h.level; j++)
        if (headings[j].text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return true;
      return false;
    }
    let level = h.level;
    for (let j = i - 1; j >= 0; j--)
      if (headings[j].level < level) {
        if (collapsed.has(headings[j].id)) return false;
        level = headings[j].level;
      }
    return true;
  });
  function toggle(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }
</script>

<div class="section-label">文档大纲 <span>{headings.length}</span></div>
<input class="outline-filter" aria-label="过滤标题" placeholder="过滤标题…" bind:value={query} />
{#each visible as heading}
  <div class="outline-item" style:padding-left={`${8 + (heading.level - 1) * 10}px`}>
    <button
      class="outline-fold"
      aria-label={`折叠或展开 ${heading.text}`}
      aria-expanded={!collapsed.has(heading.id)}
      on:click={() => toggle(heading.id)}>{collapsed.has(heading.id) ? '›' : '⌄'}</button
    >
    <button
      class="outline-row"
      class:chosen={current === heading.id}
      aria-current={current === heading.id ? 'location' : undefined}
      on:click={() => onjump(heading.id)}>{heading.text}</button
    >
  </div>
{/each}
{#if !visible.length}<p class="side-hint">
    {query ? '没有匹配的标题' : '文档中的标题会显示在这里。'}
  </p>{/if}
