import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const label = process.argv.find((a)=>['baseline','current'].includes(a)) || 'current';
const fixtures=resolve('artifacts/benchmark-v030-fixtures');await mkdir(fixtures,{recursive:true});
const documents={};
for(const mb of [1,5,10,32]) {
  const path=join(fixtures,`${mb}MB.md`),header='# Benchmark\n\n',paragraph='中文阅读性能测试。'.repeat(40)+'\n\n';
  const total=mb*1024*1024-4096,remaining=total-Buffer.byteLength(header),size=Buffer.byteLength(paragraph);
  documents[mb]=path;try { await readFile(path); } catch { await writeFile(path,header+paragraph.repeat(Math.floor(remaining/size))+'a'.repeat(remaining%size)); }
}
for(const count of [1000,10000]) {
  const directory=join(fixtures,`workspace-${count}`);await mkdir(directory,{recursive:true});
  for(let start=0;start<count;start+=100) await Promise.all(Array.from({length:Math.min(100,count-start)},async(_,i)=>{
    const path=join(directory,`note-${start+i}.md`);try { await readFile(path); } catch { await writeFile(path,`# Note ${start+i}\n\nsearchable content ${start+i}`); }
  }));
}
if(process.argv.includes('--prepare')) { console.log('Prepared shared benchmark fixtures');process.exit(0); }
const root=resolve(`artifacts/benchmark-v030-${label}-${Date.now()}`);await mkdir(root,{recursive:true});
const binary=resolve(process.env.INKDOWN_TEST_BINARY || 'src-tauri/target/release/inkdown.exe');
const child=spawn(binary,[],{windowsHide:true,stdio:'ignore',env:{...process.env,INKDOWN_DATA_DIR:join(root,'data'),WEBVIEW2_USER_DATA_FOLDER:join(root,'profile'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223'}});
const sample=(values)=>({values,median:[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)],maximum:Math.max(...values)});
const report={label,binary,root,documents:{},workspaces:{},memory:[],errors:[]};
let browser,page;
try {
  for(let n=0;n<150;n++) { try { browser=await chromium.connectOverCDP('http://127.0.0.1:9223');break; } catch { await new Promise((r)=>setTimeout(r,200)); } }
  if(!browser) throw Error('No benchmark WebView');page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(120000);
  report.webview=browser.version();page.on('pageerror',(e)=>report.errors.push(String(e)));
  await page.locator('.prose h1').waitFor();await page.locator('.render-progress').waitFor({state:'detached'});
  await page.evaluate(()=>{window.__picks=[];const original=window.fetch.bind(window);window.fetch=(url,options)=>decodeURIComponent(String(url)).includes('plugin:dialog|')?Promise.resolve(new Response(JSON.stringify(window.__picks.shift()??null),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}})):original(url,options);});
  const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  const open=async(path)=>{await expect(page.locator('.open-folder')).toBeEnabled();await page.evaluate((p)=>window.__picks.push([p]),path);await page.keyboard.press('Control+o');await page.locator('.prose h1').filter({hasText:'Benchmark'}).waitFor();await page.locator('.render-progress').waitFor({state:'detached'});};
  const close=async()=>{await expect(page.locator('.open-folder')).toBeEnabled();await page.keyboard.press('Control+w');await page.waitForFunction(()=>document.querySelector('.modal') || !document.querySelector('.open-folder').disabled);const discard=page.getByRole('button',{name:'放弃修改',exact:true});if(await discard.count()) await discard.click();await expect(page.locator('.open-folder')).toBeEnabled();await page.locator('.prose h1').filter({hasText:'Benchmark'}).waitFor({state:'detached'});};
  for(const mb of [1,5,10,32]) {
    const values=[];
    for(let n=0;n<5;n++) {const start=performance.now();await open(documents[mb]);values.push(performance.now()-start);if(n<4) await close();}
    report.documents[mb]={open:sample(values),bytes:(await readFile(documents[mb])).length};console.log(label,`${mb}MB open`,JSON.stringify(report.documents[mb].open));
    await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('.cm-content').waitFor();await page.locator('.cm-content').press('Control+End');await page.waitForTimeout(1000);
    await page.evaluate(()=>{window.__latencies=[];document.querySelector('.cm-content').addEventListener('beforeinput',()=>{const start=performance.now();requestAnimationFrame(()=>window.__latencies.push(performance.now()-start));},true);});
    for(let n=0;n<50;n++) { await page.keyboard.type('a');await page.waitForTimeout(120); }
    await page.waitForTimeout(500);const latencies=await page.evaluate(()=>window.__latencies);
    report.documents[mb].input={...sample(latencies),p95:[...latencies].sort((a,b)=>a-b)[Math.ceil(latencies.length*.95)-1]};
    if(latencies.length!==50) throw Error(`Expected 50 input samples; got ${latencies.length}`);
    console.log(label,`${mb}MB input P95`,report.documents[mb].input.p95);
    if(mb===32) {
      report.largeProcessMemory=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`$processes=Get-CimInstance Win32_Process; $ids=@(${child.pid}); do { $next=@($processes | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | Select-Object -ExpandProperty ProcessId); $ids+=$next } while($next.Count -gt 0); $processes | Where-Object { $_.ProcessId -in $ids } | Select-Object Name,ProcessId,WorkingSetSize,PrivatePageCount | ConvertTo-Json`],{windowsHide:true,encoding:'utf8'}));
    }
    await close();
  }
  if(label==='current') {
    await page.evaluate((p)=>window.__picks.push([p]),documents[32]);await page.keyboard.press('Control+o');await expect(page.locator('.open-folder')).toBeEnabled();await page.locator('.render-progress').waitFor();
    const start=performance.now();await page.keyboard.press('Control+n');await page.locator('.cm-content').fill('# After cancellation');await page.locator('.prose h1').filter({hasText:'After cancellation'}).waitFor();
    report.cancelledPreviewSwitchMs=performance.now()-start;console.log('current preview cancellation switch',report.cancelledPreviewSwitchMs);
    await page.keyboard.press('Control+w');await page.getByRole('button',{name:'放弃修改',exact:true}).click();await expect(page.locator('.open-folder')).toBeEnabled();await page.keyboard.press('Control+w');await expect(page.locator('.open-folder')).toBeEnabled();
  }
  for(const count of [1000,10000]) {
    const path=join(fixtures,`workspace-${count}`);await invoke('open_workspace',{path});const scans=[],search=[];
    for(let n=0;n<5;n++) {let start=performance.now();await invoke('index_workspace',{path});scans.push(performance.now()-start);start=performance.now();await invoke('search_workspace',{path,query:'absent search token',sensitive:false,overlays:[]});search.push(performance.now()-start);}
    await page.evaluate((p)=>window.__picks.push(p),path);await page.keyboard.press('Control+Shift+o');await expect(page.locator('.open-folder')).toBeEnabled();
    await page.keyboard.press('Control+p');await page.locator('.quick-input').waitFor();await expect(page.locator('.feature-note').first()).not.toContainText('正在索引');await page.keyboard.press('Escape');await page.locator('.quick-input').waitFor({state:'detached'});
    const warm=[];for(let n=0;n<5;n++) {const start=performance.now();await page.keyboard.press('Control+p');await page.locator('.quick-input').waitFor();warm.push(performance.now()-start);await page.keyboard.press('Escape');await page.locator('.quick-input').waitFor({state:'detached'});}
    const task=invoke('search_workspace',{path,query:'absent search token',sensitive:false,overlays:[]});await new Promise((r)=>setTimeout(r,10));const cancel=performance.now();await invoke('cancel_search');const cancelled=await task;
    report.workspaces[count]={index:sample(scans),search:sample(search),quickWarm:sample(warm),cancel:{cancelled:cancelled.cancelled,elapsed:performance.now()-cancel}};
    console.log(label,`${count} files`,JSON.stringify(report.workspaces[count]));
  }
  const cdp=await page.context().newCDPSession(page);
  for(let group=0;group<5;group++) {
    for(let n=0;n<5;n++) {await open(documents[1]);await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('.cm-content').waitFor();await page.getByRole('button',{name:'阅读',exact:true}).click();await close();}
    await cdp.send('HeapProfiler.collectGarbage');report.memory.push((await cdp.send('Runtime.getHeapUsage')).usedSize);
  }
  report.memoryPlateau=report.memory[4]<=report.memory[1]+8*1024*1024;
  const boundary=join(root,'boundary.md');await writeFile(boundary,Buffer.alloc(32*1024*1024,97));report.boundary32=(await invoke('read_document',{path:boundary})).content.length===32*1024*1024;
  await writeFile(boundary,Buffer.alloc(32*1024*1024+1,97));try {await invoke('read_document',{path:boundary});report.overLimitRejected=false;}catch {report.overLimitRejected=true;}
} catch(e) {report.error=String(e).slice(0,3000);console.error(report.error);process.exitCode=1;}
finally {await writeFile(`artifacts/benchmark-v030-${label}.json`,JSON.stringify(report,null,2));await browser?.close();try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
