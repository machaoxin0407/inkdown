import { describe, it, expect } from 'vitest';
import { normalizeZoom } from '../src/lib/zoom';
describe('saved document zoom', () => {
  it('migrates missing or invalid preferences to 100%', () => {
    for (const value of [undefined, null, '', 'invalid', Infinity, NaN])
      expect(normalizeZoom(value)).toBe(100);
  });
  it('clamps and rounds preferences to supported increments', () => {
    expect(normalizeZoom(500)).toBe(200);
    expect(normalizeZoom(-10)).toBe(50);
    expect(normalizeZoom('130')).toBe(130);
    expect(normalizeZoom(124)).toBe(120);
  });
});
