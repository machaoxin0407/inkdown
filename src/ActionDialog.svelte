<script lang="ts">
  import { modalFocus } from './lib/focus';
  export let title: string;
  export let note = '';
  export let fields: {
    key: string;
    label: string;
    value: string;
    type?: string;
    min?: number;
    max?: number;
  }[];
  export let onsubmit: (values: Record<string, string>) => void;
  export let onclose: () => void;
</script>

<div class="feature-overlay">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    tabindex="-1"
    class="feature-dialog settings-dialog"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    use:modalFocus
    on:keydown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onclose();
      }
    }}
  >
    <form
      on:submit|preventDefault={() =>
        onsubmit(Object.fromEntries(fields.map((f) => [f.key, f.value])))}
    >
      <header>
        <h2>{title}</h2>
        <button type="button" on:click={onclose} aria-label="关闭">×</button>
      </header>
      {#if note}<p>{note}</p>{/if}
      {#each fields as field}<label
          >{field.label}<input
            type={field.type || 'text'}
            value={field.value}
            on:input={(e) => (field.value = e.currentTarget.value)}
            min={field.min}
            max={field.max}
            required
          /></label
        >{/each}
      <footer>
        <button type="button" on:click={onclose}>取消</button><button class="primary" type="submit"
          >确定</button
        >
      </footer>
    </form>
  </div>
</div>
