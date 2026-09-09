/**
 * 文档翻译 —— 类型定义（纯类型，无运行时依赖）。
 *
 * 设计要点（参考 FluentRead 文档翻译的分层思路，独立实现，不含其源码）：
 *   1. 所有格式的解析产物统一压平成「segment 列表」，与具体格式解耦。
 *      这样翻译管线可以完全复用网页翻译已有的 chunkBuilder / cacheKey /
 *      chunkRetry / singleflight，不必为每种格式重写一遍。
 *   2. segment.id 必须稳定 —— 译文按 id 回填，同一文件重开能命中缓存。
 *   3. kind 让导出时还原层级（标题 / 正文 / 列表 / 字幕），而不是糊成纯文本。
 *   4. 本层不依赖任何浏览器 API，便于同步到服务端（vocal-saga）。
 */

/** 支持的文档格式。 */
export type DocumentFormat =
  | 'txt'
  | 'md'
  | 'html'
  | 'srt'
  | 'vtt'
  | 'json'
  | 'pdf'
  | 'docx'
  | 'epub';

/** 片段语义类型，导出时用于还原结构。 */
export type SegmentKind =
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'caption'
  | 'code'
  | 'quote'
  | 'other';

/** 一个待翻译片段。 */
export interface DocumentSegment {
  /** 稳定 id，译文按此回填。 */
  id: string;
  index: number;
  /** 待翻译原文（已 trim）。 */
  text: string;
  kind: SegmentKind;
  /** 源文件内路径（EPUB spine href / DOCX part），导出回填用。 */
  path?: string;
  /** 标题层级 1-6，仅 heading。 */
  level?: number;
  /** 字幕起止时间码（SRT/VTT），导出双语字幕时用。 */
  start?: string;
  end?: string;
}

export interface ParsedDocument {
  format: DocumentFormat;
  title: string;
  segments: DocumentSegment[];
  meta: {
    charCount: number;
    segmentCount: number;
    /**
     * 解析过程中的非致命提示，例如
     * "PDF 第 3 页无可提取文字，可能是扫描件"。
     * UI 直接展示，让用户知道为什么不完整。
     */
    warnings: string[];
  };
}

/** 解析入口的最小输入：文件名 + 内容。二进制格式走 arrayBuffer。 */
export interface DocumentInput {
  fileName: string;
  mime?: string;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}
