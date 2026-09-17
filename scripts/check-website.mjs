import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2] || 'artifacts/site');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/inkdown/')) throw Error('Outside base');
    const path = resolve(
      root,
      decodeURIComponent(url.pathname.slice('/inkdown/'.length)) || 'index.html',
    );
    if (path !== root && !path.startsWith(root + sep)) throw Error('Outside root');
    const bytes = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/inkdown/`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await mkdir('artifacts', { recursive: true });
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(base);
    await expect(page.locator('#version')).toHaveText(/^v\d+\.\d+\.\d+$/);
    if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)))
      throw Error('Horizontal overflow ' + width);
    for (const img of await page.locator('img').all())
      if (!(await img.evaluate((el) => el.complete && el.naturalWidth > 0)))
        throw Error('Broken screenshot');
    await page.screenshot({ path: `artifacts/website-${width}.png`, fullPage: true });
  }
  for (const link of await page.locator('a[href^="#"]').all()) {
    if (!(await page.locator(await link.getAttribute('href')).count()))
      throw Error('Broken anchor');
  }
  const release = await (await fetch(base + 'release.json')).json();
  for (const type of ['installer', 'portable', 'checksums']) {
    const href = await page.locator('#' + type).getAttribute('href');
    const response = await fetch(new URL(href, base));
    if (!response.ok) throw Error('Broken download');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.length !== release.assets[type].size ||
      createHash('sha256').update(bytes).digest('hex') !== release.assets[type].sha256
    )
      throw Error('Download mismatch');
  }
  await page.route('**/release.json', (route) => route.abort());
  await page.reload();
  await expect(page.locator('#release-status')).toContainText('GitHub 备用下载');
  await expect(page.locator('#installer')).toHaveAttribute(
    'href',
    'https://github.com/machaoxin0407/inkdown/releases/latest',
  );
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip')).toBeFocused();
  if (errors.length) throw Error(errors.join('\n'));
  console.log(
    'PASS responsive layouts, images, anchors, download hashes, fallback and keyboard entry',
  );
} finally {
  await browser.close();
  server.close();
}
