import type { DocumentFormat, DocumentInput } from './types';

/** 扩展名 → 格式。扩展名优先于 mime，避免 .srt/.vtt 被识别成 text/plain。 */
const EXT_MAP: Record<string, DocumentFormat> = {
  txt: 'txt',
  text: 'txt',
  md: 'md',
  markdown: 'md',
  mdx: 'md',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  srt: 'srt',
  vtt: 'vtt',
  json: 'json',
  pdf: 'pdf',
  docx: 'docx',
  epub: 'epub',
};

/** 探测文档格式；无法识别返回 null。 */
export function detectFormat(fileName: string, mime?: string): DocumentFormat | null {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const byExt = EXT_MAP[ext];
  if (byExt) return byExt;

  const m = (mime ?? '').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('epub')) return 'epub';
  if (m.includes('wordprocessingml')) return 'docx';
  if (m.includes('xhtml') || m.includes('html')) return 'html';
  if (m.includes('markdown')) return 'md';
  if (m.includes('text/plain')) return 'txt';
  return null;
}

export function isSupportedDocument(fileName: string, mime?: string): boolean {
  return detectFormat(fileName, mime) !== null;
}

/** `<input type="file" accept="...">` 用。 */
export const DOCUMENT_ACCEPT_ATTR = Object.keys(EXT_MAP)
  .map((ext) => `.${ext}`)
  .join(',');

export const SUPPORTED_FORMATS: DocumentFormat[] = [
  'txt',
  'md',
  'html',
  'srt',
  'vtt',
  'json',
  'pdf',
  'docx',
  'epub',
];

/** 文件体积上限（默认 20MB），防止用户误开超大文件卡死解析。 */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export function isWithinSizeLimit(input: DocumentInput): boolean {
  const bytes = input.arrayBuffer?.byteLength ?? input.text?.length ?? 0;
  return bytes <= MAX_DOCUMENT_BYTES;
}
