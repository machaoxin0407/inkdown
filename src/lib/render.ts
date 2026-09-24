import DOMPurify from 'dompurify';
import { api, desktop } from './api';
import type { Heading } from './types';
type Parsed = { html: string; headings: Heading[]; blocks?: { line: number; end: number }[] };
type Job = {
  id: number;
  owner: string;
  source: string;
  resolve: (result: Parsed) => void;
  reject: (e: Error) => void;
};
let worker: Worker | undefined,
  active: Job | undefined,
  seq = 0;
const queued = new Map<string, Job>();
function pump() {
  if (active || !queued.size) return;
  if (!worker) {
    worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = active;
      active = undefined;
      if (job && job.id === data.id) {
        if (data.error) job.reject(new Error(data.error));
        else
          job.resolve({
            ...data,
            html: DOMPurify.sanitize(data.html, {
              ADD_ATTR: ['data-math', 'data-image', 'data-alt'],
              FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'form'],
            }),
          });
      }
      pump();
    };
    worker.onerror = () => {
      const error = new Error('渲染进程出错，请重试');
      active?.reject(error);
      active = undefined;
      queued.forEach((job) => job.reject(error));
      queued.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  active = queued.values().next().value!;
  queued.delete(active.owner);
  worker.postMessage({ id: active.id, source: active.source });
}
export function cancelParse(owner: string) {
  queued.get(owner)?.reject(new DOMException('已取消', 'AbortError'));
  queued.delete(owner);
  if (active?.owner === owner) active.reject(new DOMException('已取消', 'AbortError'));
}
export function parse(source: string, owner = 'export-' + ++seq): Promise<Parsed> {
  queued.get(owner)?.reject(new DOMException('已取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    queued.set(owner, { id: ++seq, owner, source, resolve, reject });
    pump();
  });
}
const imageCache = new Map<string, string>();
let imageBytes = 0;
export function clearImageCache() {
  imageCache.clear();
  imageBytes = 0;
}
async function imageSource(path: string, reference: string) {
  const key = path + '\0' + reference;
  const cached = imageCache.get(key);
  if (cached) {
    imageCache.delete(key);
    imageCache.set(key, cached);
    return cached;
  }
  const src = await api.image(path, reference);
  const size = src.length * 2;
  if (size <= 32 * 1024 * 1024) {
    while (imageBytes + size > 32 * 1024 * 1024 && imageCache.size) {
      const key = imageCache.keys().next().value!;
      imageBytes -= imageCache.get(key)!.length * 2;
      imageCache.delete(key);
    }
    imageCache.set(key, src);
    imageBytes += size;
  }
  return src;
}
const imageObservers = new WeakMap<HTMLElement, IntersectionObserver>();
export function disposeEnhancements(container: HTMLElement) {
  imageObservers.get(container)?.disconnect();
  imageObservers.delete(container);
}
const diagramCache = new Map<string, string>();
let diagramBytes = 0;
function uniqueSvg(svg: string, prefix: string) {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  const ids = new Map<string, string>();
  for (const el of [root, ...root.querySelectorAll('[id]')])
    if (el.id) {
      const old = el.id;
      el.id = prefix + '-' + old;
      ids.set(old, el.id);
    }
  const replace = (value: string) =>
    value.replace(/#([\w-]+)/g, (all, id) => (ids.has(id) ? '#' + ids.get(id) : all));
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes])
      if (attr.name !== 'id') el.setAttribute(attr.name, replace(attr.value));
    if (el.tagName === 'style') el.textContent = replace(el.textContent || '');
  }
  return root.outerHTML;
}
export function clearRenderCaches() {
  clearImageCache();
  diagramCache.clear();
  diagramBytes = 0;
}
let mermaidQueue: Promise<void> = Promise.resolve();
let diagramId = 0;
export async function enhance(
  container: HTMLElement,
  path: string,
  dark: boolean,
  valid: () => boolean,
  eager = false,
) {
  const maths = [...container.querySelectorAll<HTMLElement>('[data-math]:not([data-enhanced])')];
  if (maths.length) {
    const [{ default: katex }] = await Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ]);
    for (const el of maths) {
      if (!valid()) return;
      try {
        el.dataset.enhanced = 'true';
        el.innerHTML = DOMPurify.sanitize(
          katex.renderToString(el.textContent || '', {
            displayMode: el.dataset.math === 'block',
            throwOnError: true,
            trust: false,
            strict: 'ignore',
            maxExpand: 1000,
            maxSize: 20,
          }),
        );
      } catch {
        el.classList.add('render-error');
        el.title = '公式语法错误';
      }
    }
  }
  disposeEnhancements(container);
  const images = [...container.querySelectorAll<HTMLElement>('[data-image]:not([data-enhanced])')];
  async function loadImage(el: HTMLElement) {
    if (!valid() || !desktop || !path || el.dataset.enhanced) return;
    try {
      const src = await imageSource(path, decodeURIComponent(el.dataset.image!.split('#')[0]));
      if (!valid()) {
        delete el.dataset.enhanced;
        return;
      }
      const image = new Image();
      image.alt = el.dataset.alt || '';
      image.src = src;
      el.replaceChildren(image);
      el.dataset.enhanced = 'true';
    } catch (e) {
      delete el.dataset.enhanced;
      el.classList.add('image-placeholder');
      el.title = String(e);
    }
  }
  if (eager) {
    for (const el of images) await loadImage(el);
  } else if (images.length) {
    let chain = Promise.resolve();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            observer.unobserve(entry.target);
            chain = chain.then(() => loadImage(entry.target as HTMLElement));
          }
      },
      { root: container.closest('.preview-scroll'), rootMargin: '600px' },
    );
    imageObservers.set(container, observer);
    images.forEach((el) => observer.observe(el));
  }
  const diagrams = [...container.querySelectorAll<HTMLElement>('.diagram-source')].filter(
    (el) => el.dataset.theme !== String(dark),
  );
  if (diagrams.length) {
    const work = async () => {
      if (!valid()) return;
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: dark ? 'dark' : 'neutral',
        fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
        // The root setting overrides diagram-specific htmlLabels in Mermaid 11.
        // Native SVG text survives the strict foreignObject sanitization below.
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        suppressErrorRendering: true,
        maxTextSize: 50000,
        secure: [
          'secure',
          'securityLevel',
          'startOnLoad',
          'maxTextSize',
          'suppressErrorRendering',
          'maxEdges',
          'htmlLabels',
        ],
      });
      for (const el of diagrams) {
        if (!valid()) return;
        const code = el.dataset.source || el.textContent || '';
        el.dataset.source = code;
        try {
          const cacheKey = String(dark) + '\0' + code;
          let svg = diagramCache.get(cacheKey);
          if (!svg) {
            svg = (await mermaid.render(`diagram-${++diagramId}`, code)).svg;
            svg = DOMPurify.sanitize(svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
              FORBID_TAGS: ['foreignObject', 'script'],
              FORBID_ATTR: ['href', 'xlink:href'],
            });
            if (svg.length * 2 < 8 * 1024 * 1024) {
              while (diagramBytes + svg.length * 2 > 8 * 1024 * 1024 && diagramCache.size) {
                const key = diagramCache.keys().next().value!;
                diagramBytes -= diagramCache.get(key)!.length * 2;
                diagramCache.delete(key);
              }
              diagramCache.set(cacheKey, svg);
              diagramBytes += svg.length * 2;
            }
          }
          if (!valid()) return;
          el.innerHTML = DOMPurify.sanitize(uniqueSvg(svg, `reuse-${++diagramId}`), {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ['foreignObject', 'script'],
            FORBID_ATTR: ['href', 'xlink:href'],
          });
          el.dataset.theme = String(dark);
          el.classList.add('diagram-ready');
        } catch {
          el.classList.add('render-error');
          el.textContent = `图表语法错误\n${code}`;
        }
      }
    };
    mermaidQueue = mermaidQueue.then(work, work);
    await mermaidQueue;
  }
}
