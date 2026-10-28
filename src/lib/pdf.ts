import { parse, enhance, disposeEnhancements, resourceIssues, type ResourceIssue } from './render';
import { reconcileMarkup } from './markup';
import { pdfDefaults, pdfPreferences, paperSize, type PdfPreferences } from './preferences';
import { api } from './api';

export interface PreparedPdf {
  root: HTMLElement;
  issues: ResourceIssue[];
  configure(options: PdfPreferences): void;
  mount(host: HTMLElement): void;
  export(output: string, options: PdfPreferences): Promise<void>;
  dispose(): void;
}
/** Immutable, fully enhanced snapshot shared by preflight, preview and printing. */
export async function preparePdf(content: string, documentPath: string, initial = pdfDefaults): Promise<PreparedPdf> {
  const style = document.createElement('style');
  document.head.append(style);
  const root = document.createElement('article');
  root.className = 'prose pdf-export-root';
  root.setAttribute('aria-hidden', 'true');
  document.body.append(root);
  let disposed = false;
  const configure = (options: PdfPreferences) => {
    options = pdfPreferences(options);
    const [width, height] = paperSize(options);
    root.style.width = `${width - options.left - options.right}mm`;
    root.style.fontSize = '11pt'; root.style.lineHeight = '1.7';
    style.textContent = `@media print { @page { size:${width}mm ${height}mm; margin:${options.top}mm ${options.right}mm ${options.bottom}mm ${options.left}mm; } .pdf-export-root img,.pdf-export-root .diagram-ready svg {max-height:${height-options.top-options.bottom}mm;} }`;
  };
  const dispose = () => { disposed = true; disposeEnhancements(root); root.remove(); style.remove(); };
  try {
    configure(initial);
    const parsed = await parse(content);
    await reconcileMarkup(root, parsed.markup, () => !disposed);
    await enhance(root, documentPath, false, () => !disposed, true);
    await document.fonts.ready;
    await Promise.all([...root.querySelectorAll('img')].map(async (img) => {
      img.loading = 'eager';
      try { await img.decode(); }
      catch { const parent = img.closest<HTMLElement>('[data-image]'); if (parent) { parent.classList.add('image-placeholder'); parent.title = '图片无法解码'; } }
    }));
    root.querySelectorAll('input').forEach((input) => input.disabled = true);
    root.querySelectorAll('a').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (!/^(https?:|mailto:|#)/i.test(href)) link.removeAttribute('href');
    });
    return {
      root, issues: resourceIssues(root), configure,
      mount(host) { root.classList.add('pdf-preview-document'); root.removeAttribute('aria-hidden'); host.append(root); },
      async export(output, options) {
        if (disposed) throw new Error('导出预览已关闭');
        configure(options);
        root.classList.remove('pdf-preview-document'); root.setAttribute('aria-hidden', 'true'); document.body.append(root);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        await api.exportPdf(output, pdfPreferences(options));
      },
      dispose,
    };
  } catch (e) { dispose(); throw e; }
}
export async function exportPdf(content: string, documentPath: string, output: string, options = pdfDefaults) {
  const prepared = await preparePdf(content, documentPath, options);
  try { await prepared.export(output, options); } finally { prepared.dispose(); }
}
