import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/lib/parse';
import { isMarkdown, localReference, pathKey } from '../src/lib/types';
describe('Markdown rendering boundary', () => {
  it('escapes raw HTML and rejects executable links', () => {
    const { html } = parseMarkdown(
      '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![x](https://evil.invalid/track.png)',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('网络或外部图片未加载');
  });
  it('supports headings, tables, tasks, code and isolated enhancement placeholders', () => {
    const { html, headings } = parseMarkdown(
      '# 同名\n\n## 同名\n\n|A|B|\n|-|-|\n|1|2|\n\n- [x] 完成\n- [ ] 计划\n\n$E=mc^2$\n\n$$\nx^2\n$$\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n```typescript\nconst x = 1;\n```',
    );
    expect(headings.map((h) => h.id)).toEqual(['heading-0', 'heading-1']);
    expect(html).toMatch(/<table(?:\s[^>]*)?>/);
    expect(html).toContain('type="checkbox" disabled checked');
    expect(html).toContain('data-math="inline"');
    expect(html).toContain('data-math="block"');
    expect(html).toContain('diagram-source');
    expect(html).toContain('hljs-keyword');
  });
  it('does not interpret formulas inside code fences or escaped dollars', () => {
    expect(parseMarkdown('`$x$`\n\n```text\n$x$\n```\n\n\\$x\\$').html).not.toContain('data-math');
  });
  it('blocks attribute injection in image paths', () => {
    const { html } = parseMarkdown('![" onerror="alert(1)](./a.png)');
    expect(html).toContain('&quot;');
    expect(html).not.toContain(' onerror="');
  });
  it('parses a 1 MB document with a generous regression bound', () => {
    const source = '# 大文档\n\n' + '一段普通文字。用于验证大文档排版。\n\n'.repeat(22000);
    const start = performance.now();
    const parsed = parseMarkdown(source);
    expect(parsed.html.length).toBeGreaterThan(source.length);
    expect(performance.now() - start).toBeLessThan(10000);
  });
});
describe('file references', () => {
  it('normalizes Windows identity and supports Unicode links', () => {
    expect(pathKey('C:\\Notes\\A.MD')).toBe(pathKey('c:/notes/a.md'));
    expect(localReference('C:\\笔记\\a.md', './%E4%B8%AD%E6%96%87.md#标题')).toBe(
      'C:\\笔记\\./中文.md',
    );
    expect(isMarkdown('a.MARKDOWN')).toBe(true);
  });
  it('rejects executable and absolute references', () => {
    for (const path of [
      'javascript:alert(1)',
      'file:///C:/a.md',
      '//server/a.md',
      'C:\\a.md',
      '/a.md',
    ])
      expect(() => localReference('C:\\a.md', path)).toThrow();
  });
});
