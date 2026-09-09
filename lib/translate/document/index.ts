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
