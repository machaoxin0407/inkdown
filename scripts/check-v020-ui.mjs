import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
const results = [],
  errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, passed: false, error: String(e) });
    console.log('FAIL', name, String(e));
  }
}
try {
  await page.goto('http://127.0.0.1:1420');
  await page.locator('.prose h1').waitFor();
  await page.keyboard.press('Control+n');
  await page
    .locator('.cm-content')
    .fill(
      '# Search\n\n中**文**[搜索](https://example.com)\n\n## Next\n\nAB ab\n\n```mermaid\nflowchart LR\n A-->B\n```',
    );
  await page.locator('.diagram-ready').waitFor();
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await check('cross inline search and closed search remains closed', async () => {
    await page.keyboard.press('Control+f');
    await page.getByRole('textbox', { name: '在文档中查找' }).fill('中文搜索');
    await expect(page.locator('mark.search-hit')).toHaveCount(3);
    await expect(page.locator('.preview-find')).toContainText('1/1');
    await page.getByRole('button', { name: '关闭查找', exact: true }).click();
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await page.waitForTimeout(600);
    await expect(page.locator('mark.search-hit')).toHaveCount(0);
  });
  await check('unchanged diagram survives editing', async () => {
    await page.locator('.diagram-ready').evaluate((el) => (window.__diagram = el));
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('.cm-content').press('Control+End');
    await page.keyboard.type('\n\nnew text');
    await page.waitForTimeout(600);
    expect(await page.locator('.diagram-ready').evaluate((el) => el === window.__diagram)).toBe(
      true,
    );
  });
  await check('link and table are undoable transactions', async () => {
    await page.getByRole('button', { name: '表格', exact: true }).click();
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('| 列 1');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.cm-content')).not.toContainText('| 列 1');
    await page.getByRole('button', { name: '链接', exact: true }).click();
    await page.getByLabel('链接文字', { exact: true }).fill('插入链接');
    await page.getByLabel('链接地址', { exact: true }).fill('https://example.com');
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('[插入链接](<https://example.com>)');
  });
  await check('outline filter and reading preferences', async () => {
    await page.getByRole('button', { name: '大纲', exact: true }).click();
    await page.getByRole('textbox', { name: '过滤标题' }).fill('Next');
    await expect(page.locator('.outline-item')).toHaveCount(2);
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('字号（px）').fill('22');
    await page.getByLabel('正文宽度（px）').fill('1000');
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect(page.locator('.prose')).toHaveCSS('font-size', '22px');
  });
  await check('minimum window and 200 percent zoom', async () => {
    await page.setViewportSize({ width: 760, height: 520 });
    for (let i = 0; i < 10; i++) await page.keyboard.press('Control++');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'artifacts/v020-minimum.png' });
  });
} finally {
  await writeFile('artifacts/v020-ui-report.json', JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
if (errors.length || results.some((r) => !r.passed)) process.exitCode = 1;
