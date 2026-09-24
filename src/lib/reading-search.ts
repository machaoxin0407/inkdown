/** A match can span inline nodes, but never paragraph/cell boundaries. */
export function markReadingMatches(
  root: HTMLElement,
  query: string,
  sensitive = false,
): HTMLElement[][] {
  const groups: HTMLElement[][] = [];
  if (!query) return groups;
  const boundary = 'p,h1,h2,h3,h4,h5,h6,li,td,th,pre';
  const excluded = 'svg,math,.katex,.diagram-source,.copy-code';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const runs: Text[][] = [];
  let owner: Element | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest(excluded)) {
      owner = null;
      continue;
    }
    const block = parent.closest(boundary) || root;
    if (block !== owner) {
      runs.push([]);
      owner = block;
    }
    runs[runs.length - 1].push(node as Text);
  }
  // RegExp preserves original UTF-16 offsets even for Unicode case folding.
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), sensitive ? 'gu' : 'giu');
  for (const nodes of runs) {
    const text = nodes.map((n) => n.data).join('');
    const ranges = [...text.matchAll(regex)].map((m) => ({
      start: m.index!,
      end: m.index! + m[0].length,
      marks: [] as HTMLElement[],
    }));
    let offset = 0;
    for (const node of nodes) {
      const end = offset + node.length;
      const hits = ranges.filter((r) => r.start < end && r.end > offset);
      if (hits.length) {
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        for (const hit of hits) {
          const start = Math.max(0, hit.start - offset),
            stop = Math.min(node.length, hit.end - offset);
          fragment.append(node.data.slice(cursor, start));
          const mark = document.createElement('mark');
          mark.className = 'search-hit';
          mark.textContent = node.data.slice(start, stop);
          fragment.append(mark);
          hit.marks.push(mark);
          cursor = stop;
        }
        fragment.append(node.data.slice(cursor));
        node.replaceWith(fragment);
      }
      offset = end;
    }
    groups.push(...ranges.map((r) => r.marks));
  }
  return groups;
}
