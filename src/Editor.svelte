<script lang="ts">
  import { onMount } from 'svelte';
  import type { SourceScroll } from './lib/scroll-sync';
  export let id: string;
  export let content: string;
  export let zoom = 100;
  export let position: { cursor: number; editorLine: number } | undefined = undefined;
  export let onposition: (cursor: number, line: number) => void = () => {};
  export let onchange: (value: string) => void;
  export let onscroll: (position: SourceScroll) => void;
  let host: HTMLDivElement;
  let editor: ReturnType<typeof import('./lib/editor').createEditor> | undefined;
  $: editor?.setZoom(zoom);
  export function find() {
    editor?.find();
  }
  onMount(() => {
    let cancelled = false;
    import('./lib/editor').then(({ createEditor }) => {
      if (cancelled) return;
      editor = createEditor(host, id, content, onchange, onscroll, position, onposition);
      editor.focus();
    });
    return () => {
      cancelled = true;
      editor?.destroy();
    };
  });
</script>

<div class="editor-host" bind:this={host}></div>
