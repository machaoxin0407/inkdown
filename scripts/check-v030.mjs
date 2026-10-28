import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const native = process.argv.includes('--native');
const root = resolve('artifacts/v030-' + (native ? 'native-' : 'ui-') + Date.now());
await mkdir(root, { recursive: true });
let browser, child, page;
const results = [], errors = [];
async function check(name, action) {
  try { await action(); results.push({ name, passed:true }); console.log('PASS', name); }
  catch(e) { await page?.screenshot({path:join(root,'failure.png')}).catch(()=>{}); results.push({ name, passed:false, error:String(e).slice(0,1800) }); console.log('FAIL', name, String(e).slice(0,1800)); throw new Error(String(e).slice(0,1800)); }
}
try {
  if(native) {
    child = spawn(resolve(process.env.INKDOWN_TEST_BINARY || 'src-tauri/target/release/inkdown.exe'), [], { windowsHide:true, stdio:'ignore', env:{...process.env,INKDOWN_DATA_DIR:join(root,'data'),WEBVIEW2_USER_DATA_FOLDER:join(root,'profile'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223'} });
    for(let n=0;n<150;n++) { try { browser=await chromium.connectOverCDP('http://127.0.0.1:9223'); break; } catch { await new Promise((r)=>setTimeout(r,200)); } }
    if(!browser) throw Error('Desktop startup failed');
    page=browser.contexts()[0].pages()[0];
  } else { browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1200,height:820}});await page.goto('http://127.0.0.1:1420'); }
  page.setDefaultTimeout(30000); page.on('pageerror',(e)=>errors.push(String(e)));
  await page.locator('.prose h1').waitFor();
  if(native) await page.evaluate(()=>{
    window.__picks=[];window.__watchCalls=0;window.__failWatch=false;window.__failSearch=false;
    const original=window.fetch.bind(window);
    window.fetch=(url,options)=>{
      const command=decodeURIComponent(String(url));
      if(command.includes('search_workspace') && window.__failSearch) return Promise.resolve(new Response(JSON.stringify('injected search failure'),{headers:{'Content-Type':'application/json','Tauri-Response':'error'}}));
      if(command.includes('watch_paths')) { window.__watchCalls++; if(window.__failWatch) return Promise.resolve(new Response(JSON.stringify('injected watch failure'),{headers:{'Content-Type':'application/json','Tauri-Response':'error'}})); }
      if(command.includes('plugin:dialog|')) return Promise.resolve(new Response(JSON.stringify(window.__picks.shift()??null),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}}));
      return original(url,options);
    };
  });
  await check('reading task transaction, undo and redo share editor history', async()=>{
    await page.keyboard.press('Control+n');
    await page.locator('.cm-content').fill('# Tasks\n\n- [ ] first\n  - [x] nested\n\n`- [ ] code`');
    await page.getByRole('button',{name:'阅读',exact:true}).click();
    const task=page.locator('.prose input[data-task-offset]').first();
    await expect(task).not.toBeChecked();await task.click();await expect(task).toBeChecked();
    await page.keyboard.press('Control+z');await expect(task).not.toBeChecked();
    await page.keyboard.press('Control+y');await expect(task).toBeChecked();
    await page.getByRole('button',{name:'编辑',exact:true}).click();await expect(page.locator('.cm-content')).toContainText('- [x] first');
  });
  await check('pending input flushes into its owner when changing tabs and history restores navigation',async()=>{
    await page.locator('.cm-content').fill('# History A\n\nlast input');
    await page.keyboard.press('Control+n');await page.locator('.cm-content').fill('# History B');
    await page.getByRole('button',{name:'后退',exact:true}).click();await expect(page.locator('.cm-content')).toContainText('last input');
    await page.getByRole('button',{name:'前进',exact:true}).click();await expect(page.locator('.cm-content')).toContainText('History B');
    await page.keyboard.press('Alt+ArrowLeft');await expect(page.locator('.cm-content')).toContainText('History A');
    await page.keyboard.press('Control+n');await expect(page.getByRole('button',{name:'前进',exact:true})).toBeDisabled();
  });
  await check('outline navigation records a new stop and back restores the previous source position',async()=>{
    await page.locator('.cm-content').fill('# Navigation\n\n'+('paragraph text\n\n').repeat(120)+'## Destination\n\nlast');
    await page.getByRole('button',{name:'阅读',exact:true}).click();await page.getByRole('button',{name:'大纲',exact:true}).click();
    await page.getByRole('button',{name:'Destination',exact:true}).click();await expect.poll(()=>page.locator('.preview-scroll').evaluate((e)=>e.scrollTop)).toBeGreaterThan(500);
    await page.getByRole('button',{name:'后退',exact:true}).click();await expect.poll(()=>page.locator('.preview-scroll').evaluate((e)=>e.scrollTop)).toBeLessThan(10);
    await page.getByRole('button',{name:'前进',exact:true}).click();await expect.poll(()=>page.locator('.preview-scroll').evaluate((e)=>e.scrollTop)).toBeGreaterThan(500);
    await page.getByRole('button',{name:'编辑',exact:true}).click();
  });
  if(!native) await check('large documents default to manual preview and cancellation releases the next document',async()=>{
    await page.locator('.cm-content').fill('# Huge\n\n- [x] first\n\nold preview');await page.getByRole('button',{name:'阅读',exact:true}).click();await expect(page.locator('.prose input[data-task-offset]').first()).toBeChecked();await page.getByRole('button',{name:'编辑',exact:true}).click();
    const source='# Huge\n\n- [x] first\n\n'+('a'.repeat(200)+'\n\n').repeat(26000);
    await page.locator('.cm-content').waitFor();
    await page.evaluate(async(source)=>{ const {liveEditors}=await import('/src/lib/document-state.ts');const view=[...liveEditors.values()][0];view.dispatch({changes:{from:0,to:view.state.doc.length,insert:source}}); },source);await expect(page.locator('.large-document-bar')).toContainText('手动预览');
    await page.locator('.prose input[data-task-offset]').first().dispatchEvent('click');
    const prefix=await page.evaluate(async()=>{ const {liveEditors}=await import('/src/lib/document-state.ts');return [...liveEditors.values()][0].state.sliceDoc(0,60); });expect(prefix).toContain('- [x] first');
    await page.getByRole('button',{name:'刷新预览',exact:true}).click();
    await page.keyboard.press('Control+n');await page.locator('.cm-content').fill('# Small after cancellation');
    await expect(page.locator('.prose h1')).toHaveText('Small after cancellation',{timeout:5000});
  });
  if(native) {
    const workspace=join(root,'workspace');await mkdir(workspace);
    const a=join(workspace,'A.md'),b=join(workspace,'B.md'),c=join(workspace,'C.md'),d=join(workspace,'D.md');
    await writeFile(a,'# Native A\n\nsearch target');await writeFile(b,'# Native B\n\n[link](A.md)');await writeFile(c,'# Native C\n\n[link](A.md)');await writeFile(d,'# Native D\n\n[link](A.md)');
    async function pick(value,key='Control+o') { await expect(page.locator('.open-folder')).toBeEnabled();await page.evaluate((v)=>window.__picks.push(v),value);await page.keyboard.press(key); }
    // Discard temporary unnamed documents before switching workspaces.
    for(let n=0;n<3;n++) { await page.getByRole('button',{name:'关闭 未命名.md',exact:true}).first().click();await page.waitForFunction(()=>document.querySelector('.modal') || !document.querySelector('.open-folder').disabled);const discard=page.getByRole('button',{name:'放弃修改',exact:true});if(await discard.count()) await discard.click();await expect(page.locator('.open-folder')).toBeEnabled(); }
    await pick(workspace,'Control+Shift+o');await expect(page.locator('.tree-row')).toHaveCount(4);
    await pick([a]);await expect(page.locator('.prose h1')).toHaveText('Native A');
    await check('workspace search refreshes unsaved edits and result offsets remain current',async()=>{
      await page.keyboard.press('Control+Shift+f');await page.getByRole('textbox',{name:'搜索工作区正文'}).fill('target');
      await expect(page.locator('.workspace-hit')).toHaveCount(1);
      const query=page.getByRole('textbox',{name:'搜索工作区正文'});
      await query.dispatchEvent('compositionstart');await query.fill('Native');await page.waitForTimeout(400);await expect(page.locator('.workspace-hit')).toHaveCount(0);
      await query.dispatchEvent('compositionend');await expect(page.locator('.workspace-hit')).toHaveCount(4);
      await query.fill('target');await expect(page.locator('.workspace-hit')).toHaveCount(1);
      await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('.cm-content').fill('# Native A\n\ninserted\n\nnew target');
      await expect(page.locator('.workspace-hit')).toContainText(':5');
      await page.locator('.workspace-hit').click();await expect(page.locator('.open-folder')).toBeEnabled();await expect(page.locator('.cm-selectionBackground')).not.toHaveCount(0);
      await page.keyboard.press('Control+s');await expect.poll(()=>readFile(a,'utf8')).toContain('new target');
      await expect(page.locator('.workspace-hit')).toHaveCount(1);
      await page.evaluate(()=>window.__failSearch=true);await query.fill('unavailable');await expect(page.locator('.workspace-search')).toContainText('injected search failure');await expect(page.locator('.workspace-hit')).toHaveCount(0);
      await page.evaluate(()=>window.__failSearch=false);await query.fill('target');await expect(page.locator('.workspace-hit')).toHaveCount(1);
      // Prevent the watcher from refreshing the hit first: exercise click-time verification.
      await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('watch_paths',{workspace:'',paths:[],generation:9999}));
      await writeFile(a,'# Native A\n\nmoved\n\n\n\nnew target');await page.locator('.workspace-hit').click();await expect(page.locator('.open-folder')).toBeEnabled();await expect(page.locator('.cm-activeLine')).toContainText('new target');
      await expect(page.locator('.workspace-hit')).toHaveCount(1);
      await writeFile(a,'# Native A\n\nno match remains');await page.locator('.workspace-hit').click();await expect(page.locator('.open-folder')).toBeEnabled();await expect(page.locator('.toast')).toContainText('匹配已变化');await expect(page.locator('.cm-selectionBackground')).toHaveCount(0);
      await page.locator('.cm-content').fill('# Native A\n\ninserted\n\nnew target');await page.keyboard.press('Control+s');await expect.poll(()=>readFile(a,'utf8')).toContain('new target');

    });
    await check('closed file reopens from disk without resurrecting discarded text',async()=>{
      await page.locator('.cm-content').fill('# discarded');await page.keyboard.press('Control+w');await page.getByRole('button',{name:'放弃修改',exact:true}).click();
      await expect(page.getByRole('tab',{name:/^A\.md/})).toHaveCount(0);await expect(page.locator('.open-folder')).toBeEnabled();
      await page.keyboard.press('Control+Shift+t');await expect(page.locator('.cm-content')).toContainText('new target');await expect(page.locator('.cm-content')).not.toContainText('discarded');
    });
    await check('external conflict comparison preserves dirty edits and supports cancel',async()=>{
      await page.locator('.cm-content').fill('# Local edits');await writeFile(a,'# Disk version');
      await page.keyboard.press('Control+s');await page.getByRole('button',{name:'比较版本',exact:true}).click();
      await expect(page.locator('.compare-editor').first()).toContainText('Local edits');await expect(page.locator('.compare-editor').last()).toContainText('Disk version');
      await page.getByRole('button',{name:'关闭比较',exact:true}).click();await expect.poll(()=>readFile(a,'utf8')).toBe('# Disk version');
      await page.keyboard.press('Control+s');await page.getByRole('button',{name:'覆盖磁盘版本',exact:true}).click();await expect.poll(()=>readFile(a,'utf8')).toBe('# Local edits');
    });
    await check('rename previews links, preserves dirty buffers and retries partial failures',async()=>{
      await pick([b]);await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('.cm-content').fill('# Native B\n\n[link](A.md)\n\nunsaved');
      await page.getByRole('button',{name:'文件',exact:true}).click();await page.getByRole('tab',{name:'A.md',exact:true}).click();
      await chmod(d,0o444);
      const item=page.locator('.tree-item').filter({has:page.getByRole('button',{name:'A.md',exact:true})});
      await item.locator('summary').click();await item.getByRole('button',{name:'重命名',exact:true}).click();await page.getByLabel('文件名',{exact:true}).fill('new.md');await page.getByRole('button',{name:'确定',exact:true}).click();
      await expect(page.locator('.rename-files details')).toHaveCount(3);
      await page.getByRole('button',{name:'重命名并更新选中引用',exact:true}).click();await expect(page.locator('.rename-dialog')).toContainText('文档已重命名');
      await expect.poll(()=>readFile(c,'utf8')).toContain('(new.md)');await expect.poll(()=>readFile(b,'utf8')).toContain('(A.md)');
      await chmod(d,0o666);await page.getByRole('button',{name:'重新扫描失败项',exact:true}).click();await page.getByRole('button',{name:'应用引用更新',exact:true}).click();await expect.poll(()=>readFile(d,'utf8')).toContain('(new.md)');
      await page.getByRole('button',{name:'关闭重命名预览',exact:true}).click();await page.getByRole('tab',{name:/^B\.md/}).click();await expect(page.locator('.cm-content')).toContainText('(new.md)');await page.keyboard.press('Control+s');
    });
    await check('PDF preflight, cancel cleanup, options and native export reuse one snapshot',async()=>{
      await page.locator('.cm-content').fill('# PDF snapshot\n\n![missing](missing.png)\n\n$$\\invalidcommand{x}$$\n\n```mermaid\nflowchart LR\n A-->B\n```');
      await page.keyboard.press('Control+Shift+p');await expect(page.locator('.pdf-issues')).toContainText('2 个资源问题');await expect(page.locator('.pdf-preview-document h1')).toHaveText('PDF snapshot');
      await page.getByRole('button',{name:'返回修复',exact:true}).click();await expect(page.locator('.pdf-export-root')).toHaveCount(0);
      await page.keyboard.press('Control+Shift+p');await page.getByLabel(/^纸张/).selectOption('Letter');await page.getByLabel('横向',{exact:true}).check();
      await page.screenshot({path:join(root,'pdf-preview.png')});
      const output=join(root,'preview.pdf');await page.evaluate((path)=>window.__picks.push(path),output);await page.getByRole('button',{name:'仍然导出',exact:true}).click();
      await expect.poll(async()=> (await readFile(output).catch(()=>Buffer.alloc(0))).subarray(0,5).toString()).toBe('%PDF-');await expect(page.locator('.pdf-export-root')).toHaveCount(0);
      await expect.poll(()=>readFile(b,'utf8')).not.toContain('PDF snapshot');
    });
    await check('failed watcher calibrates trees and indexes, then retries automatically',async()=>{
      await page.getByRole('button',{name:'文件',exact:true}).click();await page.keyboard.press('Control+p');await page.getByRole('button',{name:'关闭快速打开',exact:true}).click();
      await page.evaluate(async()=>{await window.__TAURI_INTERNALS__.invoke('watch_paths',{workspace:'',paths:[],generation:9999});window.__failWatch=true;});await pick([c]);await expect(page.locator('.error-banner')).toContainText('文件监听不可用');
      await writeFile(b,'# external fallback');
      const added=join(workspace,'fallback.md');await writeFile(added,'# fallback');await expect(page.getByRole('button',{name:'fallback.md',exact:true})).toBeVisible({timeout:25000});
      await page.keyboard.press('Control+p');await page.getByRole('textbox',{name:'搜索文件名或路径'}).fill('fallback');await expect(page.locator('.quick-result')).toContainText('fallback.md');await page.getByRole('button',{name:'关闭快速打开',exact:true}).click();
      const calls=await page.evaluate(()=>window.__watchCalls);await page.evaluate(()=>window.__failWatch=false);await page.waitForFunction((calls)=>window.__watchCalls>calls,calls,{timeout:45000});
      await writeFile(join(workspace,'recovered.md'),'# recovered');await expect(page.getByRole('button',{name:'recovered.md',exact:true})).toBeVisible({timeout:10000});
      await page.getByRole('tab',{name:/^B\.md/}).click();await expect(page.locator('.cm-content')).toContainText('PDF snapshot');await expect(page.locator('.external-banner')).toBeVisible();
    });
  }
  await page.screenshot({path:join(root,'final.png')});
  if(errors.length) throw Error(errors.join('\n'));
} finally {
  await writeFile(join(root,'report.json'),JSON.stringify({native,root,results,errors},null,2));
  await writeFile(`artifacts/v030-${native?'native':'ui'}-report.json`,JSON.stringify({native,root,results,errors},null,2));
  await browser?.close();child?.kill();
}
