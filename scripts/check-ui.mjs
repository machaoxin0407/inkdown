import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
const requests = [];
page.on('request', (request) => {
  if (!request.url().startsWith('http://127.0.0.1:1420') && !request.url().startsWith('data:'))
    requests.push(request.url());
});
const results = [];
async function check(name, fn) {
  console.log('CHECK', name);
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (e) {
    console.log(String(e));
    results.push({ name, passed: false, error: String(e) });
  }
}
await page.goto('http://127.0.0.1:1420');
await page.locator('.prose h1').waitFor();
await page.locator('.diagram-ready svg').waitFor({ timeout: 60000 });
await check('offline enhancements', async () => {
  if ((await page.locator('.katex').count()) !== 2) throw Error('Missing formulas');
  if ((await page.locator('input[type=checkbox]').count()) !== 3) throw Error('Missing tasks');
});
await page.screenshot({ path: 'artifacts/reading-light.png' });
await check('outline jump', async () => {
  await page.getByRole('button', { name: '大纲', exact: true }).click();
  await page.getByRole('button', { name: '让公式与图表说话', exact: true }).click();
  if ((await page.locator('.preview-scroll').evaluate((el) => el.scrollTop)) < 200)
    throw Error('Did not scroll');
});
await check('reading find', async () => {
  await page.keyboard.press('Control+f');
  await page.getByRole('textbox', { name: '在文档中查找' }).fill('文档');
  await page.getByRole('textbox', { name: '在文档中查找' }).press('Enter');
  if ((await page.locator('mark.search-hit').count()) < 2) throw Error('Missing search hits');
  await page.getByRole('button', { name: '关闭查找' }).click();
});
await check('source edit and live preview', async () => {
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const cm = page.locator('.cm-content');
  await cm.waitFor();
  await cm.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('# Live preview test\n\n');
  await page.getByRole('heading', { name: 'Live preview test', exact: true }).waitFor();
});
await page.screenshot({ path: 'artifacts/editing-light.png' });
await check('per-tab edits and undo', async () => {
  await page.getByRole('button', { name: '新建文档', exact: true }).click();
  await page.locator('.cm-content').waitFor();
  await page.locator('.cm-content').fill('# Second tab');
  await page.getByRole('tab', { name: '欢迎使用.md' }).click();
  if (!(await page.locator('.cm-content').innerText()).includes('Live preview test'))
    throw Error('Lost edit');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(250);
  if ((await page.locator('.cm-content').innerText()).includes('Live preview test'))
    throw Error('Undo lost across tabs');
});
await check('dirty close cancel and discard', async () => {
  await page.getByRole('button', { name: '关闭 未命名.md', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  if ((await page.getByRole('tab', { name: '未命名.md' }).count()) !== 1)
    throw Error('Cancel closed tab');
  await page.getByRole('button', { name: '关闭 未命名.md', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  if ((await page.getByRole('tab', { name: '未命名.md' }).count()) !== 0)
    throw Error('Discard did not close');
});
await check('dark theme', async () => {
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  if ((await page.locator('html').getAttribute('data-theme')) !== 'dark')
    throw Error('Theme failed');
});
await page.getByRole('button', { name: '阅读', exact: true }).click();
await page.locator('.preview-scroll').evaluate((el) => (el.scrollTop = 0));
await page.screenshot({ path: 'artifacts/reading-dark.png' });
for (const scale of [1.25, 1.5])
  await check(`layout ${scale * 100}%`, async () => {
    await page.setViewportSize({
      width: Math.round(1200 / scale),
      height: Math.round(820 / scale),
    });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw Error('Horizontal overflow');
    await page.screenshot({ path: `artifacts/scale-${scale}.png` });
  });
await browser.close();
const report = { results, errors, externalRequests: requests };
await writeFile('artifacts/ui-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (results.some((r) => !r.passed) || errors.length) process.exitCode = 1;
