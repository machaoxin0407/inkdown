import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { searchKeymap, search, openSearchPanel } from '@codemirror/search';
import type { SourceScroll } from './scroll-sync';
import { documentStates as states, liveEditors, flushers, mapInsertions } from './document-state';
export function forgetEditor(id: string) {
  states.delete(id);
}
export function createEditor(
  host: HTMLElement,
  id: string,
  content: string,
  onchange: (value: string) => void,
  onscroll: (position: SourceScroll) => void = () => {},
  position: { cursor: number; editorLine: number } | undefined = undefined,
  onposition: (cursor: number, line: number) => void = () => {},
  onpending: (bytes: number) => void = () => {},
) {
  let notify = onchange;
  let scrollFrame = 0;
  let pending = false, bytes = new TextEncoder().encode(content).length;
  let timer: ReturnType<typeof setTimeout> | undefined, maximum: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer); clearTimeout(maximum); maximum = undefined;
    if (!pending) return;
    pending = false;
    notify(view.state.doc.toString());
  };
  function scheduleScroll() {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      const scroller = view.scrollDOM;
      const max = scroller.scrollHeight - scroller.clientHeight;
      const y = Math.max(0, scroller.getBoundingClientRect().top - view.documentTop);
      const block = view.lineBlockAtHeight(y);
      const line = view.state.doc.lineAt(block.from).number - 1;
      onposition(view.state.selection.main.head, line);
      onscroll({
        line: line + Math.max(0, Math.min(1, (y - block.top) / Math.max(1, block.height))),
        progress: max > 0 ? scroller.scrollTop / max : 0,
        atStart: scroller.scrollTop <= 1,
        atEnd: max > 0 && scroller.scrollTop >= max - 1,
      });
    });
  }
  const stored = states.get(id);
  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    markdown(),
    syntaxHighlighting(defaultHighlightStyle),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.lineWrapping,
    EditorView.theme({
      '&': {
        height: '100%',
        fontSize: '14px',
        backgroundColor: 'var(--paper)',
        color: 'var(--text)',
      },
      '.cm-scroller': { fontFamily: 'Consolas, monospace', lineHeight: '1.8' },
      '.cm-content': { padding: '28px 16px' },
      '.cm-gutters': { backgroundColor: 'var(--paper)', border: 'none', color: 'var(--muted)' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
      '.cm-cursor': { borderLeftColor: 'var(--text)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'var(--selection)',
      },
      '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        mapInsertions(id, update.changes);
        update.changes.iterChanges((from, to, _a, _b, insert) => {
          bytes += new TextEncoder().encode(insert.toString()).length - new TextEncoder().encode(update.startState.sliceDoc(from, to)).length;
        });
        pending = true;
        onpending(bytes);
        clearTimeout(timer);
        timer = setTimeout(flush, 100);
        maximum ??= setTimeout(flush, 250);
      }
      // Selection changes arrive inside CodeMirror's DOM update. Defer geometry
      // reads to the shared animation frame instead of forcing layout there.
      if (update.docChanged || update.geometryChanged || update.selectionSet) scheduleScroll();
    }),
  ];
  // Reconfigure the listener when restoring a tab so it targets the current owner.
  let state =
    stored && stored.state.doc.toString() === content
      ? stored.state
      : EditorState.create({ doc: content, extensions });
  if (stored && state === stored.state) {
    const { reconfigure } = StateEffect;
    state = state.update({ effects: reconfigure.of(extensions) }).state;
  }
  const view = new EditorView({ state, parent: host });
  liveEditors.set(id, view);
  flushers.set(id, flush);
  view.scrollDOM.addEventListener('scroll', scheduleScroll, { passive: true });
  if (stored && stored.state.doc.toString() === content) view.scrollDOM.scrollTop = stored.scroll;
  else if (position) {
    const cursor = Math.min(view.state.doc.length, Math.max(0, position.cursor));
    const line = view.state.doc.line(
      Math.max(1, Math.min(view.state.doc.lines, position.editorLine + 1)),
    );
    view.dispatch({
      selection: { anchor: cursor },
      effects: EditorView.scrollIntoView(line.from, { y: 'start' }),
    });
  }
  scheduleScroll();
  return {
    flush,
    focus: () => view.focus(),
    find: () => openSearchPanel(view),
    select(from: number, to: number) {
      from = Math.max(0, Math.min(view.state.doc.length, from));
      to = Math.max(from, Math.min(view.state.doc.length, to));
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      });
      view.focus();
    },
    selected: () =>
      view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    insert(text: string) {
      view.dispatch(view.state.replaceSelection(text), {
        scrollIntoView: true,
        userEvent: 'input',
      });
      view.focus();
    },
    setZoom(percent: number) {
      view.dom.style.fontSize = `${(14 * percent) / 100}px`;
      view.requestMeasure();
    },
    destroy() {
      flush();
      flushers.delete(id);
      liveEditors.delete(id);
      states.set(id, { state: view.state, scroll: view.scrollDOM.scrollTop });
      notify = () => {};
      cancelAnimationFrame(scrollFrame);
      view.scrollDOM.removeEventListener('scroll', scheduleScroll);
      view.destroy();
    },
  };
}
import { StateEffect } from '@codemirror/state';
