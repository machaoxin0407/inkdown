// End-to-end test against the actual release WebView. Native picker responses
// are injected; all filesystem reads/writes and rendering use the real backend.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, chmod, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const root = resolve('artifacts/native-fixtures-' + Date.now());
await mkdir(root, { recursive: true });
const file = join(root, '中文 空格.md');
await writeFile(file, '\ufeff# 本地测试\r\n\r\n原始内容\r\n');
const saveAs = join(root, '另存为.md');
const binary = resolve(process.env.INKDOWN_TEST_BINARY || 'src-tauri/target/release/inkdown.exe');
const started = performance.now();
const child = spawn(binary, [file], {
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
    WEBVIEW2_USER_DATA_FOLDER: resolve('artifacts/native-profile-' + Date.now()),
  },
  stdio: 'ignore',
});
let browser;
for (let i = 0; i < 80; i++) {
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 150));
  }
}
if (!browser) throw Error('Native WebView did not start');
const context = browser.contexts()[0],
  page = context.pages()[0];
await page.waitForURL((url) => url.href !== 'about:blank');
if (!page.url().startsWith('http://tauri.localhost')) {
  child.kill();
  throw new Error('Expected a bundled release, not a development server: ' + page.url());
}
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.getByRole('heading', { name: '本地测试', exact: true }).waitFor();
const loadedScript = await page.locator('script[type="module"]').getAttribute('src');
if (!(await readFile('dist/index.html', 'utf8')).includes(loadedScript)) {
  child.kill();
  throw Error('The executable does not contain the current frontend build.');
}
const startupMs = Math.round(performance.now() - started);
function sampleMemory() {
  try {
    return JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$all = Get-CimInstance Win32_Process; $ids = @(${child.pid}); do { $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | Select-Object -ExpandProperty ProcessId); $ids += $next } while ($next.Count -gt 0); $all | Where-Object { $_.ProcessId -in $ids } | Select-Object Name,ProcessId,WorkingSetSize,PrivatePageCount | ConvertTo-Json`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ),
    );
  } catch (e) {
    return { error: String(e) };
  }
}
const idleMemory = sampleMemory();
const installPicker = () =>
  page.evaluate(() => {
    window.__testDialogs = [];
    const original = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = decodeURIComponent(String(input));
      if (url.includes('plugin:dialog|open') || url.includes('plugin:dialog|save'))
        return Promise.resolve(
          new Response(JSON.stringify(window.__testDialogs.shift() ?? null), {
            headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
          }),
        );
      return original(input, options);
    };
  });
await installPicker();
const invoke = (command, args) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const picker = (value) => page.evaluate((value) => window.__testDialogs.push(value), value);
const results = [];
async function check(name, fn) {
  console.log('CHECK', name);
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (e) {
    console.log(String(e));
    results.push({ name, passed: false, error: String(e) });
    await page.screenshot({ path: 'artifacts/native-failure.png' }).catch(() => {});
  }
}
async function edit(text) {
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.cm-content').fill(text);
}
async function open(path) {
  await picker([path]);
  await page.keyboard.press('Control+o');
  await page.getByRole('tab', { name: path.split(/[\\/]/).pop(), exact: true }).waitFor();
}
await check('startup argument + UTF8 BOM CRLF save', async () => {
  await edit('# 保存测试\n\n修改内容\n');
  await page.keyboard.press('Control+s');
  await page.getByRole('status').filter({ hasText: '已保存到本地' }).waitFor();
  const bytes = await readFile(file);
  if (!bytes.equals(Buffer.from('\ufeff# 保存测试\r\n\r\n修改内容\r\n')))
    throw Error('BOM/CRLF mismatch');
});
await check('external conflict cancel and explicit overwrite', async () => {
  await page.locator('.cm-content').fill('# 我的修改\n');
  await writeFile(file, '# 外部修改\n');
  await page.keyboard.press('Control+s');
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  if ((await readFile(file, 'utf8')) !== '# 外部修改\n') throw Error('Cancel overwrote file');
  await page.keyboard.press('Control+s');
  await page.getByRole('button', { name: '覆盖磁盘版本', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
  if (!(await readFile(file, 'utf8')).includes('我的修改')) throw Error('Overwrite failed');
});
await check('save as retains original and updates tab path', async () => {
  await picker(saveAs);
  await page.keyboard.press('Control+Shift+s');
  if (await stat(saveAs).catch(() => null)) {
    if (
      await page
        .getByRole('button', { name: '替换', exact: true })
        .isVisible()
        .catch(() => false)
    )
      await page.getByRole('button', { name: '替换', exact: true }).click();
  }
  await page.getByRole('tab', { name: '另存为.md', exact: true }).waitFor();
  if (!(await readFile(saveAs, 'utf8')).includes('我的修改')) throw Error('Missing copy');
});
await check('duplicate open is one tab', async () => {
  await open(saveAs);
  if ((await page.getByRole('tab', { name: '另存为.md', exact: true }).count()) !== 1)
    throw Error('Duplicate tab');
});
await check('read only file preserves dirty buffer', async () => {
  await page.locator('.cm-content').fill('# 只读修改');
  await chmod(saveAs, 0o444);
  await page.keyboard.press('Control+s');
  await page.getByRole('alert').filter({ hasText: '只读' }).waitFor();
  if (!(await page.locator('.cm-content').innerText()).includes('只读修改'))
    throw Error('Lost buffer');
  await chmod(saveAs, 0o666);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
});
await check('invalid UTF8 reports error without opening', async () => {
  const invalid = join(root, 'invalid.md');
  await writeFile(invalid, Buffer.from([255, 254, 0]));
  await picker([invalid]);
  await page.keyboard.press('Control+o');
  await page.getByRole('alert').filter({ hasText: 'UTF-8' }).waitFor();
  if (await page.getByRole('tab', { name: 'invalid.md', exact: true }).count())
    throw Error('Invalid encoding opened');
});
await check('offline formulas diagrams local images', async () => {
  await open(resolve('examples/欢迎使用.md'));
  await page.locator('.diagram-ready svg').waitFor();
  await page.locator('.local-image').scrollIntoViewIfNeeded();
  await page.locator('.local-image img').waitFor();
  if ((await page.locator('.katex').count()) !== 2) throw Error('Missing formulas');
  const requests = [];
  page.on('request', (req) => {
    if (
      /^https?:/.test(req.url()) &&
      !req.url().startsWith('http://tauri.localhost') &&
      !req.url().startsWith('http://ipc.localhost')
    )
      requests.push(req.url());
  });
  try {
    await context.setOffline(true);
    await page.reload();
    await page.locator('.diagram-ready svg').waitFor();
    if (requests.length) throw Error('Network requests: ' + requests);
  } finally {
    await context.setOffline(false);
    await page.reload();
    await page.locator('.prose h1').waitFor();
    await installPicker();
  }
  await page.screenshot({ path: 'artifacts/native-reading.png' });
});
await check('malformed enhancement isolation + injection defense', async () => {
  await open(resolve('examples/功能验证.md'));
  await page.locator('.diagram-source.render-error').waitFor();
  if ((await page.locator('.render-error').count()) < 2) throw Error('Missing isolated errors');
  if (await page.locator('.prose script,.prose iframe,.prose [onerror]').count())
    throw Error('Executable markup');
  if (await page.locator('.prose img[src^="http"]').count()) throw Error('Remote image');
});
await check('relative document link navigation', async () => {
  await page.getByRole('link', { name: '返回欢迎文档' }).click();
  await page.getByRole('tab', { name: '欢迎使用.md', exact: true, selected: true }).waitFor();
});
await check('single instance forwards file arguments', async () => {
  const forwarded = join(root, 'forwarded.md');
  await writeFile(forwarded, '# Forwarded');
  const second = spawn(binary, [forwarded], { windowsHide: true, stdio: 'ignore' });
  await page.getByRole('heading', { name: 'Forwarded', exact: true }).waitFor();
  await new Promise((resolve) =>
    second.exitCode !== null ? resolve() : second.on('exit', resolve),
  );
  if ((await page.getByRole('tab', { name: 'forwarded.md', exact: true }).count()) !== 1)
    throw Error('File not forwarded');
});
await check('window close preserves unsaved edits on cancel', async () => {
  await page.keyboard.press('Control+n');
  await page.locator('.cm-content').fill('# 未保存内容');
  await invoke('plugin:window|close', { label: 'main' });
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  if (!(await page.locator('.cm-content').innerText()).includes('未保存内容'))
    throw Error('Lost changes on close');
  await page.getByRole('button', { name: '关闭 未命名.md', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
});
let largeMs = 0;
await check('1 MB document', async () => {
  const large = join(root, 'large.md');
  const text =
    '# 大文档\n\n' + '中文大文件测试，正文中的普通段落，用于检查渲染响应。\n\n'.repeat(13000);
  await writeFile(large, text);
  const t = performance.now();
  await open(large);
  await page.getByRole('heading', { name: '大文档', exact: true }).waitFor();
  largeMs = Math.round(performance.now() - t);
  if (largeMs > 10000) throw Error('Large document took ' + largeMs + ' ms');
});
await check('large folder lazy paging', async () => {
  const many = join(root, 'many');
  await mkdir(many, { recursive: true });
  await Promise.all(
    Array.from({ length: 700 }, (_, i) => writeFile(join(many, `note-${i}.md`), '# Note')),
  );
  await picker(many);
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('button', { name: '显示更多', exact: false }).waitFor();
  const count = await page.locator('.tree-row').count();
  if (count > 170) throw Error('Directory was not paged');
});
let memory;
try {
  memory = JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$all = Get-CimInstance Win32_Process; $ids = @(${child.pid}); do { $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | Select-Object -ExpandProperty ProcessId); $ids += $next } while ($next.Count -gt 0); $all | Where-Object { $_.ProcessId -in $ids } | Select-Object Name,ProcessId,WorkingSetSize | ConvertTo-Json`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
} catch (e) {
  memory = { error: String(e) };
}
await writeFile(
  'artifacts/native-report.json',
  JSON.stringify({ results, errors, startupMs, largeMs, idleMemory, memory }, null, 2),
);
console.log(JSON.stringify({ results, errors, startupMs, largeMs, idleMemory, memory }, null, 2));
await browser.close();
child.kill();
if (results.some((r) => !r.passed) || errors.length) process.exitCode = 1;
