import { canApplyDocumentRead, type Tab } from '../src/lib/types';
import { afterEach, expect, it } from 'vitest';
import { changeDocument, documentHistory, documentStates } from '../src/lib/document-state';
import { parseMarkdown } from '../src/lib/parse';
import { lineDiff } from '../src/lib/diff';
import { NavigationHistory } from '../src/lib/navigation';
import type { Visit } from '../src/lib/navigation';
afterEach(() => documentStates.clear());
it('maps nested and quoted tasks to exact source offsets without matching code', () => {
  const source = '- [ ] 外层\n  - [x] 内层\n\n> - [ ] 引用\n\n```md\n- [ ] 代码\n```';
  const parsed = parseMarkdown(source);
  const offsets = [...parsed.html.matchAll(/data-task-offset="(\d+)"/g)].map((m) => Number(m[1]));
  expect(offsets).toEqual([source.indexOf('[ ]'), source.indexOf('[x]'), source.indexOf('[ ]', source.indexOf('>'))]);
  for (const offset of offsets) expect(source.slice(offset, offset+3)).toMatch(/^\[[ xX]\]$/);
  expect(parsed.markup.join('')).toBe(parsed.html);
});
it('shares individually undoable reading edits with document history', () => {
  let text = '- [ ] A\n- [ ] B';
  text = changeDocument('task', text, { from: 3, to: 4, insert: 'x' });
  text = changeDocument('task', text, { from: 11, to: 12, insert: 'x' });
  expect(text).toBe('- [x] A\n- [x] B');
  text = documentHistory('task', text, 'undo'); expect(text).toBe('- [x] A\n- [ ] B');
  text = documentHistory('task', text, 'redo'); expect(text).toBe('- [x] A\n- [x] B');
});
it('computes changed lines for insertions, removals and repeated Unicode text', () => {
  expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual({ left: [2], right: [2] });
  expect(lineDiff('中文\n相同', '新增\n中文\n相同')).toEqual({ left: [], right: [1] });
  expect(lineDiff('a\na\nb', 'a\nb')).toEqual({ left: [2], right: [] });
  expect(lineDiff('same', 'same')).toEqual({ left: [], right: [] });
});
it('bounds navigation, replaces forward branches and migrates renamed locations', () => {
  const history = new NavigationHistory();
  const visit = (n: number): Visit => ({ id: String(n), path: `C:/work/${n}.md`, name: `${n}.md`, position: { path: `C:/work/${n}.md`, edit: false, line: n, cursor: 0, editorLine: 0, progress: 0, atStart: false, atEnd: false, updatedAt: 0 } });
  for (let n=0; n<105; n++) history.visit(visit(n));
  expect(history.entries).toHaveLength(100); expect(history.move(-1)?.position.line).toBe(103);
  history.visit(visit(200)); expect(history.canForward).toBe(false);
  for(let n=0; n<25; n++) history.close(visit(n));
  expect(history.closed).toHaveLength(20);
  history.close({ ...visit(30), path: '' }); expect(history.closed).toHaveLength(20);
  history.rename('c:/WORK/200.md', 'C:/work/new.md', 'new.md');
  expect(history.entries.at(-1)?.position.path).toBe('C:/work/new.md');
  history.clear(); expect(history.canBack).toBe(false); expect(history.closed).toHaveLength(0);
});

it('protects pending input and edits arriving during a disk read', () => {
  const snapshot={id:'a',path:'C:/a.md',content:'disk',saved:'disk',fingerprint:'f',bodyVersion:0,revision:0} as Tab;
  expect(canApplyDocumentRead(snapshot,{...snapshot})).toBe(true);
  expect(canApplyDocumentRead(snapshot,{...snapshot,pending:true})).toBe(false);
  expect(canApplyDocumentRead(snapshot,{...snapshot,content:'typed',bodyVersion:1})).toBe(false);
  expect(canApplyDocumentRead(snapshot,{...snapshot,path:'C:/new.md'})).toBe(false);
});
