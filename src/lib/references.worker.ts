import { referenceEdits } from './references';
self.onmessage = ({ data }) => {
  try { const warnings: string[] = []; const edits = referenceEdits(data.source, data.document, data.oldPath, data.name, data.workspace, (warning) => warnings.push(warning)); self.postMessage({ edits, warnings }); }
  catch(e) { self.postMessage({ error: String(e) }); }
};
