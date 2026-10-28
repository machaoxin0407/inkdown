<script lang="ts">
  import { onMount } from 'svelte';
  import { modalFocus } from './lib/focus';
  import { pdfPreferences, paperSize, type PdfPreferences } from './lib/preferences';
  import type { PreparedPdf } from './lib/pdf';
  export let prepared: PreparedPdf;
  export let initial: PdfPreferences;
  export let onchoose: (options: PdfPreferences | null) => void;
  let options = { ...initial };
  let host: HTMLDivElement;
  $: normalized = pdfPreferences(options);
  $: dimensions = paperSize(normalized);
  $: prepared.configure(normalized);
  onMount(() => prepared.mount(host));
</script>
<div class="feature-overlay">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="feature-dialog pdf-preview-dialog" role="dialog" aria-modal="true" aria-label="PDF 导出预览" tabindex="-1" use:modalFocus on:keydown={(e) => { if(e.key === 'Escape') { e.stopPropagation(); onchoose(null); } }}>
    <header><h2>PDF 导出预览</h2><button aria-label="关闭 PDF 预览" on:click={() => onchoose(null)}>×</button></header>
    <p>轻量排版预览；最终分页和原生页码以导出 PDF 为准。使用打开预览时的正文快照。</p>
    <div class="pdf-preview-options">
      <label>纸张<select bind:value={options.paper}><option>A4</option><option>Letter</option></select></label>
      <label><input type="checkbox" bind:checked={options.landscape} />横向</label>
      <label><input type="checkbox" bind:checked={options.pageNumbers} />页码</label>
      {#each ['top','right','bottom','left'] as side, i}<label>{['上','右','下','左'][i]}边距（mm）<input type="number" min="5" max="50" bind:value={options[side as 'top']} /></label>{/each}
    </div>
    {#if prepared.issues.length}<div class="pdf-issues" role="alert"><strong>{prepared.issues.length} 个资源问题</strong>{#each prepared.issues as issue}<p>第 {issue.line} 行 · {issue.message} · {issue.reference.slice(0,160)}</p>{/each}</div>{/if}
    <div class="pdf-preview-scroll"><div class="pdf-paper" style={`width:${dimensions[0]}mm; min-height:${dimensions[1]}mm; padding:${normalized.top}mm ${normalized.right}mm ${normalized.bottom}mm ${normalized.left}mm`} bind:this={host}></div></div>
    <footer><button on:click={() => onchoose(null)}>{prepared.issues.length ? '返回修复' : '取消'}</button><button class="primary" on:click={() => onchoose(normalized)}>{prepared.issues.length ? '仍然导出' : '确认导出'}</button></footer>
  </div>
</div>
