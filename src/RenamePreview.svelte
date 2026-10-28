<script lang="ts">
  import { modalFocus } from './lib/focus';
  import type { RenamePlan, RenameResult } from './lib/rename';
  export let plan: RenamePlan;
  export let result: RenameResult | undefined = undefined;
  export let loading = false;
  export let onapply: (selected: string[]) => void;
  export let onrescan: () => void;
  export let onclose: () => void;
  let selected: string[] = [];
  let previous: RenamePlan;
  $: if(plan !== previous) { previous = plan; selected = plan.proposals.map((p) => p.document.path); }
  $: failures = result?.files.filter((f) => ['conflict','failed'].includes(f.status)) || [];
</script>
<div class="feature-overlay">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="feature-dialog rename-dialog" role="dialog" aria-modal="true" aria-label="重命名引用预览" tabindex="-1" use:modalFocus on:keydown={(e) => { if(e.key==='Escape' && !loading) { e.stopPropagation(); onclose(); } }}>
    <header><h2>{result?.renamed ? '引用更新结果' : '重命名引用预览'} · {plan.name}</h2><button disabled={loading} aria-label="关闭重命名预览" on:click={onclose}>×</button></header>
    <p>仅更新工作区内指向此文档的标准 Markdown 链接。未保存文档只更新编辑内容；代码和图片不参与。多个文件分别保存。</p>
    {#each plan.warnings as warning}<p class="rename-warning">{warning}</p>{/each}
    <div class="rename-files">
      {#each plan.proposals as proposal}<details open={plan.proposals.length===1}>
        <summary><label><input type="checkbox" value={proposal.document.path} bind:group={selected} disabled={loading || !!result} />{proposal.document.path} · {proposal.edits.length} 处{proposal.buffered ? ' · 未保存文档' : ''}</label></summary>
        {#each proposal.edits as edit}<div class="reference-diff"><del>{proposal.document.content.slice(edit.from,edit.to)}</del><ins>{edit.insert}</ins></div>{/each}
      </details>{/each}
      {#if !plan.proposals.length}<p>没有发现需要更新的引用。</p>{/if}
      {#if result}<p>{result.renamed ? '文档已重命名' : '校验失败，文档尚未重命名'}</p>{#each result.files as file}<p class:rename-warning={['conflict','failed'].includes(file.status)}>{file.path} · {file.message}</p>{/each}{/if}
    </div>
    <footer>{#if loading}<span role="status">正在处理…</span>{/if}
      <button disabled={loading} on:click={onclose}>{result ? '关闭' : '取消'}</button>
      {#if failures.length}<button disabled={loading} on:click={onrescan}>重新扫描失败项</button>{/if}
      {#if !result}<button disabled={loading} on:click={() => onapply([])}>{plan.expected ? '仅重命名' : '跳过引用更新'}</button><button class="primary" disabled={loading || !selected.length} on:click={() => onapply(selected)}>{plan.expected ? '重命名并更新选中引用' : '应用引用更新'}</button>{/if}
    </footer>
  </div>
</div>
