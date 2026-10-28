import MarkdownIt from 'markdown-it';
import { pathKey } from './types';
const md = new MarkdownIt({ html: false });
export interface ReferenceEdit { from: number; to: number; insert: string }
const labelKey = (s: string) => md.utils.unescapeAll(s).trim().replace(/\s+/g, ' ').toUpperCase();
function normalized(path: string) {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop(); else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
}
function resolve(document: string, href: string) {
  if (/^(?:[a-z][a-z\d+.-]*:|[\\/]|#)/i.test(href)) return '';
  try { return normalized(document.replace(/[^\\/]+$/, '') + decodeURIComponent(href.split(/[?#]/)[0])); }
  catch { return ''; }
}
/** Source-span edits: formatting outside the destination is never rewritten. */
export function referenceEdits(source: string, document: string, oldPath: string, name: string, workspace: string, warning: (message: string) => void = () => {}): ReferenceEdit[] {
  const env: { references?: Record<string, { href: string }> } = {};
  const tokens = md.parse(source, env);
  const lineStarts = [0];
  for(let n=source.indexOf('\n'); n>=0; n=source.indexOf('\n',n+1)) lineStarts.push(n+1);
  const code: [number,number][] = tokens.filter((t) => ['fence','code_block'].includes(t.type) && t.map).map((t) => [lineStarts[t.map![0]], lineStarts[t.map![1]] ?? source.length]);
  const excluded = (at: number) => code.some(([a,b]) => at>=a && at<b);
  const edits: ReferenceEdit[] = [];
  const imageLabels = new Set<string>(), linkLabels = new Set<string>();
  const definitions: { key: string; from: number; to: number; href: string }[] = [];
  const destination = (at: number) => {
    const result = md.helpers.parseLinkDestination(source, at, source.length);
    if (!result.ok) return undefined;
    return { from: source[at] === '<' ? at+1 : at, to: source[at] === '<' ? result.pos-1 : result.pos, href: md.normalizeLink(result.str), end: result.pos, angle: source[at] === '<' };
  };
  const add = (span: { from: number; to: number; href: string }, angle = false) => {
    const target = resolve(document, span.href);
    if (pathKey(target) !== pathKey(normalized(oldPath)) || !pathKey(target).startsWith(pathKey(normalized(workspace)) + '/')) return;
    const raw = source.slice(span.from,span.to), suffixAt = raw.search(/[?#]/), suffix = suffixAt < 0 ? '' : raw.slice(suffixAt), path = suffixAt < 0 ? raw : raw.slice(0,suffixAt);
    const slash = path.lastIndexOf('/');
    const encoded = /%[\da-f]{2}/i.test(path) || (!angle && /[\s()<>\\]/.test(name));
    edits.push({ from: span.from, to: span.to, insert: path.slice(0,slash+1) + (encoded ? encodeURIComponent(name) : name.replace(/([\\<>])/g,'\\$1')) + suffix });
  };
  // Definitions are only updated when a link uses them, never image-only or shared image definitions.
  const definitionRanges: number[][] = [];
  const definition = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:\n[ \t]*)?/gm;
  for (const match of source.matchAll(definition)) {
    if (excluded(match.index!)) continue;
    definitionRanges.push([match.index!, source.indexOf('\n', match.index!+match[0].length) < 0 ? source.length : source.indexOf('\n', match.index!+match[0].length)]);
    const key = labelKey(match[1]), span = destination(match.index!+match[0].length);
    if (span && env.references?.[key]?.href === span.href && !definitions.some((d) => d.key === key)) definitions.push({ key, ...span });
  }

  for (let i=0; i<source.length; i++) {
    if (excluded(i) || definitionRanges.some(([a,b]) => i>=a && i<=b)) continue;
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '`') {
      let end=i; while(source[end] === '`') end++;
      const length = end-i;
      let close=end, found=false;
      while((close=source.indexOf('`',close))>=0) {
        let run=close; while(source[run]==='`') run++;
        if(run-close===length) { i=run-1; found=true; break; }
        close=run;
      }
      if(!found) i=end-1;
      continue;
    }
    if (source[i] !== '[') continue;
    const image = i>0 && source[i-1] === '!';
    let end=i+1, depth=1;
    for(;end<source.length;end++) {
      if(source[end] === '\\') { end++; continue; }
      if(source[end] === '[') depth++;
      if(source[end] === ']' && --depth === 0) break;
      // Only brackets affect depth.
      if(source[end] !== ']') { /* scanned above */ }
    }
    if(end>=source.length) continue;
    const label = source.slice(i+1,end);
    if(source[end+1] === '(') {
      let at=end+2; while(/\s/.test(source[at] || '') && at<source.length) at++;
      const span = destination(at);
      if(!span) continue;
      let close=span.end, quote='';
      for(;close<source.length;close++) {
        const c=source[close];
        if(c==='\\') { close++; continue; }
        if(quote) { if(c===quote) quote=''; continue; }
        if(c==='"' || c==="'") { quote=c; continue; }
        if(c===')') break;
        if(c==='\n' && source[close+1]==='\n') break;
      }
      const inline: import('markdown-it/lib/token.mjs').default[] = [];
      md.inline.parse(source.slice(i,close+1),md,env,inline);
      if(!image && inline.some((t) => t.type==='link_open' && t.attrGet('href')===span.href)) add(span,span.angle);
      if(image) i=close;
      continue;
    }
    let reference=label;
    if(source[end+1]==='[') {
      const close=source.indexOf(']',end+2);
      if(close>=0) reference=source.slice(end+2,close) || label;
    }
    const key=labelKey(reference);
    if(env.references?.[key]) (image ? imageLabels : linkLabels).add(key);
  }
  for(const d of definitions) if(linkLabels.has(d.key)) {
    if(imageLabels.has(d.key)) { if(pathKey(resolve(document,d.href)) === pathKey(normalized(oldPath))) warning(`引用定义 ${d.key} 同时用于图片，已跳过，请手动检查链接`); }
    else add(d,source[d.from-1]==='<');
  }
  return edits.sort((a,b) => a.from-b.from).filter((edit,i,all) => (!i || edit.from>=all[i-1].to) && source.slice(edit.from,edit.to)!==edit.insert);
}
export function applyReferenceEdits(source: string, edits: ReferenceEdit[]) {
  for(const edit of [...edits].sort((a,b) => b.from-a.from)) source=source.slice(0,edit.from)+edit.insert+source.slice(edit.to);
  return source;
}
