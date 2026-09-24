import { parse, enhance } from './render';
import { pdfDefaults, pdfPreferences, paperSize, type PdfPreferences } from './preferences';
import { api } from './api';

/** Render an immutable, light-theme snapshot without changing the current tab. */
export async function exportPdf(
  content: string,
  documentPath: string,
  output: string,
  options: PdfPreferences = pdfDefaults,
) {
  options = pdfPreferences(options);
  const [width, height] = paperSize(options);
  const style = document.createElement('style');
  style.textContent = `@media print { @page { size: ${width}mm ${height}mm; margin: ${options.top}mm ${options.right}mm ${options.bottom}mm ${options.left}mm; } .pdf-export-root img,.pdf-export-root .diagram-ready svg {max-height:${height - options.top - options.bottom}mm;} }`;
  document.head.append(style);
  const root = document.createElement('article');
  root.className = 'prose pdf-export-root';
  root.style.width = `${width - options.left - options.right}mm`;
  root.setAttribute('aria-hidden', 'true');
  document.body.append(root);
  try {
    const parsed = await parse(content);
    root.innerHTML = parsed.html;
    await enhance(root, documentPath, false, () => root.isConnected, true);
    await document.fonts.ready;
    await Promise.all(
      [...root.querySelectorAll('img')].map((img) => {
        img.loading = 'eager';
        return img.decode().catch(() => {});
      }),
    );
    root.querySelectorAll('a').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (!/^(https?:|mailto:|#)/i.test(href)) link.removeAttribute('href');
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await api.exportPdf(output, options);
  } finally {
    root.remove();
    style.remove();
  }
}
