<script lang="ts">
  import type { Draft } from './lib/local-state';
  import { modalFocus } from './lib/focus';
  export let drafts: Draft[];
  export let busy = false;
  export let onrestore: (ids: string[]) => void;
  export let ondiscard: (ids: string[]) => void;
  export let onclose: () => void;
  let selected = drafts.map((d) => d.id),
    confirming = false;
</script>

<div class="feature-overlay">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    tabindex="-1"
    class="feature-dialog"
    role="dialog"
    aria-modal="true"
    aria-label="恢复未保存的草稿"
    use:modalFocus
    on:keydown={(e) => {
      if (e.key === 'Escape' && !busy) onclose();
      if (e.key !== 'Tab') e.stopPropagation();
    }}
  >
    <header>
      <h2>恢复未保存的草稿</h2>
      <button aria-label="稍后处理草稿" disabled={busy} on:click={onclose}>×</button>
    </header>
    <p class="feature-note">草稿保存在本机。恢复后可检查内容，再决定是否保存到原文件。</p>
    <div class="draft-list">
      {#each drafts as draft}<label class="draft-row"
          ><input type="checkbox" value={draft.id} bind:group={selected} disabled={busy} /><span
            ><strong>{draft.name}</strong><small>{draft.path || '未命名文档'}</small><small
              >{new Date(draft.updatedAt).toLocaleString('zh-CN')}</small
            ></span
          ></label
        >{/each}
      {#if !drafts.length}<p>没有待恢复的草稿。</p>{/if}
    </div>
    {#if confirming}<p role="alert">
        确定永久丢弃选中的 {selected.length} 份草稿？原文件不会改变。
      </p>{/if}
    <footer>
      <button disabled={busy} on:click={onclose}>稍后处理</button><button
        disabled={busy || !selected.length}
        on:click={() => {
          if (confirming) {
            ondiscard(selected);
            confirming = false;
          } else confirming = true;
        }}>{confirming ? '确认丢弃' : '丢弃所选'}</button
      ><button
        class="primary"
        disabled={busy || !selected.length}
        on:click={() => onrestore(selected)}>恢复所选</button
      >
    </footer>
  </div>
</div>
