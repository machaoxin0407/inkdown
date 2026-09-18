import { parse, enhance } from './render';
import { api } from './api';

/** Render an immutable, light-theme snapshot without changing the current tab. */
export async function exportPdf(content: string, documentPath: string, output: string) {
  const root = document.createElement('article');
  root.className = 'prose pdf-export-root';
  root.setAttribute('aria-hidden', 'true');
  document.body.append(root);
  try {
    const parsed = await parse(content);
    root.innerHTML = parsed.html;
    await enhance(root, documentPath, false, () => root.isConnected);
    await document.fonts.ready;
    await Promise.all([...root.querySelectorAll('img')].map((img) => {
      img.loading = 'eager';
      return img.decode().catch(() => {});
    }));
    root.querySelectorAll('a').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (!/^(https?:|mailto:|#)/i.test(href)) link.removeAttribute('href');
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await api.exportPdf(output);
  } finally {
    root.remove();
  }
}
