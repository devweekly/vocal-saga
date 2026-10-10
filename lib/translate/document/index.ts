/**
 * 文档解析统一入口（服务端版）。
 *
 * 与 fanyi-extension 的 `document/index.ts` 保持同步，差异只有一处：
 * **服务端不支持 PDF / DOCX / EPUB**。
 *
 * 原因：这三个是二进制格式，需要 pdfjs-dist（依赖 Worker + canvas，在
 * Netlify Functions / Cloudflare Workers 上要么跑不动要么体积爆炸）
 * 和 jszip。服务端定位是"轻量 API + 网页翻译"，二进制文档交给浏览器扩展
 * 解析更合理 —— 扩展里文件本来就在用户手上，不需要上传。
 * 所以这里直接抛明确错误，而不是静默返回空结果。
 *
 * 支持：TXT / Markdown / HTML / SRT / VTT / JSON
 */
import type { DocumentInput, ParsedDocument } from './types';
import { detectFormat, isWithinSizeLimit, MAX_DOCUMENT_BYTES } from './detect';

// 与 fanyi-extension 保持一致：不静态导出 parser，避免破坏动态 import 的分包。
export * from './types';
export * from './detect';
export * from './batcher';
export * from './export';

export interface ParseDocumentOptions {
  maxSegmentChars?: number;
}

/**
 * 已在客户端完成解析的文档入口。
 *
 * 浏览器扩展能够访问 PDF.js 和本地 OCR/图像能力；服务端只接收规整后的片段，
 * 因此不用在 Worker 中载入 PDF.js、canvas 或再次解析原始二进制文件。
 * 这里会重新验证 ID、类型、长度与结构，防止错误片段导致译文错位或部分成功被误报。
 */
export interface StructuredDocumentPayload {
  fileName: string;
  title?: string;
  format: unknown;
  segments: unknown;
  warnings?: unknown;
}

const STRUCTURED_FORMATS = new Set<DocumentFormat>([
  'pdf', 'txt', 'md', 'html', 'srt', 'vtt', 'json', 'docx', 'epub',
]);
const STRUCTURED_SEGMENT_KINDS = new Set([
  'heading', 'paragraph', 'list-item', 'caption', 'code', 'quote', 'other',
]);
const MAX_STRUCTURED_SEGMENTS = 20_000;
const MAX_STRUCTURED_TEXT_CHARS = 1_500_000;

/**
 * 验证并构造标准 ParsedDocument，不尝试解析原文件。
 * id 必须唯一且稳定；服务端在翻译和回填过程中始终保留调用方的 id。
 */
export function createStructuredDocument(input: StructuredDocumentPayload): ParsedDocument {
  if (!input.fileName?.trim()) throw new Error('fileName is required');
  if (typeof input.format !== 'string' || !STRUCTURED_FORMATS.has(input.format as DocumentFormat)) {
    throw new Error('不支持的结构化文档格式：' + String(input.format));
  }
  if (!Array.isArray(input.segments)) throw new Error('segments 必须是数组');
  if (input.segments.length > MAX_STRUCTURED_SEGMENTS) {
    throw new Error('片段数量超过上限 ' + MAX_STRUCTURED_SEGMENTS);
  }

  const ids = new Set<string>();
  let charCount = 0;
  const segments: DocumentSegment[] = input.segments.map((raw: unknown, index: number) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('segments[' + index + '] 必须是对象');
    }
    const value = raw as Record<string, unknown>;
    if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200) {
      throw new Error('segments[' + index + '].id 必须是 1-200 字符的非空字符串');
    }
    if (ids.has(value.id)) throw new Error('发现重复片段 ID：' + value.id);
    ids.add(value.id);
    if (typeof value.text !== 'string' || !value.text.trim()) {
      throw new Error('segments[' + index + '].text 不能为空');
    }
    charCount += value.text.length;
    if (charCount > MAX_STRUCTURED_TEXT_CHARS) {
      throw new Error('结构化文档文本超过 ' + MAX_STRUCTURED_TEXT_CHARS + ' 字符上限；大文档请拆分后分批提交');
    }

    const kind = typeof value.kind === 'string' && STRUCTURED_SEGMENT_KINDS.has(value.kind)
      ? value.kind as DocumentSegment['kind']
      : 'paragraph';
    const segment: DocumentSegment = {
      id: value.id,
      index,
      text: value.text.trim(),
      kind,
    };
    if (Number.isInteger(value.level) && (value.level as number) >= 1 && (value.level as number) <= 6) {
      segment.level = value.level as number;
    }
    if (Number.isInteger(value.page) && (value.page as number) > 0) {
      segment.page = value.page as number;
    }
    if (typeof value.marker === 'string' && value.marker.trim()) segment.marker = value.marker.trim().slice(0, 20);
    if (typeof value.contextPath === 'string' && value.contextPath.trim()) {
      segment.contextPath = value.contextPath.trim().slice(0, 500);
    }
    if (typeof value.path === 'string' && value.path.trim()) segment.path = value.path.trim().slice(0, 1000);
    if (typeof value.start === 'string') segment.start = value.start;
    if (typeof value.end === 'string') segment.end = value.end;
    return segment;
  });

  const warnings = Array.isArray(input.warnings)
    ? input.warnings.filter((warning): warning is string => typeof warning === 'string').slice(0, 100)
    : [];

  return {
    format: input.format as DocumentFormat,
    title: (typeof input.title === 'string' && input.title.trim() ? input.title.trim() : input.fileName).slice(0, 500),
    segments,
    meta: { charCount, segmentCount: segments.length, warnings },
  };
}

/** 服务端可解析的格式。 */
export const SERVER_SUPPORTED_FORMATS = ['txt', 'md', 'html', 'srt', 'vtt', 'json'] as const;

export class UnsupportedDocumentError extends Error {
  constructor(public readonly fileName: string, reason?: string) {
    super(reason ?? `不支持的文件类型：${fileName}（服务端支持 ${SERVER_SUPPORTED_FORMATS.join('/')}）`);
    this.name = 'UnsupportedDocumentError';
  }
}

export async function parseDocument(
  input: DocumentInput,
  options: ParseDocumentOptions = {},
): Promise<ParsedDocument> {
  const format = detectFormat(input.fileName, input.mime);
  if (!format) throw new UnsupportedDocumentError(input.fileName);

  if ((['pdf', 'docx', 'epub'] as string[]).includes(format)) {
    throw new UnsupportedDocumentError(
      input.fileName,
      `${format.toUpperCase()} 为二进制格式，服务端不支持解析；请使用浏览器扩展的文档翻译（本地解析，无需上传）`,
    );
  }

  if (!isWithinSizeLimit(input)) {
    throw new Error(
      `文件超过 ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB 上限，请拆分后再试`,
    );
  }

  const getText = (): string => {
    if (input.text != null) return input.text;
    if (input.arrayBuffer) return new TextDecoder('utf-8').decode(input.arrayBuffer);
    throw new Error('文件内容为空');
  };

  switch (format) {
    case 'txt':
    case 'md': {
      const { parseTextDocument } = await import('./parsers/text');
      return parseTextDocument(getText(), format, {
        maxSegmentChars: options.maxSegmentChars,
        fileName: input.fileName,
      });
    }
    case 'srt':
    case 'vtt': {
      const { parseSubtitleDocument } = await import('./parsers/subtitle');
      return parseSubtitleDocument(getText(), format, input.fileName);
    }
    case 'html': {
      const { parseHtmlDocument } = await import('./parsers/html');
      return parseHtmlDocument(getText(), {
        maxSegmentChars: options.maxSegmentChars,
        fileName: input.fileName,
      });
    }
    case 'json': {
      const { parseJsonDocument } = await import('./parsers/json');
      return parseJsonDocument(getText(), {
        maxSegmentChars: options.maxSegmentChars,
        fileName: input.fileName,
      });
    }
    default:
      throw new UnsupportedDocumentError(input.fileName);
  }
}
