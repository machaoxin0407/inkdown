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
const states = new Map<string, { state: EditorState; scroll: number }>();
export function forgetEditor(id: string) {
  states.delete(id);
}
export function createEditor(
  host: HTMLElement,
  id: string,
  content: string,
  onchange: (value: string) => void,
  onscroll: (position: SourceScroll) => void = () => {},
) {
  let notify = onchange;
  let scrollFrame = 0;
  function scheduleScroll() {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      const scroller = view.scrollDOM;
      const max = scroller.scrollHeight - scroller.clientHeight;
      const y = Math.max(0, scroller.getBoundingClientRect().top - view.documentTop);
      const block = view.lineBlockAtHeight(y);
      const line = view.state.doc.lineAt(block.from).number - 1;
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
      if (update.docChanged) notify(update.state.doc.toString());
      if (update.docChanged || update.geometryChanged) scheduleScroll();
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
  view.scrollDOM.addEventListener('scroll', scheduleScroll, { passive: true });
  if (stored) view.scrollDOM.scrollTop = stored.scroll;
  scheduleScroll();
  return {
    focus: () => view.focus(),
    find: () => openSearchPanel(view),
    setZoom(percent: number) {
      view.dom.style.fontSize = `${(14 * percent) / 100}px`;
      view.requestMeasure();
    },
    destroy() {
      states.set(id, { state: view.state, scroll: view.scrollDOM.scrollTop });
      notify = () => {};
      cancelAnimationFrame(scrollFrame);
      view.scrollDOM.removeEventListener('scroll', scheduleScroll);
      view.destroy();
    },
  };
}
import { StateEffect } from '@codemirror/state';
