export interface ReadingPreferences {
  font: 'sans' | 'serif' | 'mono';
  size: number;
  lineHeight: number;
  width: number;
}
export interface PdfPreferences {
  paper: 'A4' | 'Letter';
  landscape: boolean;
  top: number;
  right: number;
  bottom: number;
  left: number;
  pageNumbers: boolean;
}
export const readingDefaults: ReadingPreferences = {
  font: 'sans',
  size: 16,
  lineHeight: 1.7,
  width: 880,
};
export const pdfDefaults: PdfPreferences = {
  paper: 'A4',
  landscape: false,
  top: 15,
  right: 15,
  bottom: 15,
  left: 15,
  pageNumbers: false,
};
const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
export function readingPreferences(v: Partial<ReadingPreferences> = {}): ReadingPreferences {
  return {
    font: ['sans', 'serif', 'mono'].includes(v.font || '') ? v.font! : 'sans',
    size: clamp(v.size, 14, 24, 16),
    lineHeight: clamp(v.lineHeight, 1.4, 2.2, 1.7),
    width: clamp(v.width, 640, 1200, 880),
  };
}
export function pdfPreferences(v: Partial<PdfPreferences> = {}): PdfPreferences {
  return {
    paper: v.paper === 'Letter' ? 'Letter' : 'A4',
    landscape: v.landscape === true,
    top: clamp(v.top, 5, 50, 15),
    right: clamp(v.right, 5, 50, 15),
    bottom: clamp(v.bottom, 5, 50, 15),
    left: clamp(v.left, 5, 50, 15),
    pageNumbers: v.pageNumbers === true,
  };
}
export const fonts = {
  sans: "'Segoe UI','Microsoft YaHei',sans-serif",
  serif: "Georgia,'SimSun',serif",
  mono: "Consolas,'Microsoft YaHei',monospace",
};
export function paperSize(options: PdfPreferences) {
  const size = options.paper === 'Letter' ? [215.9, 279.4] : [210, 297];
  return options.landscape ? size.reverse() : size;
}
