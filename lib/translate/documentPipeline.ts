/**
 * 服务端文档翻译编排。
 *
 * 与浏览器扩展版 `useDocumentTranslation` 同一套策略，区别是这里没有 UI，
 * 所以把"逐批提交 + 失败隔离"做成纯函数，结果一次性返回：
 *   - 先按预算分批，再并发翻译
 *   - 每批成功立刻写入结果 Map（per-segment commit）
 *   - 单批失败只影响该批，记录在 failedBatches，调用方可只重跑失败批次
 *   - 有 `exportAs` 时顺带产出可直接下载的文件内容
 */
import { runWithConcurrency } from './concurrency';
import { translateBlocks } from './pipeline';
import type { Glossary } from './service/_service';
import type { PromptStyle } from './service/shared';
import {
  buildSegmentBatches,
  exportDocument,
  type BatchBudget,
  type ExportFormat,
} from './document';
import type { DocumentSegment, ParsedDocument } from './document/types';

export interface DocumentTranslateInput {
  doc: ParsedDocument;
  source?: string;
  target?: string;
  glossary?: Glossary;
  promptStyle?: PromptStyle;
  concurrency?: number;
  budget?: Partial<BatchBudget>;
  /** 需要时顺带导出成文件内容（bilingual / translation）。 */
  exportAs?: ExportFormat;
  exportMode?: 'bilingual' | 'translation';
}

export interface DocumentTranslateResult {
  title: string;
  format: string;
  segmentCount: number;
  charCount: number;
  /** segmentId → 译文 */
  translations: Record<string, string>;
  batchCount: number;
  /** 失败的批次下标；为空表示全部成功。 */
  failedBatches: number[];
  errors: string[];
  duration_ms: number;
  /** exportAs 指定时才存在。 */
  exported?: string;
}

export async function translateDocument(
  input: DocumentTranslateInput,
): Promise<DocumentTranslateResult> {
  const start = Date.now();
  const { doc } = input;
  const batches = buildSegmentBatches(doc.segments, input.budget);
  const translations = new Map<string, string>();
  const failedBatches: number[] = [];
  const errors: string[] = [];
  const concurrency = Math.max(1, input.concurrency ?? 4);

  await runWithConcurrency(batches, concurrency, async (batch, index) => {
    try {
      const result = await translateBlocks({
        blocks: batch.map((s: DocumentSegment) => ({ id: s.id, text: s.text })),
        source: input.source,
        target: input.target,
        glossary: input.glossary,
        promptStyle: input.promptStyle,
        concurrency: 1,
      });
      // 逐批提交：成功的批立刻可见，失败的批不影响已完成部分
      for (const [id, text] of result) {
        if (text) translations.set(id, text);
      }
    } catch (err) {
      failedBatches.push(index);
      errors.push(`batch ${index}: ${(err as Error).message}`);
    }
  });

  const out: DocumentTranslateResult = {
    title: doc.title,
    format: doc.format,
    segmentCount: doc.meta.segmentCount,
    charCount: doc.meta.charCount,
    translations: Object.fromEntries(translations),
    batchCount: batches.length,
    failedBatches,
    errors,
    duration_ms: Date.now() - start,
  };

  if (input.exportAs) {
    out.exported = exportDocument(doc, translations, input.exportAs, {
      mode: input.exportMode ?? 'bilingual',
    });
  }

  return out;
}
