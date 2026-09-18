<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { parse, enhance } from './lib/render';
  import type { Heading } from './lib/types';
  import { previewScrollTop, type SourceScroll, type ScrollAnchor } from './lib/scroll-sync';
  export let content: string;
  export let path = '';
  export let dark = false;
  export let zoom = 100;
  export let syncEnabled = false;
  export let scroll = 0;
  export let onscroll: (position: number) => void;
  export let onheadings: (headings: Heading[]) => void;
  export let onlink: (href: string) => void;
  let host: HTMLDivElement;
  let article: HTMLElement;
  let generation = 0;
  let busy = false;
  let error = '';
  let timer: ReturnType<typeof setTimeout>;
  let initial = true;
  let findText = '';
  let showFind = false;
  let findInput: HTMLInputElement;
  let matches: HTMLElement[] = [];
  let matchIndex = -1;
  let editorPosition: SourceScroll | null = null;
  let renderedSource: string | null = null;
  let scrollAnchors: ScrollAnchor[] = [];
  let layoutFrame = 0;
  export function syncFromEditor(position: SourceScroll) {
    if (!syncEnabled) return;
    editorPosition = position;
    applyEditorScroll();
  }
  function applyEditorScroll() {
    if (!syncEnabled || !editorPosition || !host || renderedSource !== content) return;
    host.scrollTop = previewScrollTop(
      editorPosition,
      scrollAnchors,
      host.scrollHeight - host.clientHeight,
    );
  }
  function refreshAnchors() {
    if (!article || !host || renderedSource === null) return;
    const origin = host.getBoundingClientRect().top - host.scrollTop;
    const points = [...article.querySelectorAll<HTMLElement>('[data-source-line]')]
      .map((el) => ({
        line: Number(el.dataset.sourceLine),
        top: el.getBoundingClientRect().top - origin,
      }))
      .sort((a, b) => a.line - b.line || a.top - b.top)
      .filter((point, i, all) => i === 0 || point.line !== all[i - 1].line);
    points.push({
      line: renderedSource.split('\n').length,
      top: article.getBoundingClientRect().bottom - origin,
    });
    scrollAnchors = points;
    applyEditorScroll();
  }
  onMount(() => {
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(layoutFrame);
      layoutFrame = requestAnimationFrame(refreshAnchors);
    });
    observer.observe(article);
    observer.observe(host);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(layoutFrame);
    };
  });
  $: if (!syncEnabled) editorPosition = null;
  // Write through a local parameter: assigning article.innerHTML directly makes
  // Svelte invalidate the bound element and retrigger its own render effect.
  function installMarkup(target: HTMLElement, html: string) {
    target.innerHTML = html;
  }
  export function jump(id: string) {
    article?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
  }
  export function find() {
    showFind = true;
    setTimeout(() => findInput?.focus());
  }
  export function anchor(name: string) {
    const heading = [...article.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].find(
      (el) =>
        el.id === name ||
        el.textContent?.trim().replace(/\s+/g, '-').toLowerCase() === name.toLowerCase(),
    );
    heading?.scrollIntoView({ block: 'start' });
  }
  function clearMarks() {
    article
      ?.querySelectorAll('mark.search-hit')
      .forEach((el) => el.replaceWith(document.createTextNode(el.textContent || '')));
    article?.normalize();
    matches = [];
    matchIndex = -1;
  }
  function searchText() {
    clearMarks();
    if (!findText || !article) return;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest('svg,math,.katex,.diagram-source')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const nodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) nodes.push(node as Text);
    for (const text of nodes) {
      const value = text.data,
        lower = value.toLocaleLowerCase(),
        query = findText.toLocaleLowerCase();
      let pos = 0,
        idx = lower.indexOf(query);
      if (idx < 0) continue;
      const fragment = document.createDocumentFragment();
      while (idx >= 0) {
        fragment.append(value.slice(pos, idx));
        const mark = document.createElement('mark');
        mark.className = 'search-hit';
        mark.textContent = value.slice(idx, idx + query.length);
        fragment.append(mark);
        matches.push(mark);
        pos = idx + query.length;
        idx = lower.indexOf(query, pos);
      }
      fragment.append(value.slice(pos));
      text.replaceWith(fragment);
    }
    nextMatch(1);
  }
  function nextMatch(direction: number) {
    if (!matches.length) return;
    matches[matchIndex]?.classList.remove('current');
    matchIndex = (matchIndex + direction + matches.length) % matches.length;
    const mark = matches[matchIndex];
    mark.classList.add('current');
    mark.scrollIntoView({ block: 'center' });
  }
  function schedule(source: string, file: string, isDark: boolean) {
    const token = ++generation;
    clearTimeout(timer);
    timer = setTimeout(
      async () => {
        busy = true;
        error = '';
        try {
          const parsed = await parse(source);
          if (token !== generation || !article) return;
          const position = initial ? scroll : host.scrollTop;
          installMarkup(article, parsed.html);
          renderedSource = source;
          onheadings(parsed.headings);
          host.scrollTop = position;
          initial = false;
          refreshAnchors();
          await enhance(article, file, isDark, () => token === generation);
          if (token === generation) {
            if (findText) searchText();
            if (position && host.scrollTop === 0) host.scrollTop = position;
            refreshAnchors();
          }
        } catch (e) {
          if (token === generation) error = String(e);
        } finally {
          if (token === generation) busy = false;
        }
      },
      initial ? 0 : source.length > 300000 ? 450 : 180,
    );
  }
  $: if (article) schedule(content, path, dark);
  onDestroy(() => {
    generation++;
    clearTimeout(timer);
  });
  function click(event: MouseEvent) {
    const link = (event.target as Element).closest('a');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href');
    if (href?.startsWith('#')) anchor(decodeURIComponent(href.slice(1)));
    else if (href) onlink(href);
  }
</script>

<section class="preview-panel" aria-label="阅读预览">
  {#if showFind}<div class="preview-find">
      <input
        aria-label="在文档中查找"
        placeholder="查找文档…"
        bind:this={findInput}
        bind:value={findText}
        on:input={searchText}
        on:keydown={(e) => {
          if (e.key === 'Enter') nextMatch(e.shiftKey ? -1 : 1);
          if (e.key === 'Escape') {
            showFind = false;
            clearMarks();
          }
        }}
      /><span>{matches.length ? matchIndex + 1 : 0}/{matches.length}</span><button
        on:click={() => nextMatch(-1)}
        aria-label="上一个结果">↑</button
      ><button on:click={() => nextMatch(1)} aria-label="下一个结果">↓</button><button
        on:click={() => {
          showFind = false;
          clearMarks();
        }}
        aria-label="关闭查找">×</button
      >
    </div>{/if}
  {#if busy}<div class="render-progress" aria-label="正在排版"></div>{/if}
  {#if error}<div class="error-inline" role="alert">{error}</div>{/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="preview-scroll"
    bind:this={host}
    on:scroll={() => onscroll(host.scrollTop)}
    on:click={click}
  >
    <article class="prose" style={`zoom: ${zoom / 100}`} bind:this={article}></article>
    <div class="document-end"><span></span> 墨页 <span></span></div>
  </div>
</section>
