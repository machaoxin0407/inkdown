import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const native = process.argv.includes('--native');
const root = resolve('artifacts/zoom-' + Date.now());
await mkdir(root, { recursive: true });
const source =
  '# 缩放验证\n\n' +
  Array.from(
    { length: 35 },
    (_, i) => `## 章节 ${i + 1}\n\n${`这是第 ${i + 1} 节的正文。`.repeat(18)}\n\n`,
  ).join('');
const file = join(root, '缩放 文档.md');
await writeFile(file, source);
let child, browser;
const results = [];
try {
  let page;
  if (native) {
    child = spawn(
      resolve(process.env.INKDOWN_TEST_BINARY || 'src-tauri/target/release/inkdown.exe'),
      [file],
      {
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          INKDOWN_DATA_DIR: join(root, 'app-data'),
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
          WEBVIEW2_USER_DATA_FOLDER: join(root, 'profile'),
        },
      },
    );
    for (let i = 0; i < 100; i++) {
      try {
        browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!browser) throw Error('Startup failed');
    page = browser.contexts()[0].pages()[0];
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    await page.goto('http://127.0.0.1:1420');
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.locator('.prose h1').waitFor();
  const group = page.getByRole('group', { name: '文档缩放' });
  const zoom = (value) => expect(group.locator('.zoom-reset')).toHaveText(value + '%');
  await zoom(100);
  const toolbar = await page.locator('.toolbar').boundingBox();
  await page.getByRole('button', { name: '放大文档', exact: true }).click();
  await zoom(110);
  if ((await page.locator('.prose').evaluate((el) => Number(getComputedStyle(el).zoom))) !== 1.1)
    throw Error('Preview zoom not applied');
  await group.locator('.zoom-reset').click();
  await zoom(100);
  results.push('toolbar zoom and reset');
  await page.keyboard.press('Control+=');
  await zoom(110);
  await page.keyboard.press('Control+-');
  await zoom(100);
  for (let i = 0; i < 14; i++) await page.keyboard.press('Control+=');
  await zoom(200);
  await expect(page.getByRole('button', { name: '放大文档', exact: true })).toBeDisabled();
  for (let i = 0; i < 18; i++) await page.keyboard.press('Control+-');
  await zoom(50);
  await expect(page.getByRole('button', { name: '缩小文档', exact: true })).toBeDisabled();
  await page.keyboard.press('Control+0');
  await zoom(100);
  results.push('shortcuts and bounds');
  await page.locator('.preview-scroll').hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await zoom(110);
  const after = await page.locator('.toolbar').boundingBox();
  if (Math.abs(after.height - toolbar.height) > 1 || Math.abs(after.width - toolbar.width) > 1)
    throw Error('Browser chrome was zoomed');
  results.push('Ctrl wheel scales content only');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.cm-content').fill(source);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+=');
  await zoom(150);
  await expect(page.locator('.cm-editor')).toHaveCSS('font-size', '21px');
  await page.keyboard.press('Control+Home');
  await expect(page.locator('.cm-content')).toContainText('缩放验证');
  const editor = page.locator('.cm-scroller'),
    preview = page.locator('.preview-scroll');
  await editor.evaluate((el) => (el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.6));
  await page.waitForTimeout(300);
  if ((await preview.evaluate((el) => el.scrollTop)) < 100) throw Error('Scroll sync lost');
  const sections = await page.evaluate(() => {
    const first = (host, selector) => {
      for (const el of host.querySelectorAll(selector)) {
        if (el.getBoundingClientRect().bottom <= host.getBoundingClientRect().top) continue;
        const m = el.textContent.match(/章节\s*(\d+)|这是第\s*(\d+)/);
        if (m) return Number(m[1] || m[2]);
      }
    };
    return [
      first(document.querySelector('.cm-scroller'), '.cm-line'),
      first(document.querySelector('.preview-scroll'), 'h2,p'),
    ];
  });
  if (sections.some((x) => !x) || Math.abs(sections[0] - sections[1]) > 1)
    throw Error('Zoomed scroll section mismatch ' + sections);
  results.push('editor font, retained content and semantic scroll sync');
  await page.screenshot({ path: 'artifacts/zoom-editing.png' });
  await page.getByRole('button', { name: '新建文档', exact: true }).click();
  await zoom(150);
  await expect(page.locator('.cm-editor')).toHaveCSS('font-size', '21px');
  await page.getByRole('tab').first().click();
  await zoom(150);
  results.push('zoom survives tab changes');
  if (native) {
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      window.fetch = (input, options) =>
        decodeURIComponent(String(input)).includes('plugin:dialog|save')
          ? Promise.resolve(
              new Response(JSON.stringify(null), {
                headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
              }),
            )
          : original(input, options);
    });
  }
  await page.reload();
  await page.locator('.prose h1').waitFor();
  await zoom(150);
  results.push('saved zoom restored on reload');
  await page.setViewportSize({ width: 760, height: 700 });
  const box = await group.boundingBox();
  if (!box || box.x < 0 || box.x + box.width > (await page.evaluate(() => innerWidth)))
    throw Error('Zoom toolbar clipped');
  await page.screenshot({ path: 'artifacts/zoom-narrow.png' });
  results.push('narrow window controls remain visible');
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile('artifacts/zoom-report.json', JSON.stringify({ native, results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  child?.kill();
}
