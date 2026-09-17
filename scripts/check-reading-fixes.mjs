import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const native = process.argv.includes('--native');
const source =
  '# 同步阅读测试\n\n' +
  Array.from(
    { length: 28 },
    (_, i) =>
      `## 章节 ${i + 1}\n\n${('这是第 ' + (i + 1) + ' 节的正文，用于检查换行后的对应位置。').repeat(5)}\n\n` +
      (i === 4
        ? '```mermaid\nflowchart TD\nA[开始阅读] -->|下一步| B[编辑文档]\nB --> C[同步预览]\n```\n\n'
        : '') +
      (i === 9 ? '$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n' : '') +
      (i === 15 ? '```typescript\n' + 'const value = 123;\n'.repeat(20) + '```\n\n' : ''),
  ).join('');
await mkdir('artifacts', { recursive: true });
let child, browser, page;
const results = [],
  errors = [];
try {
  if (native) {
    const file = resolve('artifacts/同步滚动测试.md');
    await writeFile(file, source);
    child = spawn(
      resolve(process.env.INKDOWN_TEST_BINARY || 'src-tauri/target/release/inkdown.exe'),
      [file],
      {
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
          WEBVIEW2_USER_DATA_FOLDER: resolve('artifacts/fixes-profile-' + Date.now()),
        },
      },
    );
    for (let i = 0; i < 100; i++) {
      try {
        browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (!browser) throw Error('Native app did not start');
    page = browser.contexts()[0].pages()[0];
    await page.waitForURL('http://tauri.localhost/**');
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
    await page.goto('http://127.0.0.1:1420');
  }
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.locator('.prose h1').waitFor();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.cm-content').fill(source);
  await page.getByRole('heading', { name: '同步阅读测试', exact: true }).waitFor();
  const editor = page.locator('.cm-scroller'),
    preview = page.locator('.preview-scroll');
  const check = async (name, fn) => {
    await fn();
    results.push({ name, passed: true });
    console.log('PASS', name);
  };
  for (const theme of ['light', 'dark'])
    await check(`Mermaid node and edge labels in ${theme}`, async () => {
      for (
        let i = 0;
        i < 3 && (await page.locator('html').getAttribute('data-theme')) !== theme;
        i++
      )
        await page.getByRole('button', { name: '切换主题', exact: true }).click();
      await page.waitForTimeout(250);
      await page.waitForFunction(() => !document.querySelector('.render-progress'));
      await expect(page.locator('.diagram-ready svg text')).not.toHaveCount(0);
      const text = await page.locator('.diagram-ready svg text').allTextContents();
      for (const label of ['开始阅读', '编辑文档', '同步预览', '下一步'])
        if (!text.join('').includes(label)) throw Error('Missing label ' + label);
      if (await page.locator('.diagram-ready foreignObject').count())
        throw Error('Unsafe HTML label');
      await page.locator('.diagram-ready').scrollIntoViewIfNeeded();
      for (const label of await page.locator('.diagram-ready svg text').all()) {
        if (!(await label.textContent())?.trim()) continue;
        if (
          !(await label.evaluate((el) => {
            const b = el.getBBox();
            const style = getComputedStyle(el);
            return b.width > 0 && b.height > 0 && style.display !== 'none' && style.fill !== 'none';
          }))
        )
          throw Error('Invisible text');
      }
      await page.screenshot({
        path: `artifacts/${native ? 'native-' : ''}diagram-${theme}-fixed.png`,
      });
    });
  const scrollEditor = async (ratio) => {
    await editor.evaluate(
      (el, r) => (el.scrollTop = (el.scrollHeight - el.clientHeight) * r),
      ratio,
    );
    await page.waitForTimeout(200);
    return preview.evaluate((el) => el.scrollTop);
  };
  await check('editor scroll moves preview down and up', async () => {
    await scrollEditor(0);
    const low = await scrollEditor(0.25),
      high = await scrollEditor(0.65),
      up = await scrollEditor(0.3);
    if (!(low > 0 && high > low && up < high)) throw Error(`Scroll failed ${low},${high},${up}`);
  });
  await check('top and bottom align', async () => {
    await scrollEditor(1);
    if (
      !(await preview.evaluate(
        (el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2,
      ))
    )
      throw Error('Bottom mismatch');
    if ((await scrollEditor(0)) > 1) throw Error('Top mismatch');
  });
  await check('source and preview stay near the same section', async () => {
    for (const ratio of [0.15, 0.35, 0.6, 0.8]) {
      await scrollEditor(ratio);
      const sections = await page.evaluate(() => {
        function firstSection(container, selector) {
          const top = container.getBoundingClientRect().top;
          for (const el of container.querySelectorAll(selector)) {
            if (el.getBoundingClientRect().bottom <= top) continue;
            const match = el.textContent.match(/章节\s*(\d+)|这是第\s*(\d+)/);
            if (match) return Number(match[1] || match[2]);
          }
        }
        return [
          firstSection(document.querySelector('.cm-scroller'), '.cm-line'),
          firstSection(document.querySelector('.preview-scroll'), 'h2,p'),
        ];
      });
      if (sections.some((n) => !n) || Math.abs(sections[0] - sections[1]) > 1)
        throw Error(`Section mismatch at ${ratio}: ${sections}`);
    }
  });
  await check('preview scroll remains independently usable', async () => {
    await scrollEditor(0.4);
    const before = await editor.evaluate((el) => el.scrollTop);
    await preview.evaluate((el) => (el.scrollTop += 200));
    await page.waitForTimeout(150);
    if (Math.abs((await editor.evaluate((el) => el.scrollTop)) - before) > 1)
      throw Error('Unexpected reverse scroll');
  });
  await check('sync survives pane resize and tab switch', async () => {
    const separator = page.getByRole('separator');
    await separator.focus();
    await page.keyboard.press('ArrowRight');
    await scrollEditor(0.3);
    await page.getByRole('button', { name: '新建文档', exact: true }).click();
    await page.locator('.cm-content').fill('# 短文档');
    await page.getByRole('tab').first().click();
    const a = await scrollEditor(0.2),
      b = await scrollEditor(0.7);
    if (!(b > a)) throw Error('Sync lost after tab switch');
  });
  await check('reading mode does not retain editor synchronization', async () => {
    await page.getByRole('button', { name: '阅读', exact: true }).click();
    await preview.evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(200);
    if ((await preview.evaluate((el) => el.scrollTop)) > 1) throw Error('Reading mode jumped');
  });
  if (errors.length) throw Error(errors.join('\n'));
} finally {
  await writeFile(
    `artifacts/${native ? 'native-' : ''}reading-fixes-report.json`,
    JSON.stringify({ results, errors }, null, 2),
  );
  await browser?.close();
  child?.kill();
}
