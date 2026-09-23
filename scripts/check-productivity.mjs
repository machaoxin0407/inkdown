// Native feature verification uses isolated app data and real filesystem commands.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, readdir, rm, rename, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const root = resolve('artifacts/productivity-' + Date.now()),
  data = join(root, 'data'),
  workspace = join(root, '文档 库');
await mkdir(workspace, { recursive: true });
const file = join(workspace, '阅读 位置.md'),
  other = join(workspace, '另一份.md');
const code = 'const 中文 = "<&>";\n  console.log(中文);\n';
const source =
  '# 阅读位置验证\n\n```js\n' +
  code +
  '```\n\n```mermaid\nflowchart LR\n A[阅读] --> B[继续]\n```\n\n$$E=mc^2$$\n\n' +
  Array.from(
    { length: 50 },
    (_, i) => `## 章节 ${i + 1}\n\n${('这是第' + (i + 1) + '节文字。').repeat(45)}\n\n`,
  ).join('');
await writeFile(file, source);
await writeFile(other, '# 另一份\n');
await mkdir(join(workspace, '子目录'));
await writeFile(join(workspace, '子目录', '另一份.md'), '# 子目录的另一份');
await mkdir(join(workspace, 'node_modules'));
await writeFile(join(workspace, 'node_modules', '隐藏.md'), '# hidden');
await Promise.all(
  Array.from({ length: 700 }, (_, i) => writeFile(join(workspace, `笔记-${i}.md`), '# note')),
);
let child, browser, page;
const results = [],
  errors = [];
const binary = resolve(process.env.INKDOWN_TEST_BINARY || 'src-tauri/target/release/inkdown.exe');
async function launch(args = []) {
  child = spawn(binary, args, {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      INKDOWN_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: join(root, 'profile'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
    },
  });
  for (let i = 0; i < 120; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!browser) throw Error('App did not start');
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.waitForURL((u) => u.href.startsWith('http://tauri.localhost'));
  await page.locator('.toolbar').waitFor();
  await page.evaluate(() => {
    window.__picks = [];
    const original = window.fetch.bind(window);
    window.fetch = (input, options) =>
      decodeURIComponent(String(input)).includes('plugin:dialog|')
        ? Promise.resolve(
            new Response(JSON.stringify(window.__picks.shift() ?? null), {
              headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
            }),
          )
        : original(input, options);
  });
}
async function stop() {
  if (child) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {}
  }
  await browser?.close().catch(() => {});
  browser = undefined;
  child = undefined;
  await new Promise((r) => setTimeout(r, 500));
}
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const pick = (value) => page.evaluate((value) => window.__picks.push(value), value);
const drafts = () => invoke('list_drafts');
const position = async () => (await invoke('read_positions')).find((p) => p.path === file);
async function open(path) {
  await pick([path]);
  await page.keyboard.press('Control+o');
  await expect(
    page.getByRole('tab', { name: path.split(/[\\/]/).pop(), exact: true }),
  ).toBeVisible();
}
try {
  await launch([file]);
  await page.locator('.copy-code').waitFor();
  await page.locator('.diagram-ready').waitFor();
  // Native clipboard: user gesture plus OS clipboard read via PowerShell.
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  await expect(page.locator('.copy-code')).toHaveText('已复制');
  const clipboard = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); [Console]::Write((Get-Clipboard -Raw))',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (clipboard.replace(/\r\n/g, '\n') !== code)
    throw Error('Clipboard content mismatch: ' + JSON.stringify(clipboard));
  results.push('native clipboard preserves Chinese, indentation, symbols and newline');
  await page.evaluate(() => {
    window.__originalCopy = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async () => {
      throw Error('test denied');
    };
  });
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  await expect(page.locator('.copy-code')).toHaveText('复制失败');
  await page.evaluate(() => (navigator.clipboard.writeText = window.__originalCopy));
  results.push('clipboard denial is reported');
  await page.locator('.preview-scroll').hover();
  await page.mouse.wheel(0, 2600);
  await expect.poll(async () => (await position())?.line || 0).toBeGreaterThan(10);
  const sectionAtTop = () =>
    page.locator('.preview-scroll').evaluate((host) => {
      const top = host.getBoundingClientRect().top;
      return [...host.querySelectorAll('h2')]
        .filter((el) => el.getBoundingClientRect().top <= top + 10)
        .at(-1)?.textContent;
    });
  const before = await position();
  const beforeSection = await sectionAtTop();
  await stop();
  await launch([file]);
  await page.locator('.prose h1').waitFor();
  await expect
    .poll(() => page.locator('.preview-scroll').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(1000);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Control+=');
  await expect
    .poll(() => page.locator('.preview-scroll').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(2000);
  await page.locator('.diagram-ready').waitFor();
  await expect.poll(sectionAtTop).toBe(beforeSection);
  const restored = await position();
  if (Math.abs(restored.line - before.line) > 2) throw Error('Reading position changed');
  results.push('reading position persists across restart and zoom reflow');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await expect.poll(async () => (await position())?.cursor || 0).toBeGreaterThan(1000);
  await stop();
  await launch([file]);
  await page.locator('.cm-content').waitFor();
  await expect
    .poll(() => page.locator('.cm-scroller').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(1000);
  results.push('editing mode and cursor viewport restored');
  const linkfile = join(root, '链接.md');
  await writeFile(linkfile, '# 跳转验证\n\n[跳到第35章](文档%20库/阅读%20位置.md#章节-35)');
  await open(linkfile);
  await page.getByRole('link', { name: '跳到第35章' }).click();
  await expect
    .poll(() =>
      page
        .locator('.prose h2')
        .filter({ hasText: /^章节 35$/ })
        .evaluate((el) =>
          Math.abs(
            el.getBoundingClientRect().top -
              el.closest('.preview-scroll').getBoundingClientRect().top,
          ),
        ),
    )
    .toBeLessThan(64);
  await page.locator('.diagram-ready').waitFor();
  await page.waitForTimeout(500);
  await expect
    .poll(() =>
      page
        .locator('.prose h2')
        .filter({ hasText: /^章节 35$/ })
        .evaluate((el) =>
          Math.abs(
            el.getBoundingClientRect().top -
              el.closest('.preview-scroll').getBoundingClientRect().top,
          ),
        ),
    )
    .toBeLessThan(64);
  results.push('explicit document anchor overrides restored editor and reading positions');
  await page.locator('.cm-content').fill('# 崩溃恢复\n\n我的未保存修改');
  await expect.poll(async () => (await drafts()).drafts.length).toBe(1);
  await page.keyboard.press('Control+n');
  await page.locator('.cm-content').fill('# 未命名草稿\n\n新的想法');
  await expect.poll(async () => (await drafts()).drafts.length).toBe(2);
  await stop();
  await writeFile(file, '# 外部修改\n');
  await launch();
  const recovery = page.getByRole('dialog', { name: '恢复未保存的草稿' });
  await recovery.waitFor();
  await expect(recovery.locator('.draft-row')).toHaveCount(2);
  await recovery.getByRole('button', { name: '稍后处理', exact: true }).click();
  await expect.poll(async () => (await drafts()).drafts.length).toBe(2);
  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await recovery.getByRole('button', { name: '恢复所选' }).click();
  await page.keyboard.press('Control+p');
  await page.getByRole('textbox', { name: '搜索文件名或路径' }).fill('阅读 位置');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-content')).toContainText('我的未保存修改');
  await page.keyboard.press('Control+s');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  if ((await readFile(file, 'utf8')) !== '# 外部修改\n') throw Error('Disk overwritten');
  await expect.poll(async () => (await drafts()).drafts.length).toBe(2);
  await page.keyboard.press('Control+s');
  await page.getByRole('button', { name: '覆盖磁盘版本', exact: true }).click();
  await expect.poll(async () => (await drafts()).drafts.length).toBe(1);
  results.push(
    'two crash drafts, defer and manual recovery, external conflict cancellation and save cleanup',
  );
  await page.keyboard.press('Control+w');
  await expect(page.getByRole('tab', { name: '阅读 位置.md', exact: true })).toHaveCount(0);
  await page.keyboard.press('Control+p');
  await page.getByRole('textbox', { name: '搜索文件名或路径' }).fill('未命名');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-content')).toContainText('新的想法');
  await page.keyboard.press('Control+w');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect.poll(async () => (await drafts()).drafts.length).toBe(1);
  await page.keyboard.press('Control+w');
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect.poll(async () => (await drafts()).drafts.length).toBe(0);
  // Give cancelled debounced writes time to fire; no ghost drafts allowed.
  await page.waitForTimeout(2300);
  if ((await drafts()).drafts.length) throw Error('Discarded draft reappeared');
  results.push('explicit discard cancels pending backups');
  await pick(workspace);
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('button', { name: '显示更多', exact: false }).waitFor();
  await expect(page.locator('.statusbar')).not.toContainText('正在处理');
  await page.keyboard.press('Control+p');
  await page.getByRole('textbox', { name: '搜索文件名或路径' }).fill('另一份');
  await expect(page.locator('.quick-result')).toHaveCount(2);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('.prose h1').waitFor();
  await page.keyboard.press('Control+p');
  await page.getByRole('textbox', { name: '搜索文件名或路径' }).fill('隐藏');
  await expect(page.locator('.quick-result')).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索文件名或路径' }).fill('笔记');
  await expect(page.locator('.quick-result')).toHaveCount(50);
  await page.screenshot({ path: 'artifacts/productivity-quick.png' });
  await writeFile(join(workspace, '刚刚新增.md'), '# fresh');
  await page.getByRole('textbox', { name: '搜索文件名或路径' }).fill('刚刚新增');
  await expect(page.locator('.quick-result')).toHaveCount(0);
  await page.getByRole('button', { name: '刷新索引', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.quick-result')).toHaveCount(1);
  await page.keyboard.press('Escape');
  for (let i = 0; i < 3 && (await page.locator('html').getAttribute('data-theme')) !== 'dark'; i++)
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.setViewportSize({ width: 760, height: 650 });
  await page.keyboard.press('Control+p');
  await page.getByRole('textbox', { name: '搜索文件名或路径' }).fill('另一份');
  await expect(page.locator('.quick-result')).toHaveCount(2);
  if (await page.locator('.quick-results').evaluate((el) => el.scrollWidth > el.clientWidth + 1))
    throw Error('Quick open horizontal overflow');
  await page.screenshot({ path: 'artifacts/productivity-narrow-dark.png' });
  await page.setViewportSize({ width: 1200, height: 820 });
  results.push('index refresh and dark narrow-window layout');
  await page.keyboard.press('Escape');
  results.push(
    'quick open indexes 703 Markdown files, excludes generated directories, handles duplicate names and caps visible results',
  );
  // Deleted original becomes a recovered untitled document.
  await open(other);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.cm-content').fill('# 删除后恢复');
  await expect.poll(async () => (await drafts()).drafts.length).toBe(1);
  await stop();
  await rm(other);
  await launch();
  await page.getByRole('button', { name: '恢复所选', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('删除后恢复');
  const output = join(workspace, '恢复副本.md');
  await pick(output);
  await page.keyboard.press('Control+s');
  await expect.poll(() => readFile(output, 'utf8').catch(() => '')).toBe('# 删除后恢复');
  results.push('missing original restores as untitled and saves separately');
  await expect.poll(async () => (await drafts()).drafts.length).toBe(0);
  await chmod(output, 0o444);
  await page.locator('.cm-content').fill('# 只读文件的草稿');
  await expect.poll(async () => (await drafts()).drafts.length).toBe(1);
  await page.keyboard.press('Control+s');
  await page.getByText(/文件为只读/).waitFor();
  await expect(page.locator('.cm-content')).toContainText('只读文件的草稿');
  await expect.poll(async () => (await drafts()).drafts.length).toBe(1);
  await chmod(output, 0o666);
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await drafts()).drafts.length).toBe(0);
  results.push('read-only save failure retains draft and editing content');
  await rename(join(data, 'drafts'), join(data, 'drafts-held'));
  await writeFile(join(data, 'drafts'), 'blocked');
  await page.locator('.cm-content').fill('# 备份失败仍保留编辑');
  await page.getByText(/本机备份或位置记录失败/).waitFor();
  await expect(page.locator('.cm-content')).toContainText('备份失败仍保留编辑');
  await rm(join(data, 'drafts'));
  await rename(join(data, 'drafts-held'), join(data, 'drafts'));
  await page.locator('.cm-content').fill('# 备份恢复后重试');
  await expect.poll(async () => (await drafts()).drafts.length).toBe(1);
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await drafts()).drafts.length).toBe(0);
  results.push('backup I/O failure retains content and retry succeeds');
  await writeFile(join(data, 'drafts', 'broken.json'), 'broken');
  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await page.getByRole('dialog', { name: '恢复未保存的草稿' }).waitFor();
  await expect(page.locator('.draft-row')).toHaveCount(0);
  if ((await readFile(join(data, 'drafts', 'broken.json'), 'utf8')) !== 'broken')
    throw Error('Corrupt backup deleted');
  await page.getByRole('button', { name: '稍后处理', exact: true }).click();
  await page.keyboard.press('Control+n');
  await page.locator('.cm-content').fill('# 待丢弃备份');
  await expect.poll(async () => (await drafts()).drafts.length).toBe(1);
  await stop();
  await launch();
  await page.getByRole('dialog', { name: '恢复未保存的草稿' }).waitFor();
  await page.getByRole('button', { name: '丢弃所选', exact: true }).click();
  await page.getByRole('button', { name: '确认丢弃', exact: true }).click();
  await expect.poll(async () => (await drafts()).drafts.length).toBe(0);
  results.push('corrupt backups isolated and retained; explicit recovery-list discard works');
  const shortened = join(root, '缩短验证.md');
  await writeFile(shortened, source);
  await open(shortened);
  await page.locator('.prose h1').filter({ hasText: '阅读位置验证' }).waitFor();
  await page.locator('.preview-scroll').hover();
  await page.mouse.wheel(0, 2300);
  await expect
    .poll(async () => (await invoke('read_positions')).find((p) => p.path === shortened)?.line || 0)
    .toBeGreaterThan(10);
  await page.keyboard.press('Control+w');
  await expect(page.getByRole('tab', { name: '缩短验证.md', exact: true })).toHaveCount(0);
  await writeFile(shortened, '# 已缩短');
  await open(shortened);
  await page.getByRole('heading', { name: '已缩短', exact: true }).waitFor();
  await expect.poll(() => page.locator('.preview-scroll').evaluate((el) => el.scrollTop)).toBe(0);
  results.push('reopening a shortened document clamps saved position');
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile('artifacts/productivity-report.json', JSON.stringify({ root, results }, null, 2));
  console.log(JSON.stringify({ root, results }, null, 2));
} catch (e) {
  console.log('Completed checks:', results);
  await page?.screenshot({ path: 'artifacts/productivity-failure.png' }).catch(() => {});
  throw e;
} finally {
  await stop();
}
