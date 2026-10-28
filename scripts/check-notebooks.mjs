import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const root = resolve('artifacts/notebooks-' + Date.now());
await mkdir(root, { recursive: true });
const lib = join(root, 'library'),
  sources = join(root, 'sources');
await mkdir(lib);
await mkdir(sources);
const results = [],
  errors = [];
let browser, page, child;
const call = (command, args) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const picks = (...values) => page.evaluate((values) => window.__picks.push(...values), values);
const reloadLibrary = () => call('notebook_refresh', { root: lib });
const disk = (path) =>
  readFile(path, 'utf8').catch((e) => {
    if (e.code === 'ENOENT') return '';
    throw e;
  });
const check = async (name, work) => {
  try {
    await work();
    results.push({ name, passed: true });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, passed: false, error: String(e) });
    await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
    throw e;
  }
};
async function submitName(name) {
  const dialog = page.getByRole('dialog', { name: '笔记管理' });
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function confirmAction(name) {
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
try {
  child = spawn(
    resolve(process.env.INKDOWN_TEST_BINARY || 'src-tauri/target/debug/inkdown.exe'),
    [],
    {
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        INKDOWN_DATA_DIR: join(root, 'data'),
        WEBVIEW2_USER_DATA_FOLDER: join(root, 'profile'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9237',
      },
    },
  );
  for (let i = 0; i < 150; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9237');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!browser) throw Error('Desktop launch failed');
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.locator('.prose h1').waitFor();
  await page.evaluate(() => {
    window.__picks = [];
    const original = window.fetch.bind(window);
    window.fetch = (url, options) =>
      decodeURIComponent(String(url)).includes('plugin:dialog|')
        ? Promise.resolve(
            new Response(JSON.stringify(window.__picks.shift() ?? null), {
              headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
            }),
          )
        : original(url, options);
  });
  await check('create library, notebook, chapter and note through the desktop UI', async () => {
    await page.locator('.notebook-entry').click();
    await picks(lib);
    await page.getByRole('button', { name: '创建笔记库', exact: true }).click();
    await page.getByRole('button', { name: '新建笔记本', exact: true }).click();
    await submitName('计算机网络');
    await page.getByLabel('管理 计算机网络', { exact: true }).click();
    await page.getByRole('button', { name: '新建章节', exact: true }).click();
    await submitName('传输层');
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await submitName('三次握手');
    await expect(page.locator('.cm-content')).toBeVisible();
    await page
      .locator('.cm-content')
      .fill('# 三次握手\n\n我的理解：连接需要双方确认。\n\n[资料](https://example.com/tcp)');
    await expect
      .poll(() => readFile(join(lib, '计算机网络/传输层/三次握手.md'), 'utf8'))
      .toContain('双方确认');
    await expect(page.locator('.note-save-status')).toHaveText('已保存');
  });
  await check('second notebook, quick note switching and scoped search', async () => {
    await page.getByRole('button', { name: '新建笔记本', exact: true }).click();
    await submitName('复习');
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await submitName('索引');
    await expect(page.locator('.tab.active')).toContainText('索引.md');
    await expect(page.locator('.cm-content')).toBeEmpty();
    await page
      .locator('.cm-content')
      .fill('# 索引\n\n[三次握手](../计算机网络/传输层/三次握手.md#三次握手)\n\n记忆口诀');
    await expect(page.locator('.cm-content')).toContainText('记忆口诀');
    await page.getByRole('button', { name: '传输层', exact: true }).click();
    await page.locator('.notebook-card-body').filter({ hasText: '三次握手' }).click();
    await expect.poll(() => readFile(join(lib, '复习/索引.md'), 'utf8')).toContain('记忆口诀');
    await expect(page.locator('.cm-content')).toContainText('双方确认');
    await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill('记忆口诀');
    await expect(page.locator('.notebook-card-body')).toContainText('索引');
    await page.getByRole('textbox', { name: '搜索笔记', exact: true }).fill('');
  });
  await check(
    'clipboard image stored in the library with a portable relative reference',
    async () => {
      await page.locator('.cm-content').evaluate((el) => {
        const data = new DataTransfer();
        data.items.add(
          new File(
            [
              '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="70"><rect width="160" height="70" fill="#68866f"/></svg>',
            ],
            '示意.svg',
            { type: 'image/svg+xml' },
          ),
        );
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      });
      await expect
        .poll(() => readFile(join(lib, '计算机网络/传输层/三次握手.md'), 'utf8'))
        .toContain('../../assets/');
      await expect(page.locator('.prose img')).toHaveCount(1);
    },
  );
  await check(
    'move a note across notebooks updates outgoing pictures and incoming links',
    async () => {
      const l = await reloadLibrary(),
        book = l.items.find((i) => i.name === '复习');
      await page.getByLabel('管理 三次握手', { exact: true }).click();
      await page.getByRole('button', { name: '重命名或移动', exact: true }).last().click();
      const dialog = page.getByRole('dialog', { name: '笔记管理' });
      await dialog.getByLabel('位置', { exact: true }).selectOption(book.id);
      await dialog.getByRole('button', { name: '确定', exact: true }).click();
      await confirmAction('整理笔记位置与名称？');
      await expect.poll(() => disk(join(lib, '复习/三次握手.md'))).toContain('](<../assets/');
      await expect
        .poll(() => disk(join(lib, '复习/索引.md')))
        .toContain('](%E4%B8%89%E6%AC%A1%E6%8F%A1%E6%89%8B.md#三次握手)');
      await page.getByRole('button', { name: '复习', exact: true }).click();
      await expect(page.locator('.notebook-card-body')).toHaveCount(2);
    },
  );
  await check(
    'copy import markdown, shared image and cross-file links without changing originals',
    async () => {
      const first = '![图][figure]\n\n[另一份](<参考 B.md#说明>)\n\n[figure]: <图 1.svg> "说明"';
      await writeFile(
        join(sources, '图 1.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="2" y="20">图解</text></svg>',
      );
      await writeFile(join(sources, '参考 A.md'), first);
      await writeFile(join(sources, '参考 B.md'), '# 说明\n\n[另一份](<参考 A.md>)');
      await picks([join(sources, '参考 A.md'), join(sources, '参考 B.md')]);
      await page.getByRole('button', { name: '导入 Markdown', exact: true }).click();
      await confirmAction('复制导入 Markdown');
      await expect.poll(() => disk(join(lib, '复习/参考 A.md'))).toContain('../assets/');
      expect(await readFile(join(sources, '参考 A.md'), 'utf8')).toBe(first);
      await expect.poll(() => disk(join(lib, '复习/参考 B.md'))).toContain('[另一份](<参考 A.md>)');
    },
  );
  await check('trash and restore a note preserve its ID and do not delete images', async () => {
    const before = await reloadLibrary(),
      note = before.items.find((i) => i.name === '参考 A');
    await page.getByLabel('管理 参考 A', { exact: true }).click();
    await page
      .locator('.notebook-card')
      .filter({ hasText: '参考 A' })
      .getByRole('button', { name: '移入回收站', exact: true })
      .click();
    await confirmAction('移入回收站？');
    await page.getByRole('button', { name: /回收站 \(1\)/ }).click();
    await page.getByRole('button', { name: '恢复原位置', exact: true }).click();
    await confirmAction('恢复笔记？');
    await expect.poll(async () => (await reloadLibrary()).trash.length).toBe(0);
    expect((await reloadLibrary()).items.find((i) => i.name === '参考 A').id).toBe(note.id);
  });
  await check('external conflict preserves disk and unsaved editor content', async () => {
    await page.getByRole('button', { name: '复习', exact: true }).click();
    await page
      .locator('.notebook-card-body')
      .filter({ has: page.locator('strong', { hasText: /^三次握手$/ }) })
      .click();
    await page.locator('.cm-content').fill('# 我的修改');
    await writeFile(join(lib, '复习/三次握手.md'), '# 外部修改');
    await expect(page.locator('.external-banner')).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('我的修改');
    expect(await readFile(join(lib, '复习/三次握手.md'), 'utf8')).toBe('# 外部修改');
    await page
      .locator('.external-banner')
      .getByRole('button', { name: '重新加载', exact: true })
      .click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('外部修改');
  });
  await check(
    'reload restores library and selected notebook with usable Markdown files',
    async () => {
      await page.screenshot({ path: join(root, 'notebooks-desktop.png') });
      await page.reload();
      await expect(page.locator('.notebook-tree')).toBeVisible();
      expect((await reloadLibrary()).items.filter((i) => i.kind === 'notebook')).toHaveLength(2);
      await page.getByRole('button', { name: '复习', exact: true }).click();
      await expect(page.locator('.notebook-card-body')).toHaveCount(4);
      await page.screenshot({ path: join(root, 'notebooks-restored.png') });
    },
  );
  await check('drag sorting and notebook colors persist in metadata',async()=>{
    const first = page.locator('.notebook-card').filter({has:page.locator('strong',{hasText:/^索引$/})});
    const last = page.locator('.notebook-card').filter({has:page.locator('strong',{hasText:/^参考 B$/})});
    await last.dragTo(first);
    await expect.poll(async()=>{const l=await reloadLibrary(),b=l.items.find(i=>i.name==='复习');return l.items.filter(i=>i.kind==='note'&&i.parent===b.id).sort((a,b)=>a.order-b.order)[0]?.name;}).toBe('参考 B');
    await page.getByLabel('管理 复习',{exact:true}).click();
    await page.locator('.notebook-menu[open]').getByRole('button',{name:'颜色 #6285a8',exact:true}).click();
    await expect.poll(async()=>(await reloadLibrary()).items.find(i=>i.name==='复习').color).toBe('#6285a8');
  });
  await check('narrow windows collapse navigation and dark mode remains readable',async()=>{
    await page.setViewportSize({width:800,height:700});
    await expect(page.locator('.notebook-list')).not.toBeVisible();
    await page.getByRole('button',{name:'笔记列表',exact:true}).click();
    await expect(page.locator('.notebook-list')).toBeVisible();
    await expect(page.locator('.notebook-tree')).not.toBeVisible();
    await page.screenshot({path:join(root,'notebooks-narrow.png')});
    await page.setViewportSize({width:1200,height:820});
    await page.getByRole('button',{name:'显示或隐藏笔记本',exact:true}).click();
    await page.emulateMedia({colorScheme:'dark'});
    await expect.poll(()=>page.locator('.notebook-card-body strong').first().evaluate(el=>getComputedStyle(el).color)).toBe('rgb(221, 227, 218)');
    await page.screenshot({path:join(root,'notebooks-dark.png')});
    await page.emulateMedia({colorScheme:'light'});
  });
  await check(
    'partial structure writes are recoverable and never overwrite later edits',
    async () => {
      let l = await reloadLibrary();
      const book = l.items.find((i) => i.name === '复习');
      for (const [name, content] of [
        ['恢复目标', '# 目标'],
        ['恢复引用', '[目标](恢复目标.md)'],
      ])
        l = await call('notebook_create', {
          root: lib,
          expected: l.revision,
          parent: book.id,
          kind: 'note',
          name,
          content,
        });
      const note = l.items.find((i) => i.name === '恢复目标'),
        ref = join(lib, '复习/恢复引用.md');
      const d = await call('read_document', { path: ref });
      const plan = await call('notebook_prepare', {
        root: lib,
        expected: l.revision,
        itemId: note.id,
        action: 'move',
        parent: book.id,
        name: '恢复后',
      });
      await chmod(ref, 0o444);
      try {
        const outcome = await call('notebook_execute', {
          root: lib,
          planId: plan.id,
          edits: [
            {
              path: '复习/恢复引用.md',
              expected: d.fingerprint,
              content: '[目标](恢复后.md)',
              bom: false,
              newline: 'LF',
            },
          ],
        });
        expect(outcome.complete).toBe(false);
        expect(outcome.errors).toHaveLength(1);
        expect((await reloadLibrary()).pending).toContain(plan.id);
      } finally {
        await chmod(ref, 0o666);
      }
      await writeFile(ref, '# 后来的外部编辑');
      const conflict = await call('notebook_recover', {
        root: lib,
        operation: plan.id,
        acceptCurrent: false,
      });
      expect(conflict.complete).toBe(false);
      expect(await readFile(ref, 'utf8')).toBe('# 后来的外部编辑');
      const result = await call('notebook_recover', {
        root: lib,
        operation: plan.id,
        acceptCurrent: true,
      });
      expect(result.complete).toBe(true);
      expect(await readFile(ref, 'utf8')).toBe('# 后来的外部编辑');
      expect((await reloadLibrary()).items.find((i) => i.id === note.id).name).toBe('恢复后');
    },
  );
  await check(
    'metadata rebuild preserves Markdown and refuses nested chapters or stale versions',
    async () => {
      const separate = join(root, 'rebuild-library');
      await mkdir(separate);
      let l = await call('notebook_open', { path: separate, create: true, rebuild: false });
      l = await call('notebook_create', {
        root: separate,
        expected: l.revision,
        parent: '',
        kind: 'notebook',
        name: '数学',
        content: '',
      });
      const book = l.items[0];
      l = await call('notebook_create', {
        root: separate,
        expected: l.revision,
        parent: book.id,
        kind: 'chapter',
        name: '函数',
        content: '',
      });
      const chapter = l.items.find((i) => i.kind === 'chapter');
      await expect(
        call('notebook_create', {
          root: separate,
          expected: l.revision,
          parent: chapter.id,
          kind: 'chapter',
          name: '嵌套',
          content: '',
        }),
      ).rejects.toThrow('一层章节');
      await expect(
        call('notebook_create', {
          root: separate,
          expected: 'stale',
          parent: book.id,
          kind: 'note',
          name: '过时',
          content: '',
        }),
      ).rejects.toThrow('已变化');
      await writeFile(join(separate, '数学/函数/定义.md'), '# 函数定义');
      await writeFile(join(separate, '.inkdown/library.json'), '{broken');
      await expect(
        call('notebook_open', { path: separate, create: false, rebuild: false }),
      ).rejects.toThrow('元数据损坏');
      const rebuilt = await call('notebook_open', { path: separate, create: false, rebuild: true });
      expect(rebuilt.items.some((i) => i.name === '定义')).toBe(true);
      expect(await readFile(join(separate, '数学/函数/定义.md'), 'utf8')).toBe('# 函数定义');
    },
  );
  expect(errors).toEqual([]);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  child?.kill();
  console.log(root);
}
