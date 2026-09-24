const originals = new WeakMap<Node, string>();
const key = (html: string) => html.replace(/ data-source-line="\d+"/g, '');
/** Monotonic reuse: repeated blocks retain their document order. */
export async function reconcileMarkup(target: HTMLElement, html: string, valid: () => boolean) {
  if (!target.children.length) {
    if (valid()) {
      target.innerHTML = html;
      for (const node of target.children) originals.set(node, key(node.outerHTML));
    }
    return;
  }
  const template = document.createElement('template');
  template.innerHTML = html;
  const incoming = [...template.content.children];
  const old = [...target.children];
  const byKey = new Map<string, { node: Element; index: number }[]>();
  old.forEach((node, index) => {
    const value = originals.get(node);
    if (value !== undefined) {
      const list = byKey.get(value) || [];
      list.push({ node, index });
      byKey.set(value, list);
    }
  });
  let cursor = target.firstElementChild,
    last = -1,
    started = performance.now();
  const retained = new Set<Element>();
  for (const next of incoming) {
    if (!valid()) return;
    const signature = key(next.outerHTML),
      candidates = byKey.get(signature);
    while (candidates?.length && candidates[0].index <= last) candidates.shift();
    const match = candidates?.shift();
    const node = match?.node || next;
    if (match) {
      last = match.index;
      const fresh = [next, ...next.querySelectorAll('[data-source-line]')];
      [node, ...node.querySelectorAll('[data-source-line]')].forEach((el, i) => {
        const line = fresh[i]?.getAttribute('data-source-line');
        if (line !== null && line !== undefined) el.setAttribute('data-source-line', line);
      });
    }
    originals.set(node, signature);
    retained.add(node);
    if (node !== cursor) target.insertBefore(node, cursor);
    cursor = node.nextElementSibling;
    if (performance.now() - started > 8) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      started = performance.now();
    }
  }
  if (valid())
    old.forEach((node) => {
      if (!retained.has(node)) node.remove();
    });
}
