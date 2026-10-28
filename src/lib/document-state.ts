import { EditorState, Transaction, type ChangeSpec } from '@codemirror/state';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';

export const documentStates = new Map<string, { state: EditorState; scroll: number }>();
export const liveEditors = new Map<string, EditorView>();
export const flushers = new Map<string, () => void>();
const insertions = new Map<string, Set<{ from: number; to: number }>>();
export function captureInsertion(id: string, fallback: number) {
  const range = liveEditors.get(id)?.state.selection.main;
  const point = { from: range?.from ?? fallback, to: range?.to ?? fallback };
  const points = insertions.get(id) || new Set(); points.add(point); insertions.set(id, points);
  return { point, release: () => { points.delete(point); if (!points.size) insertions.delete(id); } };
}
export function mapInsertions(id: string, changes: import('@codemirror/state').ChangeDesc) {
  for (const point of insertions.get(id) || []) {
    if (point.from === point.to) point.from = point.to = changes.mapPos(point.from, 1);
    else { point.from = changes.mapPos(point.from, -1); point.to = changes.mapPos(point.to, 1); }
  }
}
export function flushDocuments() { for (const flush of flushers.values()) flush(); }
export function documentState(id: string, content: string) {
  const stored = documentStates.get(id);
  if (stored && stored.state.doc.toString() === content) return stored;
  const entry = { state: EditorState.create({ doc: content, extensions: [history()] }), scroll: 0 };
  documentStates.set(id, entry);
  return entry;
}
/** Used by reading-mode tasks and rename updates, preserving the same undo stack. */
export function changeDocument(id: string, content: string, changes: ChangeSpec): string {
  const view = liveEditors.get(id);
  if (view) {
    view.dispatch({ changes, annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')] });
    flushers.get(id)?.();
    return view.state.doc.toString();
  }
  const entry = documentState(id, content);
  const transaction = entry.state.update({ changes, annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')] });
  mapInsertions(id, transaction.changes);
  entry.state = transaction.state;
  return entry.state.doc.toString();
}
export function documentHistory(id: string, content: string, direction: 'undo' | 'redo') {
  const view = liveEditors.get(id);
  const entry = view ? { state: view.state, scroll: view.scrollDOM.scrollTop } : documentState(id, content);
  const command = direction === 'undo' ? undo : redo;
  command({ state: entry.state, dispatch: (transaction) => {
    if (view) view.dispatch(transaction);
    else { mapInsertions(id, transaction.changes); entry.state = transaction.state; }
  } });
  flushers.get(id)?.();
  return view ? view.state.doc.toString() : entry.state.doc.toString();
}
