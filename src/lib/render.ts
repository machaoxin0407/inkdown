import DOMPurify from 'dompurify';
import { api, desktop } from './api';
import type { Heading } from './types';
export type Parsed = { html: string; markup: string[]; headings: Heading[]; blocks?: { line: number; end: number }[] };
export function sanitizeMarkup(html: string) {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-math', 'data-image', 'data-alt', 'data-task-offset'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'form'],
  });
}
type Job = { id: number; owner: string; source: string; resolve: (p: Parsed) => void; reject: (e: Error) => void };
class ParserLane {
  private worker?: Worker;
  private active?: Job;
  private queued = new Map<string, Job>();
  private seq = 0;
  cancel(owner: string) {
    const error = new DOMException('已取消', 'AbortError');
    this.queued.get(owner)?.reject(error); this.queued.delete(owner);
    if (this.active?.owner === owner) {
      this.active.reject(error); this.active = undefined;
      this.worker?.terminate(); this.worker = undefined;
      this.pump();
    }
  }
  parse(source: string, owner: string): Promise<Parsed> {
    this.cancel(owner);
    return new Promise((resolve, reject) => {
      this.queued.set(owner, { id: ++this.seq, owner, source, resolve, reject }); this.pump();
    });
  }
  private pump() {
    if (this.active || !this.queued.size) return;
    if (!this.worker) {
      const worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (worker !== this.worker) return;
        const job = this.active; this.active = undefined;
        if (job && job.id === data.id) {
          if (data.error) job.reject(new Error(data.error)); else job.resolve(data);
        }
        this.pump();
      };
      worker.onerror = () => {
        if (worker !== this.worker) return;
        const error = new Error('渲染进程出错，请重试');
        this.active?.reject(error); this.active = undefined;
        this.queued.forEach((j) => j.reject(error)); this.queued.clear();
        worker.terminate(); this.worker = undefined;
      };
    }
    this.active = this.queued.values().next().value!;
    this.queued.delete(this.active.owner);
    this.worker.postMessage({ id: this.active.id, source: this.active.source });
  }
}
const previewParser = new ParserLane(), exportParser = new ParserLane();
let exportId = 0;
export const cancelParse = (owner: string) => previewParser.cancel(owner);
export function parse(source: string, owner?: string): Promise<Parsed> {
  return owner ? previewParser.parse(source, owner) : exportParser.parse(source, 'export-' + ++exportId);
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
async function enhanceContent(
  container: HTMLElement,
  path: string,
  dark: boolean,
  valid: () => boolean,
  eager = false,
) {
  const maths = select(container, '[data-math]:not([data-enhanced])');
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
  const images = select(container, '[data-image]:not([data-enhanced])');
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
  const diagrams = select(container, '.diagram-source').filter(
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

function select(container: HTMLElement, selector: string): HTMLElement[] {
  return [...(container.matches(selector) ? [container] : []), ...container.querySelectorAll<HTMLElement>(selector)];
}
export interface ResourceIssue { kind: 'image' | 'math' | 'diagram'; line: number; reference: string; message: string }
export function resourceIssues(container: HTMLElement): ResourceIssue[] {
  return [...container.querySelectorAll<HTMLElement>('.render-error,.image-placeholder')].map((el) => ({
    kind: el.matches('[data-image],.image-placeholder') ? 'image' : el.matches('[data-math]') ? 'math' : 'diagram',
    line: Number(el.closest('[data-source-line]')?.getAttribute('data-source-line') || 0) + 1,
    reference: el.dataset.image || el.dataset.source || el.textContent || '',
    message: el.title || (el.matches('.image-placeholder') ? el.textContent || '图片未加载' : '图表语法错误'),
  }));
}
export async function enhance(container: HTMLElement, path: string, dark: boolean, valid: () => boolean, eager = false): Promise<ResourceIssue[]> {
  disposeEnhancements(container);
  if (eager) {
    await enhanceContent(container, path, dark, valid, true);
    return resourceIssues(container);
  }
  const pending = select(container, '[data-math]:not([data-enhanced]),[data-image]:not([data-enhanced]),.diagram-source').filter((el) => !el.matches('.diagram-source') || el.dataset.theme !== String(dark));
  let chain = Promise.resolve();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target);
      chain = chain.then(async () => { if (valid()) await enhanceContent(entry.target as HTMLElement, path, dark, valid, true); });
    }
  }, { root: container.closest('.preview-scroll'), rootMargin: '600px' });
  imageObservers.set(container, observer);
  pending.forEach((el) => observer.observe(el));
  return [];
}
