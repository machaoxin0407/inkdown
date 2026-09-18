import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const root = resolve('artifacts/pdf-tests-' + Date.now());
await mkdir(root, { recursive: true });
const file = join(root, '中文 文档.md');
const source =
  '# PDF 导出验证\n\n中文段落，保留可选择的文字。\n\n| 项目 | 状态 |\n| --- | --- |\n| 导出 | 正常 |\n\n$$E=mc^2$$\n\n```mermaid\nflowchart LR\nA[开始阅读] -->|下一步| B[导出文档]\n```\n\n![本地图片](picture.svg)\n\n```typescript\nconst value = "hello";\n```\n\n' +
  Array.from(
    { length: 20 },
    (_, i) => `## 第 ${i + 1} 节\n\n${'长文分页，保持自然阅读。'.repeat(14)}\n\n`,
  ).join('');
await writeFile(file, source);
await writeFile(
  join(root, 'picture.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="70"><rect width="400" height="70" fill="#e0ebda"/><text x="20" y="42" font-size="22">Local image / PDF</text></svg>',
);
let browser;
const child = spawn(
  resolve(process.env.INKDOWN_TEST_BINARY || 'src-tauri/target/release/inkdown.exe'),
  [file],
  {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
      WEBVIEW2_USER_DATA_FOLDER: join(root, 'profile'),
    },
  },
);
const results = [];
try {
  for (let i = 0; i < 120; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!browser) throw Error('Desktop startup failed');
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(30000);
  await page.getByRole('heading', { name: 'PDF 导出验证', exact: true }).waitFor();
  if (!page.url().startsWith('http://tauri.localhost')) throw Error('Expected bundled app');
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.evaluate(() => {
    window.__pdfPaths = [];
    const original = window.fetch.bind(window);
    window.fetch = (input, options) =>
      decodeURIComponent(String(input)).includes('plugin:dialog|save')
        ? Promise.resolve(
            new Response(JSON.stringify(window.__pdfPaths.shift() ?? null), {
              headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
            }),
          )
        : original(input, options);
  });
  async function exportTo(path) {
    await page.evaluate((p) => window.__pdfPaths.push(p), path);
    await page.keyboard.press('Control+Shift+p');
    await page.getByText('PDF 已导出', { exact: true }).waitFor();
    await expect(page.locator('.pdf-export-root')).toHaveCount(0);
  }
  const output = join(root, '中文 输出.pdf');
  await exportTo(output);
  if (!(await readFile(output)).subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw Error('Invalid PDF');
  results.push('native A4 multipage PDF with formula, diagram and local image');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.cm-content').fill('# 未保存编辑\n\n导出当前内容，不修改源文件。');
  for (let i = 0; i < 3 && (await page.locator('html').getAttribute('data-theme')) !== 'dark'; i++)
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
  const edited = join(root, '深色 未保存.pdf');
  await exportTo(edited);
  if ((await readFile(file, 'utf8')) !== source) throw Error('Source changed during export');
  results.push('dark theme and unsaved content; source unchanged');
  await page.evaluate(() => window.__pdfPaths.push(null));
  await page.keyboard.press('Control+Shift+p');
  await page.waitForTimeout(300);
  await expect(page.locator('.pdf-export-root')).toHaveCount(0);
  results.push('cancel leaves no export DOM');
  await chmod(edited, 0o444);
  try {
    await page.evaluate((p) => window.__pdfPaths.push(p), edited);
    await page.keyboard.press('Control+Shift+p');
    await page.getByText(/目标 PDF 为只读/).waitFor();
    await expect(page.locator('.pdf-export-root')).toHaveCount(0);
    results.push('read-only PDF fails safely and cleans up');
  } finally {
    await chmod(edited, 0o666);
  }
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    'artifacts/pdf-report.json',
    JSON.stringify({ root, output, edited, results }, null, 2),
  );
  console.log(JSON.stringify({ root, results }, null, 2));
} finally {
  await browser?.close();
  child.kill();
}
