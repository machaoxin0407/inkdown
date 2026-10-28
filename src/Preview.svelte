<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { markReadingMatches } from './lib/reading-search';
  import { api } from './lib/api';
  import { reconcileMarkup } from './lib/markup';
  import { parse, enhance, cancelParse, disposeEnhancements } from './lib/render';
  import { readingDefaults, fonts, type ReadingPreferences } from './lib/preferences';
  import type { Heading } from './lib/types';
  import {
    previewScrollTop,
    sourcePosition,
    type SourceScroll,
    type ScrollAnchor,
  } from './lib/scroll-sync';
  export let content: string;
  export let stale = false;
  export let ontask: (offset: number, checked: boolean, source: string) => void = () => {};
  export let reading: ReadingPreferences = readingDefaults;
  export let path = '';
  export let dark = false;
  export let zoom = 100;
  export let syncEnabled = false;
  export let scroll = 0;
  export let location: SourceScroll | undefined = undefined;
  export let onposition: (position: SourceScroll) => void = () => {};
  export let onerror: (error: unknown) => void = () => {};
  let restoring = true;
  let reloadedLocation: SourceScroll | undefined;
  export function positionNow(position: SourceScroll) { restoring = false; host.scrollTop = previewScrollTop(position, scrollAnchors, host.scrollHeight - host.clientHeight); }
  export function restorePosition(position: SourceScroll) {
    reloadedLocation = position;
  }
  let pendingAnchor = '';
  let anchorLocked = false;
  const initialLocation = location;
  function userScroll() {
    restoring = false;
  }
  function reportScroll() {
    onscroll(host.scrollTop);
    if (!restoring && renderedSource === content)
      onposition(
        sourcePosition(host.scrollTop, scrollAnchors, host.scrollHeight - host.clientHeight),
      );
  }
  function addCopyButtons() {
    for (const pre of article.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      if (!code || pre.querySelector('.copy-code') || pre.closest('.diagram-source')) continue;
      const text = code.textContent || '';
      const button = document.createElement('button');
      button.className = 'copy-code';
      button.type = 'button';
      button.textContent = '复制';
      button.setAttribute('aria-label', '复制代码');
      button.addEventListener('click', async () => {
        try {
          await api.copy(text);
          button.textContent = '已复制';
          setTimeout(() => {
            button.textContent = '复制';
          }, 1800);
        } catch (e) {
          button.textContent = '复制失败';
          onerror('无法写入剪贴板，请重试：' + String(e));
        }
      });
      pre.append(button);
    }
  }
  export let onscroll: (position: number) => void;
  export let onheadings: (headings: Heading[]) => void;
  export let onanchor: (name: string) => void = (name) => anchor(name);
  export let onlink: (href: string) => void;
  let host: HTMLDivElement;
  let article: HTMLElement;
  const owner = crypto.randomUUID();
  let generation = 0;
  let busy = false;
  let error = '';
  let timer: ReturnType<typeof setTimeout>;
  let initial = true;
  let findText = '';
  let showFind = false;
  let findInput: HTMLInputElement;
  let matches: HTMLElement[][] = [];
  let caseSensitive = false;
  let composing = false;
  let searchTimer: ReturnType<typeof setTimeout>;
  let previousFocus: HTMLElement | null = null;
  function scheduleSearch() {
    clearTimeout(searchTimer);
    if (!composing && showFind) searchTimer = setTimeout(searchText, 150);
  }
  function closeFind() {
    clearTimeout(searchTimer);
    showFind = false;
    clearMarks();
    previousFocus?.focus();
  }
  let matchIndex = -1;
  let editorPosition: SourceScroll | null = null;
  let renderedSource: string | null = null;
  let scrollAnchors: ScrollAnchor[] = [];
  let layoutFrame = 0;
  export function syncFromEditor(position: SourceScroll) {
    if (!syncEnabled || anchorLocked) return;
    restoring = false;
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
    if (restoring && initialLocation && !syncEnabled)
      host.scrollTop = previewScrollTop(
        initialLocation,
        scrollAnchors,
        host.scrollHeight - host.clientHeight,
      );
    applyEditorScroll();
  }
  onMount(() => {
    const resumeSync = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.editor-host'))
        anchorLocked = false;
    };
    for (const type of ['wheel', 'pointerdown', 'keydown'])
      window.addEventListener(type, resumeSync, true);
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(layoutFrame);
      layoutFrame = requestAnimationFrame(refreshAnchors);
    });
    observer.observe(article);
    observer.observe(host);
    return () => {
      for (const type of ['wheel', 'pointerdown', 'keydown'])
        window.removeEventListener(type, resumeSync, true);
      observer.disconnect();
      cancelAnimationFrame(layoutFrame);
    };
  });
  $: if (!syncEnabled) editorPosition = null;
  // Write through a local parameter: assigning article.innerHTML directly makes
  // Svelte invalidate the bound element and retrigger its own render effect.

  export function refreshImages(paths: string[]) {
    for (const el of article.querySelectorAll<HTMLElement>('[data-image]')) {
      const base = path.replace(/[^\\/]+$/, '').replace(/\\/g, '/');
      let resolved = '';
      try {
        resolved = decodeURIComponent(
          new URL(decodeURIComponent(el.dataset.image || ''), 'file:///' + base).pathname,
        ).toLowerCase();
      } catch {}
      if (paths.some((p) => resolved.endsWith(p.replace(/\\/g, '/').toLowerCase()))) {
        delete el.dataset.enhanced;
        el.replaceChildren();
      }
    }
    void enhance(article, path, dark, () => article.isConnected);
  }
  export function jump(id: string) {
    anchorLocked = true;
    editorPosition = null;
    restoring = false;
    article?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
  }
  export function find() {
    previousFocus = document.activeElement as HTMLElement;
    showFind = true;
    setTimeout(() => {
      findInput?.focus();
      searchText();
    });
  }
  export function anchor(name: string) {
    anchorLocked = true;
    editorPosition = null;
    restoring = false;
    pendingAnchor = name;
    const heading = [...article.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].find(
      (el) =>
        el.id === name ||
        el.textContent?.trim().replace(/\s+/g, '-').toLowerCase() === name.toLowerCase(),
    );
    heading?.scrollIntoView({ block: 'start' });
    if (heading && renderedSource === content) pendingAnchor = '';
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
    restoring = false;
    clearMarks();
    if (!showFind || !findText || !article) return;
    matches = markReadingMatches(article, findText, caseSensitive);
    nextMatch(1);
  }
  function nextMatch(direction: number) {
    if (!matches.length) return;
    matches[matchIndex]?.forEach((mark) => mark.classList.remove('current'));
    matchIndex = (matchIndex + direction + matches.length) % matches.length;
    const mark = matches[matchIndex];
    mark.forEach((el) => el.classList.add('current'));
    mark[0]?.scrollIntoView({ block: 'center' });
  }
  function schedule(source: string, file: string, isDark: boolean) {
    const token = ++generation;
    cancelParse(owner);
    clearTimeout(timer);
    timer = setTimeout(
      async () => {
        busy = true;
        error = '';
        try {
          const parsed = await parse(source, owner);
          if (token !== generation || !article) return;
          const position = initial ? scroll : host.scrollTop;
          clearMarks();
          await reconcileMarkup(article, parsed.markup, () => token === generation);
          if (token !== generation) return;
          addCopyButtons();
          renderedSource = source;
          onheadings(parsed.headings);
          host.scrollTop = position;
          initial = false;
          refreshAnchors();
          await enhance(article, file, isDark, () => token === generation);
          if (token === generation) {
            if (showFind && findText) searchText();
            if (position && host.scrollTop === 0) host.scrollTop = position;
            refreshAnchors();
            if (reloadedLocation) {
              if (!syncEnabled)
                host.scrollTop = previewScrollTop(
                  reloadedLocation,
                  scrollAnchors,
                  host.scrollHeight - host.clientHeight,
                );
              reloadedLocation = undefined;
            }
            if (pendingAnchor) anchor(pendingAnchor);
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
    cancelParse(owner);
    disposeEnhancements(article);
    clearTimeout(timer);
    clearTimeout(searchTimer);
  });
  function click(event: MouseEvent) {
    const task = (event.target as Element).closest<HTMLInputElement>('input[data-task-offset]');
    if (task) {
      event.preventDefault();
      if (!stale && renderedSource === content) ontask(Number(task.dataset.taskOffset), content[Number(task.dataset.taskOffset) + 1] === ' ', content);
      return;
    }
    if (stale) { event.preventDefault(); return; }
    const link = (event.target as Element).closest('a');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href');
    if (href?.startsWith('#')) onanchor(decodeURIComponent(href.slice(1)));
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
        on:input={scheduleSearch}
        on:compositionstart={() => {
          composing = true;
          clearTimeout(searchTimer);
        }}
        on:compositionend={() => {
          composing = false;
          scheduleSearch();
        }}
        on:keydown={(e) => {
          if (e.isComposing) return;
          if (e.key === 'Enter') nextMatch(e.shiftKey ? -1 : 1);
          if (e.key === 'Escape') {
            closeFind();
          }
        }}
      /><button
        aria-label="区分大小写"
        aria-pressed={caseSensitive}
        on:click={() => {
          caseSensitive = !caseSensitive;
          scheduleSearch();
        }}>Aa</button
      ><span>{matches.length ? matchIndex + 1 : 0}/{matches.length}</span><button
        on:click={() => nextMatch(-1)}
        aria-label="上一个结果">↑</button
      ><button on:click={() => nextMatch(1)} aria-label="下一个结果">↓</button><button
        on:click={() => {
          closeFind();
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
    class:preview-stale={stale}
    bind:this={host}
    on:wheel={userScroll}
    on:pointerdown={userScroll}
    on:keydown={userScroll}
    on:scroll={reportScroll}
    on:click={click}
  >
    <article
      class="prose"
      style={`zoom: ${zoom / 100}; font-family: ${fonts[reading.font]}; font-size: ${reading.size}px; line-height: ${reading.lineHeight}; max-width: ${reading.width}px`}
      bind:this={article}
    ></article>
    <div class="document-end"><span></span> 墨页 <span></span></div>
  </div>
</section>
