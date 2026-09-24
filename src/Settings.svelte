<script lang="ts">
  import { modalFocus } from './lib/focus';
  import {
    readingDefaults,
    pdfDefaults,
    readingPreferences,
    pdfPreferences,
    type ReadingPreferences,
    type PdfPreferences,
  } from './lib/preferences';
  export let reading: ReadingPreferences;
  export let pdf: PdfPreferences;
  export let onclose: () => void;
  export let onsave: (reading: ReadingPreferences, pdf: PdfPreferences) => void;
  let r = { ...reading },
    p = { ...pdf };
</script>

<div class="feature-overlay">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    tabindex="-1"
    class="feature-dialog settings-dialog"
    role="dialog"
    aria-modal="true"
    aria-label="设置"
    use:modalFocus
    on:keydown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onclose();
      }
    }}
  >
    <form on:submit|preventDefault={() => onsave(readingPreferences(r), pdfPreferences(p))}>
      <header>
        <h2>设置</h2>
        <button type="button" aria-label="关闭设置" on:click={onclose}>×</button>
      </header>
      <fieldset>
        <legend>阅读</legend>
        <label
          >字体<select aria-label="字体" bind:value={r.font}
            ><option value="sans">系统无衬线</option><option value="serif">衬线</option><option
              value="mono">等宽</option
            ></select
          ></label
        >
        <label
          >字号（px）<input type="number" min="14" max="24" required bind:value={r.size} /></label
        >
        <label
          >行距<input
            type="number"
            min="1.4"
            max="2.2"
            step="0.1"
            required
            bind:value={r.lineHeight}
          /></label
        >
        <label
          >正文宽度（px）<input
            type="number"
            min="640"
            max="1200"
            step="10"
            required
            bind:value={r.width}
          /></label
        >
      </fieldset>
      <fieldset>
        <legend>PDF 导出</legend>
        <label
          >纸张<select aria-label="纸张" bind:value={p.paper}
            ><option>A4</option><option>Letter</option></select
          ></label
        >
        <label><input type="checkbox" bind:checked={p.landscape} />横向</label>
        {#each [['top', '上'], ['right', '右'], ['bottom', '下'], ['left', '左']] as [key, label]}<label
            >{label}页边距（mm）<input
              type="number"
              min="5"
              max="50"
              required
              value={p[key as 'top']}
              on:input={(e) => (p = { ...p, [key]: e.currentTarget.valueAsNumber })}
            /></label
          >{/each}
        <label><input type="checkbox" bind:checked={p.pageNumbers} />显示页码（原生页眉页脚）</label
        >
      </fieldset>
      <footer>
        <button
          type="button"
          on:click={() => {
            r = { ...readingDefaults };
            p = { ...pdfDefaults };
          }}>恢复默认</button
        ><button class="primary" type="submit">保存设置</button>
      </footer>
    </form>
  </div>
</div>
