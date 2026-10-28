self.onmessage = ({ data }: MessageEvent<{ id: number; source: string }>) => {
  self.postMessage({ id: data.id, count: data.source.replace(/\s/g, '').length });
};
