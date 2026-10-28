import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, Decoration } from '@codemirror/view';
export function readOnlyDiff(host: HTMLElement, content: string, lines: number[], kind: string) {
  const doc = EditorState.create({ doc: content }).doc;
  const marks = Decoration.set(lines.filter((n) => n > 0 && n <= doc.lines).map((n) => Decoration.line({ class: kind }).range(doc.line(n).from)).sort((a,b) => a.from-b.from), true);
  const view = new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [
    EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), EditorView.lineWrapping,
    EditorView.decorations.of(marks), EditorView.theme({ '&': { height: '100%', backgroundColor: 'var(--paper)', color: 'var(--text)' }, '.cm-scroller': { fontFamily: 'Consolas,monospace', overflow: 'auto' } }),
  ] }) });
  return () => view.destroy();
}
