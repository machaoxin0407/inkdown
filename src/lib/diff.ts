export interface LineDiff { left: number[]; right: number[] }
/** Myers shortest edit script, returning changed one-based line numbers. */
export function lineDiff(left: string, right: string, budgetMs = 1800): LineDiff {
  const a = left.split('\n'), b = right.split('\n');
  const started = performance.now();
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length-prefix && suffix < b.length-prefix && a[a.length-1-suffix] === b[b.length-1-suffix]) suffix++;
  const n = a.length-prefix-suffix, m = b.length-prefix-suffix;
  const result: LineDiff = { left: [], right: [] };
  if (!n && !m) return result;
  if (n + m > 100000) throw new Error('差异较大，显示完整双栏');
  const v = new Map<number, number>([[1, 0]]), trace: Map<number, number>[] = [];
  for (let d = 0; d <= n+m; d++) {
    if (performance.now()-started > budgetMs || d > 2000) throw new Error('差异计算超时，显示完整双栏');
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k-1) ?? -1) < (v.get(k+1) ?? -1)) ? v.get(k+1) ?? 0 : (v.get(k-1) ?? 0)+1;
      let y = x-k;
      while (x < n && y < m && a[prefix+x] === b[prefix+y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) {
        for (let depth = d; depth >= 0; depth--) {
          const old = trace[depth], diagonal = x-y;
          const previousK = diagonal === -depth || (diagonal !== depth && (old.get(diagonal-1) ?? -1) < (old.get(diagonal+1) ?? -1)) ? diagonal+1 : diagonal-1;
          const previousX = old.get(previousK) ?? 0, previousY = previousX-previousK;
          while (x > previousX && y > previousY) { x--; y--; }
          if (!depth) break;
          if (x === previousX) result.right.push(prefix + y--);
          else result.left.push(prefix + x--);
        }
        result.left.reverse(); result.right.reverse(); return result;
      }
    }
  }
  return result;
}
