import { applyReferenceEdits, type ReferenceEdit } from './references';
import { dirty, pathKey, sourceVersion, type Tab, type DocumentData } from './types';
export interface RenameProposal {
  document: DocumentData;
  after: string;
  edits: ReferenceEdit[];
  tabVersion?: string;
  buffered: boolean;
}
export interface RenameOutcome { path: string; status: 'updated' | 'buffer' | 'conflict' | 'failed'; message: string }
export interface RenameResult { renamed: boolean; path: string; files: RenameOutcome[] }
export interface RenamePlan { oldPath: string; name: string; workspace: string; expected: string; proposals: RenameProposal[]; warnings: string[] }
interface Port {
  index(path: string): Promise<{ paths: string[]; skipped: number; cancelled?: boolean }>;
  read(path: string): Promise<DocumentData>;
  fingerprint(path: string): Promise<string | null>;
  rename(path: string, name: string, expected: string): Promise<string>;
  save(path: string, content: string, expected: string | null, bom: boolean, newline: string): Promise<DocumentData>;
}
export async function prepareRename(port: Port, oldPath: string, name: string, workspace: string, tabs: Tab[], only?: string[]): Promise<RenamePlan> {
  const target = only ? undefined : await port.read(oldPath);
  const indexed = only ? { paths: only, skipped: 0 } : workspace ? await port.index(workspace) : { paths: [oldPath], skipped: 0 };
  if(indexed.cancelled) throw new Error('工作区索引已变化，请重新尝试重命名');
  const plan: RenamePlan = { oldPath, name, workspace: workspace || oldPath.replace(/[\\/][^\\/]+$/, ''), expected: target?.fingerprint || '', proposals: [], warnings: [] };
  if(indexed.skipped) plan.warnings.push(`索引跳过 ${indexed.skipped} 个项目，可能存在未列出的引用`);
  const worker = new Worker(new URL('./references.worker.ts', import.meta.url), { type: 'module' });
  try {
    for (const path of indexed.paths) {
      try {
        const tab = tabs.find((t) => pathKey(t.path) === pathKey(path));
        const buffered = !!tab && dirty(tab);
        const document = buffered ? { path: tab!.path, content: tab!.content, fingerprint: tab!.fingerprint, bom: tab!.bom, newline: tab!.newline } : await port.read(path);
        const edits = await new Promise<ReferenceEdit[]>((resolve, reject) => {
          worker.onmessage = ({ data }) => { if(data.error) reject(new Error(data.error)); else { for(const warning of data.warnings || []) plan.warnings.push(`${path}：${warning}`); resolve(data.edits); } };
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage({ source: document.content, document: document.path, oldPath, name, workspace: plan.workspace });
        });
        if(edits.length) plan.proposals.push({ document, edits, after: applyReferenceEdits(document.content, edits), buffered, tabVersion: tab ? sourceVersion(tab) : undefined });
      } catch (e) { plan.warnings.push(`${path}：${String(e)}`); }
    }
  } finally { worker.terminate(); }
  return plan;
}
/** Rename once, then apply independently guarded writes; partial failures remain reviewable. */
export async function applyRename(port: Port, plan: RenamePlan, selected: string[], tabs: Tab[], callbacks: {
  renamed(path: string): Promise<void>;
  buffer(proposal: RenameProposal, path: string): void;
  saved(document: DocumentData): void;
}, alreadyRenamed?: string): Promise<RenameResult> {
  const proposals = plan.proposals.filter((p) => selected.some((path) => pathKey(path) === pathKey(p.document.path)));
  const validation: RenameOutcome[] = [];
  for (const proposal of proposals) {
    const tab = tabs.find((t) => pathKey(t.path) === pathKey(proposal.document.path));
    try {
      if(proposal.tabVersion && (!tab || sourceVersion(tab) !== proposal.tabVersion || tab.pending)) throw new Error('编辑内容在预览后变化，请重新扫描');
      if(!proposal.buffered && await port.fingerprint(proposal.document.path) !== proposal.document.fingerprint) throw new Error('磁盘内容在预览后变化，请重新扫描');
    } catch(e) { validation.push({ path: proposal.document.path, status: 'conflict', message: String(e) }); }
  }
  if(validation.length) return { renamed: !!alreadyRenamed, path: alreadyRenamed || plan.oldPath, files: validation };
  const path = alreadyRenamed || await port.rename(plan.oldPath, plan.name, plan.expected);
  if(!alreadyRenamed) await callbacks.renamed(path);
  const result: RenameResult = { renamed: true, path, files: [] };
  for (const proposal of proposals) {
    const destination = pathKey(proposal.document.path) === pathKey(plan.oldPath) ? path : proposal.document.path;
    try {
      if(proposal.buffered) { callbacks.buffer(proposal, destination); result.files.push({ path: destination, status: 'buffer', message: '已更新编辑内容，尚未保存' }); }
      else {
        const document = await port.save(destination, proposal.after, proposal.document.fingerprint, proposal.document.bom, proposal.document.newline);
        callbacks.saved(document); result.files.push({ path: destination, status: 'updated', message: '已更新并保存' });
      }
    } catch(e) { result.files.push({ path: destination, status: String(e).includes('CONFLICT') ? 'conflict' : 'failed', message: String(e) }); }
  }
  return result;
}
