// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { markReadingMatches } from '../src/lib/reading-search';
it('counts inline matches once without crossing paragraphs or cells', () => {
  const root = document.createElement('article');
  root.innerHTML =
    '<p>中<strong>文</strong><a>搜索</a></p><p>中</p><p>文搜索</p><table><tr><td>中</td><td>文搜索</td></tr></table>';
  const matches = markReadingMatches(root, '中文搜索');
  expect(matches).toHaveLength(1);
  expect(matches[0]).toHaveLength(3);
  expect(root.querySelector('strong')?.textContent).toBe('文');
});
it('ignores enhancement controls and uses original Unicode offsets', () => {
  const root = document.createElement('article');
  root.innerHTML =
    '<p>İ AB ab</p><pre><code>ab</code><button class="copy-code">ab</button></pre><div class="katex">ab</div>';
  expect(markReadingMatches(root, 'ab', true)).toHaveLength(2);
});
