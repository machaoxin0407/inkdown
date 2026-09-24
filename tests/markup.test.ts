// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { reconcileMarkup } from '../src/lib/markup';
import { readingPreferences, pdfPreferences, paperSize } from '../src/lib/preferences';
it('reuses repeated blocks in order, updates source lines and drops removed nodes', async () => {
  const el = document.createElement('article');
  await reconcileMarkup(
    el,
    '<p data-source-line="0">same</p><p data-source-line="2">same</p><p>tail</p>',
    () => true,
  );
  const [a, b, c] = [...el.children];
  await reconcileMarkup(
    el,
    '<h1>new</h1><p data-source-line="3">same</p><p data-source-line="5">same</p>',
    () => true,
  );
  expect(el.children[1]).toBe(a);
  expect(el.children[2]).toBe(b);
  expect(c.isConnected).toBe(false);
  expect(a.getAttribute('data-source-line')).toBe('3');
});
it('normalizes preferences and calculates oriented paper size', () => {
  expect(readingPreferences({ size: 99, lineHeight: NaN, width: 3 })).toMatchObject({
    size: 24,
    lineHeight: 1.7,
    width: 640,
  });
  expect(pdfPreferences({ top: -1, right: Infinity })).toMatchObject({ top: 5, right: 15 });
  expect(paperSize(pdfPreferences({ paper: 'Letter', landscape: true }))).toEqual([279.4, 215.9]);
});
