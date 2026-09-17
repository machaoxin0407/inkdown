import { parseMarkdown } from './parse';
self.onmessage = (event: MessageEvent<{ id: number; source: string }>) => {
  try {
    self.postMessage({ id: event.data.id, ...parseMarkdown(event.data.source) });
  } catch (e) {
    self.postMessage({ id: event.data.id, error: String(e) });
  }
};
