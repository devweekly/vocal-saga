import type { DocumentSegment, ParsedDocument, SegmentKind } from '../types';

/**
 * 纯文本 / Markdown 解析。
 *
 * 只处理最常见的 Markdown 语法（ATX 标题、围栏代码块、引用、列表），
 * 不做完整 CommonMark 解析 —— 文档翻译只需"结构足够还原层级"，
 * 完整解析器带来的体积与复杂度不值得。
 */

/** 单段上限：超过则软断句，避免超长段导致模型输出截断。 */
export const DEFAULT_MAX_SEGMENT_CHARS = 1200;

const BREAK_CHARS = new Set(['\n', '。', '！', '？', '．', '.', '!', '?', '；', ';']);

/**
 * 把过长文本按句末标点软切成多段。
 * 优先在标点处断，断不开再硬切，尽量不破坏句子完整性。
 */
export function splitLongText(
  text: string,
  max: number = DEFAULT_MAX_SEGMENT_CHARS,
): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    buf += ch;
    const isBreak = BREAK_CHARS.has(ch);
    // 到上限后在标点处断；一直没标点则到 1.3 倍硬切，防止无限累积
    if (buf.length >= max && (isBreak || buf.length >= max * 1.3)) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

interface MdLine {
  kind: SegmentKind;
  level?: number;
  text: string;
}

/** 识别单行 Markdown 的语义类型。 */
export function classifyMarkdownLine(line: string): MdLine {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    return {
      kind: 'heading',
      level: (heading[1] as string).length,
      text: (heading[2] as string).trim(),
    };
  }
  if (/^>\s?/.test(line)) {
    return { kind: 'quote', text: line.replace(/^>\s?/, '').trim() };
  }
  const list = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (list) {
    return { kind: 'list-item', text: (list[1] as string).trim() };
  }
  return { kind: 'paragraph', text: line.trim() };
}

interface ParseTextOptions {
  /** 单段最大字符数，超过会软切。 */
  maxSegmentChars?: number;
  /** 文件名，用于兜底标题。 */
  fileName?: string;
}

/**
 * 解析纯文本或 Markdown。
 * - md：识别标题 / 引用 / 列表 / 围栏代码块，其余按空行聚成段落
 * - txt：按空行聚成段落
 */
export function parseTextDocument(
  input: string,
  format: 'txt' | 'md',
  options: ParseTextOptions = {},
): ParsedDocument {
  const max = options.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS;
  const warnings: string[] = [];
  const segments: DocumentSegment[] = [];
  let index = 0;
  let title = '';

  const push = (text: string, kind: SegmentKind, level?: number) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    for (const part of splitLongText(trimmed, max)) {
      segments.push({ id: `s${index}`, index, text: part, kind, level });
      index++;
    }
  };

  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let inFence = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    push(paragraph.join('\n'), 'paragraph');
    paragraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    // 围栏代码块：整块作为一个 code 段，不做 Markdown 行级解析
    if (format === 'md' && /^\s*(```|~~~)/.test(line)) {
      if (inFence) {
        push(paragraph.join('\n'), 'code');
        paragraph = [];
        inFence = false;
      } else {
        flushParagraph();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      paragraph.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    if (format === 'md') {
      const info = classifyMarkdownLine(line);
      if (info.kind === 'heading' && !title) title = info.text;
      // 标题 / 列表 / 引用各自成段，正文按空行聚合
      if (info.kind === 'paragraph') {
        paragraph.push(info.text);
      } else {
        flushParagraph();
        push(info.text, info.kind, info.level);
      }
    } else {
      paragraph.push(line.trim());
    }
  }

  if (inFence && paragraph.length) push(paragraph.join('\n'), 'code');
  else flushParagraph();

  if (!segments.length) {
    warnings.push('文件为空或未提取到可翻译文本');
  }

  return {
    format,
    title: title || (options.fileName ?? '').replace(/\.[^.]+$/, '') || '文档',
    segments,
    meta: {
      charCount: segments.reduce((n, s) => n + s.text.length, 0),
      segmentCount: segments.length,
      warnings,
    },
  };
}
