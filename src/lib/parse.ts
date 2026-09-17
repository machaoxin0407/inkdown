import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import sql from 'highlight.js/lib/languages/sql';
import type { Heading } from './types';
for (const [name, definition] of Object.entries({
  javascript,
  typescript,
  python,
  rust,
  json,
  css,
  xml,
  bash,
  cpp,
  sql,
}))
  hljs.registerLanguage(name, definition);
export const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(code, language) {
    return hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : '';
  },
});
const escape = md.utils.escapeHtml;
const sourceAttr = (token: { map: [number, number] | null; level: number }) =>
  token.map && token.level === 0 ? ` data-source-line="${token.map[0]}"` : '';
md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
  const start = state.pos;
  if (
    state.src[start] !== '$' ||
    state.src[start + 1] === '$' ||
    /\s/.test(state.src[start + 1] || ' ')
  )
    return false;
  let end = start + 1;
  while ((end = state.src.indexOf('$', end)) !== -1) {
    if (state.src[end - 1] !== '\\') break;
    end++;
  }
  if (end < 0 || /\s/.test(state.src[end - 1]) || /\d/.test(state.src[end + 1] || '')) return false;
  if (!silent) {
    const token = state.push('math_inline', '', 0);
    token.content = state.src.slice(start + 1, end);
  }
  state.pos = end + 1;
  return true;
});
md.block.ruler.before(
  'fence',
  'math_block',
  (state, start, end, silent) => {
    const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
    if (!first.startsWith('$$')) return false;
    let content = first.slice(2),
      next = start + 1;
    if (content.trimEnd().endsWith('$$')) content = content.trimEnd().slice(0, -2);
    else {
      let closed = false;
      for (; next < end; next++) {
        const line = state.src.slice(state.bMarks[next], state.eMarks[next]);
        if (line.trimEnd().endsWith('$$')) {
          content += '\n' + line.trimEnd().slice(0, -2);
          next++;
          closed = true;
          break;
        }
        content += '\n' + line;
      }
      if (!closed) return false;
    }
    if (silent) return true;
    const token = state.push('math_block', '', 0);
    token.content = content.trim();
    token.map = [start, next];
    state.line = next;
    return true;
  },
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
);
md.renderer.rules.math_inline = (tokens, i) =>
  `<span class="math-source" data-math="inline">${escape(tokens[i].content)}</span>`;
md.renderer.rules.math_block = (tokens, i) =>
  `<div class="math-source" data-math="block"${sourceAttr(tokens[i])}>${escape(tokens[i].content)}</div>`;
const originalFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, i, options, env, self) =>
  tokens[i].info.trim() === 'mermaid'
    ? `<div class="diagram-source"${sourceAttr(tokens[i])}>${escape(tokens[i].content)}</div>`
    : `<div class="code-block"${sourceAttr(tokens[i])}><div class="code-label">${escape(tokens[i].info.split(' ')[0] || 'TEXT')}</div>${originalFence(tokens, i, options, env, self)}</div>`;
md.renderer.rules.image = (tokens, i) => {
  const token = tokens[i],
    src = token.attrGet('src') || '',
    alt = token.content;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\\\\)/i.test(src))
    return `<span class="image-placeholder">网络或外部图片未加载 · ${escape(alt || src)}</span>`;
  return `<span class="local-image" data-image="${escape(src)}" data-alt="${escape(alt)}">图片 · ${escape(alt || src)}</span>`;
};
md.core.ruler.after('inline', 'tasks', (state) => {
  state.tokens.forEach((token, i) => {
    if (
      token.type !== 'inline' ||
      state.tokens[i - 1]?.type !== 'paragraph_open' ||
      state.tokens[i - 2]?.type !== 'list_item_open'
    )
      return;
    const first = token.children?.[0];
    if (first?.type !== 'text' || !/^\[[ xX]\] /.test(first.content)) return;
    const checked = first.content[1].toLowerCase() === 'x';
    first.content = first.content.slice(4);
    const input = new state.Token('html_inline', '', 0);
    input.content = `<input type="checkbox" disabled ${checked ? 'checked' : ''} aria-label="任务${checked ? '已完成' : '未完成'}"/>`;
    token.children!.unshift(input);
  });
});
export function parseMarkdown(source: string): { html: string; headings: Heading[] } {
  const env = {},
    tokens = md.parse(source, env),
    headings: Heading[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.map && token.level === 0 && token.type !== 'inline' && token.nesting !== -1)
      token.attrSet('data-source-line', String(token.map[0]));
    if (tokens[i].type === 'heading_open') {
      const id = `heading-${headings.length}`;
      tokens[i].attrSet('id', id);
      headings.push({
        id,
        level: Number(tokens[i].tag[1]),
        text:
          tokens[i + 1].children
            ?.map((t) => (t.type === 'text' || t.type === 'code_inline' ? t.content : ''))
            .join('') || tokens[i + 1].content,
      });
    }
  }
  return { html: md.renderer.render(tokens, md.options, env), headings };
}
