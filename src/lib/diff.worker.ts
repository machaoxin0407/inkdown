import { lineDiff } from './diff';
self.onmessage = ({ data }: MessageEvent<{ left: string; right: string }>) => {
  try { self.postMessage({ diff: lineDiff(data.left, data.right) }); }
  catch (e) { self.postMessage({ error: String(e) }); }
};
