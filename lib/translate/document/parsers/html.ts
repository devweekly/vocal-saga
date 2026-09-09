import type { DocumentSegment, ParsedDocument, SegmentKind } from '../types';
import { DEFAULT_MAX_SEGMENT_CHARS, splitLongText } from './text';

/**
 * HTML 解析：手写容错分词器，不依赖 DOMParser。
 *
 * 为什么不用 DOMParser：
 *   1. 服务端（vocal-saga / Node）没有 DOMParser，同构复用会断。
 *   2. 文档翻译只需要「文本 + 块级结构」，不需要完整 DOM 树，
 *      用 DOM 解析反而要把节点再摊平一遍，还得防 XSS 注入风险。
 * 代价是不支持畸形嵌套的自动纠错 —— 但浏览器对 HTML 本身就很宽容，
 * 这里按"遇到闭合标签就结束当前块"处理，实际文档足够健壮。
 */

/** 完全忽略其内容（连文本都不取）的标签。 */
// 注意：这里**不能**放 head —— <title> 在 head 里，跳过 head 就拿不到文档标题。
// head 里其余标签（meta / link / base）要么是空元素不产生文本，要么是 script/style，
// 已单独覆盖，所以不需要整段跳过。
const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
  'embed',
  'canvas',
]);

const HEADING_LEVEL: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/** 会结束当前块的块级标签。 */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'aside',
  'header',
  'footer',
  'li',
  'blockquote',
  'pre',
  'tr',
  'td',
  'th',
  'dd',
  'dt',
  'figcaption',
  'caption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

/** 自闭合 / 空元素，不进栈。 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** 从标签名推断块语义。 */
function kindForTag(tag: string): { kind: SegmentKind; level?: number } {
  const level = HEADING_LEVEL[tag];
  if (level) return { kind: 'heading', level };
  if (tag === 'li' || tag === 'dd' || tag === 'dt') return { kind: 'list-item' };
  if (tag === 'blockquote') return { kind: 'quote' };
  if (tag === 'pre') return { kind: 'code' };
  if (tag === 'figcaption' || tag === 'caption') return { kind: 'caption' };
  return { kind: 'paragraph' };
}

export interface ParseHtmlOptions {
  maxSegmentChars?: number;
  fileName?: string;
}

export function parseHtmlDocument(
  input: string,
  options: ParseHtmlOptions = {},
): ParsedDocument {
  // 去掉 XML 声明 / DOCTYPE / BOM：XHTML 与 EPUB 的 .xhtml 常以
  // `<?xml version="1.0"?>` 开头，若不当文本处理会被当成第一段原文漏进译文。
  const cleaned = input
    .replace(/^﻿/, '')
    .replace(/^\s*<\?xml\b[^>]*\?>/i, '')
    .replace(/^\s*<!DOCTYPE\b[^>]*>/i, '');

  const max = options.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS;
  const warnings: string[] = [];
  const segments: DocumentSegment[] = [];
  let index = 0;
  let title = '';

  let parts: string[] = [];
  let kind: SegmentKind = 'paragraph';
  let level: number | undefined;
  let skipDepth = 0;
  let inTitle = false;
  // 标签栈：用于判断"隐式块"（裸文本）该何时结束
  const tagStack: string[] = [];

  const flush = () => {
    const text = parts.join('').replace(/[ \t\u00a0]+/g, ' ').trim();
    parts = [];
    if (!text) {
      kind = 'paragraph';
      level = undefined;
      return;
    }
    for (const piece of splitLongText(text, max)) {
      segments.push({ id: `s${index}`, index, text: piece, kind, level });
      index++;
    }
    kind = 'paragraph';
    level = undefined;
  };

  // 注释 | 闭合标签 | 开标签
  const TOKEN_RE = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(cleaned)) !== null) {
    // 标签之间的文本
    if (match.index > lastIndex) {
      const raw = cleaned.slice(lastIndex, match.index);
      if (skipDepth === 0) {
        if (inTitle) title = decodeEntities(raw).trim();
        else parts.push(decodeEntities(raw));
      }
    }
    lastIndex = TOKEN_RE.lastIndex;

    if (match[0].startsWith('<!--')) continue;

    const closeTag = match[1]?.toLowerCase();
    if (closeTag) {
      if (SKIP_TAGS.has(closeTag)) {
        skipDepth = Math.max(0, skipDepth - 1);
      } else {
        if (closeTag === 'title') inTitle = false;
        if (BLOCK_TAGS.has(closeTag)) flush();
        // 弹出栈顶直到匹配，容错处理未闭合标签
        const at = tagStack.lastIndexOf(closeTag);
        if (at >= 0) tagStack.length = at;
      }
      continue;
    }

    const openTag = match[2]?.toLowerCase();
    if (!openTag) continue;
    const selfClosing = match[4] === '/';

    // title 优先于 skip 判定：即使整个片段被跳过的结构里出现 title 也能取到
    if (openTag === 'title') {
      inTitle = true;
      continue;
    }

    if (SKIP_TAGS.has(openTag)) {
      if (!selfClosing) skipDepth++;
      continue;
    }
    if (skipDepth > 0) continue;

    if (openTag === 'br') {
      parts.push('\n');
      continue;
    }
    if (VOID_TAGS.has(openTag) || selfClosing) continue;

    if (BLOCK_TAGS.has(openTag)) {
      flush();
      const info = kindForTag(openTag);
      kind = info.kind;
      level = info.level;
    }
    tagStack.push(openTag);
  }

  // 尾部剩余文本
  if (lastIndex < cleaned.length && skipDepth === 0) {
    parts.push(decodeEntities(cleaned.slice(lastIndex)));
  }
  flush();

  if (!segments.length) warnings.push('未从 HTML 中提取到可翻译文本');

  return {
    format: 'html',
    title: title || (options.fileName ?? '').replace(/\.[^.]+$/, '') || '文档',
    segments,
    meta: {
      charCount: segments.reduce((n, s) => n + s.text.length, 0),
      segmentCount: segments.length,
      warnings,
    },
  };
}
