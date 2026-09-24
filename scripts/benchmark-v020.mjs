import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const label = process.argv[2] || 'current';
const binary = resolve(process.env.INKDOWN_TEST_BINARY || 'src-tauri/target/release/inkdown.exe');
const root = resolve('artifacts/benchmark-' + label + '-' + Date.now());
await mkdir(root, { recursive: true });
const files = {};
for (const mb of [1, 5, 10]) {
  const text =
    '# Benchmark\n\n' +
    ('中文阅读性能测试。'.repeat(40) + '\n\n').repeat(Math.ceil((mb * 1024 * 1024) / 1082));
  files[mb] = [];
  for (let i = 0; i < 5; i++) {
    const path = join(root, `${mb}MB-${i}.md`);
    await writeFile(path, text);
    files[mb].push(path);
  }
}
const child = spawn(binary, [], {
  windowsHide: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    INKDOWN_DATA_DIR: join(root, 'data'),
    WEBVIEW2_USER_DATA_FOLDER: join(root, 'profile'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
  },
});
let browser, page;
const report = { label, binary, webview: '', documents: {}, index: {} };
const stat = (values) => ({
  values,
  median: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)],
  p95: [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1],
});
try {
  for (let i = 0; i < 150; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!browser) throw Error('No WebView');
  report.webview = browser.version();
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(120000);
  await page.locator('.prose h1').waitFor();
  await page.evaluate(() => {
    window.__picks = [];
    const fetch = window.fetch.bind(window);
    window.fetch = (url, opts) =>
      decodeURIComponent(String(url)).includes('plugin:dialog|')
        ? Promise.resolve(
            new Response(JSON.stringify(window.__picks.shift() ?? null), {
              headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
            }),
          )
        : fetch(url, opts);
  });
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  for (const mb of [1, 5, 10]) {
    const values = [];
    for (const file of files[mb]) {
      await page.evaluate((file) => window.__picks.push([file]), file);
      const start = performance.now();
      await expect(page.locator('.open-folder')).toBeEnabled();
      await page.keyboard.press('Control+o');
      await page.getByRole('heading', { name: 'Benchmark', exact: true }).waitFor();
      await page.locator('.render-progress').waitFor({ state: 'detached' });
      values.push(Math.round(performance.now() - start));
      await expect(page.locator('.open-folder')).toBeEnabled();
      await page.keyboard.press('Control+w');
      await page
        .getByRole('heading', { name: 'Benchmark', exact: true })
        .waitFor({ state: 'detached' });
    }
    report.documents[mb] = stat(values);
    console.log(label, mb, report.documents[mb]);
  }
  if (label !== 'baseline') {
    await page.evaluate((file) => window.__picks.push([file]), files[1][0]);
    await expect(page.locator('.open-folder')).toBeEnabled();
    await page.keyboard.press('Control+o');
    await page.locator('.render-progress').waitFor({ state: 'detached' });
    await page.keyboard.press('Control+e');
    await page.locator('.cm-content').waitFor();
    await page.locator('.cm-content').press('Control+End');
    await page.evaluate(() => {
      window.__latencies = [];
      document.querySelector('.cm-content').addEventListener(
        'beforeinput',
        () => {
          const start = performance.now();
          requestAnimationFrame(() => window.__latencies.push(performance.now() - start));
        },
        true,
      );
    });
    for (let i = 0; i < 5; i++) {
      await page.keyboard.type('a');
      await page.waitForTimeout(600);
    }
    report.editLatency = stat(await page.evaluate(() => window.__latencies));
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(200);
    await expect(page.locator('.open-folder')).toBeEnabled();
    await page.keyboard.press('Control+w');
    await page.waitForTimeout(200);
    const cdp = await page.context().newCDPSession(page);
    const memory = [];
    for (let group = 0; group < 5; group++) {
      for (let i = 0; i < 5; i++) {
        await page.evaluate((file) => window.__picks.push([file]), files[1][0]);
        await expect(page.locator('.open-folder')).toBeEnabled();
        await page.keyboard.press('Control+o');
        await page.locator('.prose h1').filter({ hasText: 'Benchmark' }).waitFor();
        await page.locator('.render-progress').waitFor({ state: 'detached' });
        // This document remembers edit mode after the first round.
        await page.getByRole('button', { name: '编辑', exact: true }).click();
        await page.locator('.cm-content').waitFor();
        await page.getByRole('button', { name: '阅读', exact: true }).click();
        await expect(page.locator('.open-folder')).toBeEnabled();
        await page.keyboard.press('Control+w');
        await page
          .getByRole('heading', { name: 'Benchmark', exact: true })
          .waitFor({ state: 'detached' });
        await page.waitForTimeout(50);
      }
      await cdp.send('HeapProfiler.collectGarbage');
      memory.push((await cdp.send('Runtime.getHeapUsage')).usedSize);
    }
    report.closedDocumentHeap = memory;
    report.memoryPlateau = memory[4] <= memory[1] + 8 * 1024 * 1024;
  }
  const exact = join(root, 'boundary.md');
  await writeFile(exact, Buffer.alloc(32 * 1024 * 1024, 97));
  report.boundary32 =
    (await invoke('read_document', { path: exact })).content.length === 32 * 1024 * 1024;
  await writeFile(exact, Buffer.alloc(32 * 1024 * 1024 + 1, 97));
  try {
    await invoke('read_document', { path: exact });
    report.overLimitRejected = false;
  } catch {
    report.overLimitRejected = true;
  }
  for (const count of [1000, 10000]) {
    const dir = join(root, `workspace-${count}`);
    await mkdir(dir);
    for (let start = 0; start < count; start += 100)
      await Promise.all(
        Array.from({ length: Math.min(100, count - start) }, (_, i) =>
          writeFile(join(dir, `note-${start + i}.md`), '# 文档\n测试正文'),
        ),
      );
    await invoke('open_workspace', { path: dir });
    const scans = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await invoke('index_workspace', { path: dir });
      scans.push(Math.round(performance.now() - start));
    }
    report.index[count] = stat(scans);
    if (label !== 'baseline') {
      await expect(page.locator('.open-folder')).toBeEnabled();
      await page.evaluate(dir => window.__picks.push(dir), dir);
      await page.keyboard.press('Control+Shift+o');
      await expect(page.locator('.section-label').first()).toContainText(`workspace-${count}`);
      await expect(page.locator('.open-folder')).toBeEnabled();
      await page.keyboard.press('Control+p'); await page.locator('.quick-input').waitFor();
      await expect(page.locator('.feature-note').first()).not.toContainText('正在索引');
      await page.keyboard.press('Escape');
      const warm = [];
      for (let i=0;i<5;i++) {const start=performance.now();await page.keyboard.press('Control+p');await page.locator('.quick-input').waitFor();warm.push(performance.now()-start);await page.keyboard.press('Escape');await page.locator('.quick-input').waitFor({state:'detached'});}
      report.index[count].quickWarm = stat(warm);
    }

  }
} catch (e) {
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await writeFile(`artifacts/benchmark-${label}.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {}
}
