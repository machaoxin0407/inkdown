import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const root = resolve('artifacts/v020-native-' + Date.now()),
  workspace = join(root, '文档 库');
await mkdir(join(workspace, '子目录'), { recursive: true });
const file = join(workspace, '测试.md'),
  other = join(workspace, '子目录', '另一份.md');
await writeFile(file, '# 测试\n\n初始内容\n\n## 第二章\n\n第二章正文');
await writeFile(other, '# 另一份\n\n工作区命中');
const child = spawn(
  resolve(process.env.INKDOWN_TEST_BINARY || 'src-tauri/target/release/inkdown.exe'),
  [file],
  {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      INKDOWN_DATA_DIR: join(root, 'data'),
      WEBVIEW2_USER_DATA_FOLDER: join(root, 'profile'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
    },
  },
);
let browser, page;
const results = [],
  errors = [];
async function check(name, fn) {
  try {
    await expect(page.locator('.open-folder')).toBeEnabled();
    await fn();
    results.push({ name, passed: true });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, passed: false, error: String(e) });
    console.log('FAIL', name, String(e));
  }
}
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
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.locator('.prose h1').waitFor();
  await page.evaluate(() => {
    window.__picks = [];
    window.__calls = {};
    const fetch = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      const s = decodeURIComponent(String(url));
      window.__calls[s] = (window.__calls[s] || 0) + 1;
      if (s.includes('read_document') && window.__delayRead) {
        const delay = window.__delayRead;
        window.__delayRead = 0;
        return fetch(url, opts).then(async (response) => {
          window.__readDelayed = true;
          await new Promise((r) => setTimeout(r, delay));
          return response;
        });
      }
      return s.includes('plugin:dialog|')
        ? Promise.resolve(
            new Response(JSON.stringify(window.__picks.shift() ?? null), {
              headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
            }),
          )
        : fetch(url, opts);
    };
  });
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  const pick = (value) => page.evaluate((v) => window.__picks.push(v), value);
  await check('clean external updates automatically; dirty content is protected', async () => {
    await page.waitForTimeout(700);
    await writeFile(file, '# 自动更新\n\n外部内容');
    await expect(page.locator('.prose h1')).toHaveText('自动更新');
    await page.evaluate(() => {
      window.__delayRead = 1000;
      window.__readDelayed = false;
    });
    await writeFile(file, '# 磁盘新内容');
    await page.waitForFunction(() => window.__readDelayed);
    await page.keyboard.press('Control+e');
    await page.locator('.cm-content').fill('# 本机未保存');
    await expect(page.locator('.external-banner')).toBeVisible();
    await expect(page.locator('.cm-content')).toHaveText('# 本机未保存');
    await page.keyboard.press('Control+w');
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await expect(page.locator('.open-folder')).toBeEnabled();
  });
  await pick(workspace);
  await page.keyboard.press('Control+Shift+o');
  await expect(page.locator('.section-label').first()).toContainText('文档 库');
  await check('tree expansion survives refresh and creation', async () => {
    await page.getByRole('button', { name: '子目录', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '另一份.md', exact: true }).first(),
    ).toBeVisible();
    await page.getByRole('button', { name: '刷新文件树' }).click();
    await expect(
      page.getByRole('button', { name: '另一份.md', exact: true }).first(),
    ).toBeVisible();
    await writeFile(join(workspace, '新增.md'), '# 新增');
    await expect(page.getByRole('button', { name: '新增.md', exact: true }).first()).toBeVisible();
  });
  await check('workspace search includes disk and unsaved overlays', async () => {
    await page.getByRole('button', { name: '测试.md', exact: true }).first().click();
    await page.keyboard.press('Control+e');
    await page.locator('.cm-content').fill('# 未保存搜索词');
    await page.keyboard.press('Control+Shift+f');
    await page.getByLabel('搜索工作区正文', { exact: true }).fill('未保存搜索词');
    await expect(page.locator('.workspace-hit')).toHaveCount(1);
    await page.locator('.workspace-hit').click();
    await expect(page.locator('.cm-content')).toHaveText('# 未保存搜索词');
    const result = await invoke('search_workspace', {
      path: workspace,
      query: '工作区命中',
      sensitive: false,
      overlays: [],
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].line).toBe(3);
    await page.keyboard.press('Control+s');
  });
  await check('quick open reuses index and opens within 100 ms when warm', async () => {
    await page.keyboard.press('Control+p');
    await expect(page.locator('.feature-note').first()).not.toContainText('正在索引');
    await page.keyboard.press('Escape');
    const before = await page.evaluate(() =>
      Object.entries(window.__calls)
        .filter(([k]) => k.includes('index_workspace'))
        .reduce((n, [, v]) => n + v, 0),
    );
    const values = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await page.keyboard.press('Control+p');
      await page.locator('.quick-input').waitFor();
      values.push(performance.now() - start);
      await page.keyboard.press('Escape');
    }
    const after = await page.evaluate(() =>
      Object.entries(window.__calls)
        .filter(([k]) => k.includes('index_workspace'))
        .reduce((n, [, v]) => n + v, 0),
    );
    expect(after).toBe(before);
    results.push({
      name: 'warm quick open timings',
      values,
      p95: Math.max(...values),
      passed: Math.max(...values) <= 100,
    });
  });
  await check('file rename, creation collision and attachment boundaries', async () => {
    await page.getByRole('button', { name: '文件', exact: true }).click();
    const row = page
      .locator('.tree-item')
      .filter({ has: page.getByRole('button', { name: '测试.md', exact: true }) });
    await row.locator('summary').click();
    await row.getByRole('button', { name: '重命名', exact: true }).click();
    await page.getByLabel('文件名', { exact: true }).fill('改名.md');
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await expect(page.getByRole('tab', { name: '改名.md', exact: true })).toBeVisible();
    expect(await readFile(join(workspace, '改名.md'), 'utf8')).toContain('未保存搜索词');
    const path = await invoke('create_entry', {
      parent: workspace,
      name: '新文件.md',
      directory: false,
    });
    expect(path).toContain('新文件.md');
    let rejected = false;
    try {
      await invoke('create_entry', { parent: workspace, name: '新文件.md', directory: false });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    rejected = false;
    try {
      await invoke('create_entry', { parent: workspace, name: '../越界.md', directory: false });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    const image = join(root, 'image.svg');
    await writeFile(
      image,
      '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="red"/></svg>',
    );
    await pick(image);
    await page.getByRole('button', { name: '图片', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('assets/image-');
    expect((await readdir(join(workspace, 'assets'))).length).toBe(1);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.cm-content')).not.toContainText('assets/image-');
  });
  await check('PDF Letter landscape and margins export', async () => {
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel(/^纸张/).selectOption('Letter');
    await page.getByLabel('横向', { exact: true }).check();
    await page.getByLabel('上页边距（mm）').fill('20');
    await page.getByLabel('显示页码（原生页眉页脚）').check();
    await page.screenshot({ path: 'artifacts/v020-settings.png' });
    await page.getByRole('button', { name: '保存设置' }).click();
    const output = join(root, 'letter.pdf');
    await pick(output);
    await page.keyboard.press('Control+Shift+p');
    await expect(page.locator('.toast')).toContainText('PDF 已导出');
    expect((await readFile(output)).subarray(0, 5).toString()).toBe('%PDF-');
    results.push({ name: 'PDF output', path: output, passed: true });
  });
  await check('pasted images honor save cancellation and remain undoable', async () => {
    await page.keyboard.press('Control+n');
    await page.locator('.cm-content').waitFor();
    const paste = () =>
      page.locator('.cm-content').evaluate((el) => {
        const dt = new DataTransfer();
        dt.items.add(
          new File(
            [
              '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
            ],
            'paste.svg',
            { type: 'image/svg+xml' },
          ),
        );
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      });
    const count = (await readdir(join(workspace, 'assets'))).length;
    await pick(null);
    await paste();
    await expect(page.locator('.open-folder')).toBeEnabled();
    await expect(page.locator('.cm-content')).not.toContainText('assets/');
    expect((await readdir(join(workspace, 'assets'))).length).toBe(count);
    await pick(join(workspace, '粘贴.md'));
    await paste();
    await expect(page.locator('.cm-content')).toContainText('assets/image-');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.cm-content')).not.toContainText('assets/');
    expect((await readdir(join(workspace, 'assets'))).length).toBe(count + 1);
  });
  await page.screenshot({ path: 'artifacts/v020-native.png' });
} catch (e) {
  errors.push(String(e));
  console.error(e);
} finally {
  await writeFile(
    'artifacts/v020-native-report.json',
    JSON.stringify({ results, errors, root }, null, 2),
  );
  await browser?.close();
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {}
}
if (errors.length || results.some((r) => !r.passed)) process.exitCode = 1;
