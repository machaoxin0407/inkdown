import { expect, it, vi } from 'vitest';
import { referenceEdits, applyReferenceEdits } from '../src/lib/references';
import { prepareRename, applyRename, type RenamePlan } from '../src/lib/rename';
const rewrite = (source: string, name='新 文档.md') => applyReferenceEdits(source, referenceEdits(source,'C:/库/子/引用.md','C:/库/旧 文档.md',name,'C:/库'));
it('only replaces link destinations, retaining anchors, titles, Unicode and encoding', () => {
  expect(rewrite('[正文](<../旧 文档.md#章节> "标题")')).toBe('[正文](<../新 文档.md#章节> "标题")');
  expect(rewrite('[正文](../%E6%97%A7%20%E6%96%87%E6%A1%A3.md#章节)')).toBe('[正文](../%E6%96%B0%20%E6%96%87%E6%A1%A3.md#章节)');
  expect(rewrite('[**正文**](../旧%20文档.md)', 'new.md')).toBe('[**正文**](../new.md)');
});
it('updates used reference definitions but excludes code, images and external URLs', () => {
  const source='[链接][文章]\n\n[文章]: <../旧 文档.md#章> "标题"\n\n`[代码](<../旧 文档.md>)`\n\n```md\n[代码](<../旧 文档.md>)\n```\n\n![图片](<../旧 文档.md>)\n\n[网络](https://example.com/a.md)';
  const next = rewrite(source);
  expect(next).toContain('[文章]: <../新 文档.md#章> "标题"');
  expect(referenceEdits(source,'C:/库/子/引用.md','C:/库/旧 文档.md','新 文档.md','C:/库')).toHaveLength(1);
  expect(rewrite('[图][共用]\n\n![图][共用]\n\n[共用]: <../旧 文档.md>')).toContain('[共用]: <../旧 文档.md>');
});
it('rejects workspace escapes and unrelated filenames', () => {
  expect(rewrite('[别的](../其他.md)')).toBe('[别的](../其他.md)');
  expect(referenceEdits('[x](../../旧.md)','C:/库/子/a.md','C:/旧.md','新.md','C:/库')).toEqual([]);
});
it('reports partial write failures and never writes dirty buffers to disk', async () => {
  const base = { path:'C:/库/a.md', content:'[x](old.md)', fingerprint:'f', bom:true, newline:'CRLF' as const };
  const plan: RenamePlan = { oldPath:'C:/库/old.md', name:'new.md', expected:'target', workspace:'C:/库', warnings:[], proposals:[
    { document:base, after:'[x](new.md)', edits:[{ from:4,to:10,insert:'new.md' }], buffered:false },
    { document:{...base,path:'C:/库/b.md'}, after:'[x](new.md)', edits:[], buffered:true, tabVersion:'b:1' },
    { document:{...base,path:'C:/库/c.md'}, after:'[x](new.md)', edits:[], buffered:false },
  ] };
  const port = { index:vi.fn(),read:vi.fn(),fingerprint:vi.fn(async()=> 'f'),rename:vi.fn(async()=> 'C:/库/new.md'),save:vi.fn(async(path:string,content:string,expected:string|null,bom:boolean,newline:string) => { if(path.endsWith('c.md')) throw Error('只读'); return {...base,path,content,expected,bom,newline:'CRLF' as const}; }) };
  const buffer = vi.fn(), saved=vi.fn(), renamed=vi.fn(async()=>{});
  const tabs = [{...base,path:'C:/库/b.md',id:'b',name:'b.md',saved:'old',content:base.content,revision:0,bodyVersion:1,scroll:0,edit:true,external:false}];
  const result=await applyRename(port,plan,plan.proposals.map((p)=>p.document.path),tabs,{buffer,saved,renamed});
  expect(result.renamed).toBe(true); expect(result.files.map((f)=>f.status)).toEqual(['updated','buffer','failed']);
  expect(port.save).toHaveBeenCalledTimes(2); expect(buffer).toHaveBeenCalledTimes(1);
});
it('aborts before renaming when a preview fingerprint is stale', async () => {
  const plan: RenamePlan = { oldPath:'C:/库/old.md', name:'new.md', expected:'target',workspace:'C:/库',warnings:[],proposals:[{ document:{path:'C:/库/a.md',content:'before',fingerprint:'old',bom:false,newline:'LF'},after:'after',edits:[],buffered:false }] };
  const port={ index:vi.fn(),read:vi.fn(),fingerprint:vi.fn(async()=> 'new'),rename:vi.fn(),save:vi.fn() };
  const result=await applyRename(port,plan,['C:/库/a.md'],[],{buffer:vi.fn(),saved:vi.fn(),renamed:vi.fn()});
  expect(result.renamed).toBe(false); expect(result.files[0].status).toBe('conflict'); expect(port.rename).not.toHaveBeenCalled();
});

it('rejects an incomplete cancelled scan before presenting a rename preview', async () => {
  const port={ index:vi.fn(async()=>({paths:[],skipped:0,cancelled:true})),read:vi.fn(async()=>({path:'C:/库/old.md',content:'',fingerprint:'target',bom:false,newline:'LF' as const})),fingerprint:vi.fn(),rename:vi.fn(),save:vi.fn() };
  await expect(prepareRename(port,'C:/库/old.md','new.md','C:/库',[])).rejects.toThrow('索引已变化');
  expect(port.rename).not.toHaveBeenCalled();
});

it('excludes inline code with mixed backtick run lengths', () => {
  const source='`a `` [hidden](<../旧 文档.md>) `` b` [visible](<../旧 文档.md>)';
  expect(rewrite(source)).toBe('`a `` [hidden](<../旧 文档.md>) `` b` [visible](<../新 文档.md>)');
});
