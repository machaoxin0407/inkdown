<script lang="ts">
  import { onMount } from 'svelte';
  import { modalFocus } from './lib/focus';
  import type { LineDiff } from './lib/diff';
  export let left: string;
  export let right: string;
  export let name: string;
  export let onchoose: (choice: string) => void;
  let leftHost: HTMLDivElement, rightHost: HTMLDivElement;
  let status = '正在比较…';
  onMount(() => {
    let disposed = false, shown = false;
    const worker = new Worker(new URL('./lib/diff.worker.ts', import.meta.url), { type: 'module' });
    let cleanup: (() => void)[] = [];
    async function show(diff?: LineDiff, message = '') {
      if (shown || disposed) return;
      shown = true; clearTimeout(timeout); worker.terminate();
      const { readOnlyDiff } = await import('./lib/diff-view');
      if (disposed) return;
      cleanup = [readOnlyDiff(leftHost, left, diff?.left || [], 'diff-remove'), readOnlyDiff(rightHost, right, diff?.right || [], 'diff-add')];
      status = message || `当前版本 ${diff?.left.length || 0} 行变化 · 磁盘版本 ${diff?.right.length || 0} 行变化`;
    }
    const timeout = setTimeout(() => void show(undefined, '差异计算超时，显示完整双栏'), 2000);
    worker.onmessage = ({ data }) => void show(data.diff, data.error);
    worker.onerror = () => void show(undefined, '差异计算失败，显示完整双栏');
    worker.postMessage({ left, right });
    return () => { disposed = true; clearTimeout(timeout); worker.terminate(); cleanup.forEach((fn) => fn()); };
  });
</script>
<div class="feature-overlay">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="feature-dialog compare-dialog" role="dialog" aria-modal="true" aria-label="比较版本" tabindex="-1" use:modalFocus on:keydown={(e) => { if(e.key === 'Escape') { e.stopPropagation(); onchoose('cancel'); } }}>
    <header><h2>比较版本 · {name}</h2><button on:click={() => onchoose('cancel')} aria-label="关闭比较">×</button></header>
    <p role="status">{status}</p>
    <div class="compare-columns"><section><h3>当前编辑</h3><div class="compare-editor" bind:this={leftHost}></div></section><section><h3>磁盘版本</h3><div class="compare-editor" bind:this={rightHost}></div></section></div>
    <footer><button on:click={() => onchoose('cancel')}>取消</button><button on:click={() => onchoose('reload')}>重新加载</button><button on:click={() => onchoose('saveAs')}>另存为</button><button on:click={() => onchoose('overwrite')}>覆盖磁盘版本</button></footer>
  </div>
</div>
