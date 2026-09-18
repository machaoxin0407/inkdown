export const MIN_ZOOM = 50;
export const MAX_ZOOM = 200;
export function normalizeZoom(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && value !== null && value !== ''
    ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(number / 10) * 10))
    : 100;
}
