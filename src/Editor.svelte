<script lang="ts">
  import { onMount } from 'svelte';
  import type { SourceScroll } from './lib/scroll-sync';
  export let id: string;
  export let content: string;
  export let onchange: (value: string) => void;
  export let onscroll: (position: SourceScroll) => void;
  let host: HTMLDivElement;
  let editor: ReturnType<typeof import('./lib/editor').createEditor> | undefined;
  export function find() {
    editor?.find();
  }
  onMount(() => {
    let cancelled = false;
    import('./lib/editor').then(({ createEditor }) => {
      if (cancelled) return;
      editor = createEditor(host, id, content, onchange, onscroll);
      editor.focus();
    });
    return () => {
      cancelled = true;
      editor?.destroy();
    };
  });
</script>

<div class="editor-host" bind:this={host}></div>
