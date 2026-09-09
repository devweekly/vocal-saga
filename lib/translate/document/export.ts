import type { DocumentSegment, ParsedDocument } from './types';

/**
 * 双语导出。
 *
 * 导出是文档翻译的"最后一公里"：用户要的是能带走的成果，
 * 不是只能在插件里看一遍。因此按原格式还原结构，而不是平铺纯文本。
 */

export type ExportFormat = 'html' | 'txt' | 'md' | 'srt' | 'vtt' | 'json';

/** bilingual = 原文+译文对照；translation = 只要译文。 */
export type ExportMode = 'bilingual' | 'translation';

export type Translations = Record<string, string> | Map<string, string>;

export interface ExportOptions {
  mode?: ExportMode;
  /** json 格式导出成"译文回填后的完整 JSON"时，需要原始 JSON 文本。 */
  jsonRoot?: string;
}

function pick(translations: Translations, id: string): string {
  return (translations instanceof Map ? translations.get(id) : translations[id]) ?? '';
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 解析 collectJsonLeaves 生成的 path，例如 `$['a'].b[0]`。 */
const PATH_TOKEN_RE = /\.([A-Za-z_$][\w$]*)|\['((?:[^'\\]|\\.)*)'\]|\[(\d+)\]/g;

/** 按 path 写回值（原地修改 root）。 */
export function setByPath(root: unknown, path: string, value: string): boolean {
  const tokens: Array<string | number> = [];
  PATH_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_TOKEN_RE.exec(path)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(m[2].replace(/\\'/g, "'"));
    else if (m[3] !== undefined) tokens.push(Number(m[3]));
  }

  let cursor: unknown = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (cursor == null || typeof cursor !== 'object') return false;
    const key = tokens[i] as string | number;
    cursor = Array.isArray(cursor)
      ? (cursor as unknown[])[Number(key)]
      : (cursor as Record<string, unknown>)[String(key)];
  }
  if (cursor == null || typeof cursor !== 'object') return false;
  const last = tokens[tokens.length - 1];
  if (Array.isArray(cursor)) (cursor as unknown[])[Number(last)] = value;
  else (cursor as Record<string, unknown>)[String(last)] = value;
  return true;
}

function renderSegmentText(segment: DocumentSegment, translated: string, mode: ExportMode): string {
  if (mode === 'translation') return translated || segment.text;
  if (!translated) return segment.text;
  return `${segment.text}\n${translated}`;
}

/** HTML：按语义还原标签，双语用 <span class="fanyi-doc-tr"> 区分。 */
function toHtml(doc: ParsedDocument, translations: Translations, mode: ExportMode): string {
  const body = doc.segments
    .map((segment) => {
      const tr = pick(translations, segment.id);
      const original = escapeHtml(segment.text).replace(/\n/g, '<br>');
      const translated = escapeHtml(tr).replace(/\n/g, '<br>');
      const pair =
        mode === 'translation'
          ? `<div class="fanyi-tr">${translated || original}</div>`
          : `<div class="fanyi-or">${original}</div>${
              tr ? `<div class="fanyi-tr">${translated}</div>` : ''
            }`;

      if (segment.kind === 'heading') {
        const level = Math.min(Math.max(segment.level ?? 2, 1), 6);
        return `<h${level}>${pair}</h${level}>`;
      }
      if (segment.kind === 'list-item') return `<li>${pair}</li>`;
      if (segment.kind === 'quote') return `<blockquote>${pair}</blockquote>`;
      if (segment.kind === 'code') return `<pre><code>${original}</code></pre>`;
      return `<p>${pair}</p>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(doc.title)}</title>
<style>
  body { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.75;
         font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .fanyi-or { color: #1f2328; }
  .fanyi-tr { color: #0a5fb4; margin-top: .25em; }
  blockquote { border-left: 3px solid #d0d7de; margin-left: 0; padding-left: 1em; color: #57606a; }
  pre { background: #f6f8fa; padding: .75em; overflow-x: auto; }
</style>
</head>
<body>
<h1>${escapeHtml(doc.title)}</h1>
${body}
</body>
</html>`;
}

/** 纯文本 / Markdown：正文按段分隔，标题按 md 语法还原。 */
function toPlainText(
  doc: ParsedDocument,
  translations: Translations,
  mode: ExportMode,
  markdown: boolean,
): string {
  const lines: string[] = [];
  if (markdown) lines.push(`# ${doc.title}`, '');

  for (const segment of doc.segments) {
    const tr = pick(translations, segment.id);
    const text = renderSegmentText(segment, tr, mode);

    if (segment.kind === 'heading' && markdown) {
      lines.push(`${'#'.repeat(Math.min(Math.max(segment.level ?? 2, 1), 6))} ${text}`, '');
    } else if (segment.kind === 'list-item' && markdown) {
      lines.push(`- ${text.replace(/\n/g, ' ')}`);
    } else if (segment.kind === 'code') {
      lines.push(markdown ? '```' : '', segment.text, markdown ? '```' : '', '');
    } else {
      lines.push(text, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** 双语字幕：原文一行 + 译文一行，时间码不变。 */
function toSubtitle(
  doc: ParsedDocument,
  translations: Translations,
  mode: ExportMode,
  vtt: boolean,
): string {
  const sep = vtt ? '.' : ',';
  const head = vtt ? 'WEBVTT\n\n' : '';
  const body = doc.segments
    .map((segment, i) => {
      const start = (segment.start ?? '00:00:00.000').replace(/\./g, sep);
      const end = (segment.end ?? '00:00:00.000').replace(/\./g, sep);
      const tr = pick(translations, segment.id);
      const text =
        mode === 'translation'
          ? tr || segment.text
          : tr
            ? `${segment.text}\n${tr}`
            : segment.text;
      return `${i + 1}\n${start} --> ${end}\n${text}`;
    })
    .join('\n\n');
  return head + body + '\n';
}

function toJson(
  doc: ParsedDocument,
  translations: Translations,
  mode: ExportMode,
  jsonRoot?: string,
): string {
  // 有原始 JSON 时回填，产出与输入同构的文件，可直接替换使用
  if (jsonRoot) {
    try {
      const root = JSON.parse(jsonRoot);
      for (const segment of doc.segments) {
        const tr = pick(translations, segment.id);
        if (tr && segment.path) setByPath(root, segment.path, tr);
      }
      return JSON.stringify(root, null, 2);
    } catch {
      // 解析失败退化为对照表，不阻断导出
    }
  }

  const out: Record<string, { original: string; translation: string } | string> = {};
  for (const segment of doc.segments) {
    const key = segment.path ?? segment.id;
    const tr = pick(translations, segment.id);
    out[key] = mode === 'translation' ? tr || segment.text : { original: segment.text, translation: tr };
  }
  return JSON.stringify(out, null, 2);
}

export function exportDocument(
  doc: ParsedDocument,
  translations: Translations,
  format: ExportFormat,
  options: ExportOptions = {},
): string {
  const mode = options.mode ?? 'bilingual';
  switch (format) {
    case 'html':
      return toHtml(doc, translations, mode);
    case 'md':
      return toPlainText(doc, translations, mode, true);
    case 'srt':
      return toSubtitle(doc, translations, mode, false);
    case 'vtt':
      return toSubtitle(doc, translations, mode, true);
    case 'json':
      return toJson(doc, translations, mode, options.jsonRoot);
    case 'txt':
    default:
      return toPlainText(doc, translations, mode, false);
  }
}

/** 导出文件名：原名 + 语种后缀，保留源扩展名（json 需要）。 */
export function buildExportFileName(
  doc: ParsedDocument,
  format: ExportFormat,
  targetLang = 'zh',
): string {
  const base = (doc.title || 'document').replace(/[\\/:*?"<>|]/g, '_');
  return `${base}.${targetLang}.${format}`;
}
