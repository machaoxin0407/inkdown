import DOMPurify from 'dompurify';
import { api, desktop } from './api';
import type { Heading } from './types';
let worker: Worker | undefined;
let seq = 0;
const pending = new Map<
  number,
  { resolve: (v: { html: string; headings: Heading[] }) => void; reject: (e: Error) => void }
>();
export function parse(source: string): Promise<{ html: string; headings: Heading[] }> {
  if (!worker) {
    worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else
        job.resolve({
          html: DOMPurify.sanitize(data.html, {
            ADD_ATTR: ['data-math', 'data-image', 'data-alt'],
            FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'form'],
          }),
          headings: data.headings,
        });
    };
    worker.onerror = () => {
      for (const job of pending.values()) job.reject(new Error('渲染进程出错，请重新打开文档'));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, source });
  });
}
let mermaidQueue: Promise<void> = Promise.resolve();
let diagramId = 0;
export async function enhance(
  container: HTMLElement,
  path: string,
  dark: boolean,
  valid: () => boolean,
) {
  const maths = [...container.querySelectorAll<HTMLElement>('[data-math]')];
  if (maths.length) {
    const [{ default: katex }] = await Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ]);
    for (const el of maths) {
      if (!valid()) return;
      try {
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
  const images = [...container.querySelectorAll<HTMLElement>('[data-image]')];
  // Sequential reads keep memory bounded for documents with many images.
  if (images.length && path) {
    for (const el of images) {
      if (!valid()) return;
      try {
        if (!desktop) continue;
        const src = await api.image(path, decodeURIComponent(el.dataset.image!.split('#')[0]));
        if (!valid()) return;
        const image = new Image();
        image.alt = el.dataset.alt || '';
        image.loading = 'lazy';
        image.src = src;
        el.replaceChildren(image);
      } catch (e) {
        el.classList.add('image-placeholder');
        el.title = String(e);
      }
    }
  }
  const diagrams = [...container.querySelectorAll<HTMLElement>('.diagram-source')];
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
        const code = el.textContent || '';
        try {
          const { svg } = await mermaid.render(`diagram-${++diagramId}`, code);
          if (!valid()) return;
          el.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ['foreignObject', 'script'],
            FORBID_ATTR: ['href', 'xlink:href'],
          });
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
