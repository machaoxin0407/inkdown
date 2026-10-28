<script lang="ts">
  import { onMount } from 'svelte';
  import type { SourceScroll } from './lib/scroll-sync';
  export let id: string;
  export let onpasteimage: (file: File) => Promise<unknown> | void = () => {};
  export let content: string;
  export let zoom = 100;
  export let position: { cursor: number; editorLine: number } | undefined = undefined;
  export let onposition: (cursor: number, line: number) => void = () => {};
  export let onpending: (bytes: number, owner: string) => void = () => {};
  export let onchange: (value: string, owner: string) => void;
  export let onscroll: (position: SourceScroll) => void;
  let host: HTMLDivElement;
  let editor: ReturnType<typeof import('./lib/editor').createEditor> | undefined;
  $: editor?.setZoom(zoom);
  export function flush() { editor?.flush(); }
  export function find() {
    editor?.find();
  }
  export let selection: { from: number; to: number; nonce: number } | undefined = undefined;
  $: if (editor && selection) editor.select(selection.from, selection.to);
  export function insert(text: string) {
    editor?.insert(text);
  }
  export function selected() {
    return editor?.selected() || '';
  }
  onMount(() => {
    let cancelled = false;
    import('./lib/editor').then(({ createEditor }) => {
      if (cancelled) return;
      editor = createEditor(host, id, content, (value) => onchange(value, id), onscroll, position, onposition, (bytes) => onpending(bytes, id));
      editor.focus();
    });
    return () => {
      cancelled = true;
      editor?.destroy();
    };
  });
</script>

<div
  class="editor-host"
  role="region"
  aria-label="Markdown 编辑器"
  bind:this={host}
  on:dragover={(event) => { if ([...(event.dataTransfer?.items || [])].some(i => i.type.startsWith('image/'))) event.preventDefault(); }}
  on:drop={async (event) => {
    const files = [...(event.dataTransfer?.files || [])].filter(file => file.type.startsWith('image/'));
    if (files.length) { event.preventDefault(); event.stopPropagation(); for (const file of files) await onpasteimage(file); }
  }}
  on:paste={(event) => {
    const file = [...(event.clipboardData?.files || [])].find((file) =>
      file.type.startsWith('image/'),
    );
    if (file) {
      event.preventDefault();
      event.stopPropagation();
      onpasteimage(file);
    }
  }}
></div>
