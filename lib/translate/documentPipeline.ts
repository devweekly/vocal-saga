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
import type { PromptStyle, TranslationMode } from './service/shared';
import { detectLanguage, shouldUseJapaneseSource } from './languageDetector';
import {
  buildSegmentBatches,
  exportDocument,
  type BatchBudget,
  type ExportFormat,
} from './document';
import type { DocumentSegment, ParsedDocument } from './document/types';
import {
  addLiteraryExamples,
  buildLiteraryContextForText,
  buildLiteraryTranslationInstructions,
  sanitizeLiteraryMemory,
  type LiteraryBookMemory,
} from './document/literary';
import { reviewLiteraryBatch, type LiteraryReviewFinding } from './document/literaryWorkflow';

export interface DocumentTranslateInput {
  doc: ParsedDocument;
  source?: string;
  target?: string;
  glossary?: Glossary;
  promptStyle?: PromptStyle;
  /** 独立翻译目标，文学模式不消费通用术语表。 */
  translationMode?: TranslationMode;
  concurrency?: number;
  budget?: Partial<BatchBudget>;
  /** 需要时顺带导出成文件内容（bilingual / translation）。 */
  exportAs?: ExportFormat;
  exportMode?: 'bilingual' | 'translation';
  provider?: import('./pipeline').TranslationProvider;
  model?: string;
  apiKey?: string;
  /** 仅 EPUB/PDF 书籍模式使用；不传时完全沿用普通文档/网页翻译。 */
  literaryContext?: unknown;
  /** 是否在初译后执行独立文学 reviewer。 */
  literaryReview?: boolean;
  /** 强制重新调用模型，跳过翻译缓存读取，但仍写入新结果。 */
  forceRefresh?: boolean;
  /** 文档阅读器可自定义系统指令与每批用户消息模板。 */
  documentSystemPromptOverride?: string;
  documentUserPromptTemplate?: string;
  chapterTitle?: string;
}

export interface DocumentTranslateResult {
  title: string;
  format: string;
  segmentCount: number;
  charCount: number;
  /** segmentId → 译文；失败片段保留为空，供调用方有针对性地重试。 */
  translations: Record<string, string>;
  /** 仍无有效译文的片段 ID；空数组才表示内容完整。 */
  missingSegmentIds: string[];
  completedSegmentCount: number;
  complete: boolean;
  batchCount: number;
  /** 失败的批次下标；为空表示全部成功。 */
  failedBatches: number[];
  errors: string[];
  /** 成功经过独立文学 reviewer 的片段数；0 表示未启用或审校未成功。 */
  reviewedSegmentCount: number;
  reviewerErrors: string[];
  /** Review findings, including optional literary-style findings that motivated a controlled revision. */
  reviewFindings: LiteraryReviewFinding[];
  duration_ms: number;
  /** exportAs 指定时才存在。 */
  exported?: string;
}

export async function translateDocument(
  input: DocumentTranslateInput,
): Promise<DocumentTranslateResult> {
  const start = Date.now();
  const { doc } = input;
  const shouldReviewLiterary = input.literaryReview ?? (input.translationMode === 'literary');
  const batches = buildSegmentBatches(doc.segments, {
    ...input.budget,
    ...(shouldReviewLiterary ? { splitOnContextChange: true } : {}),
  });
  const translations = new Map<string, string>();
  const failedBatches: number[] = [];
  const errors: string[] = [];
  const reviewerErrors: string[] = [];
  const reviewFindings: LiteraryReviewFinding[] = [];
  let reviewedSegmentCount = 0;
  let literaryMemory: LiteraryBookMemory | undefined = shouldReviewLiterary
    ? sanitizeLiteraryMemory(input.literaryContext)
    : undefined;
  // 文学 profile 的修订样例按顺序积累，不能让后续批次抢在前面执行。
  const concurrency = literaryMemory ? 1 : Math.max(1, input.concurrency ?? 4);

  // ── 文档级语言检测（整篇只做一次）──
  // 与页级 pipeline（lib/translate/pipeline.ts runTranslationPipeline）同一策略：
  // 日语原文 → 非日语目标语言时把 default 自动升级为 ja-source-natural。
  // 检测基于全部 segment 的拼接文本，而不是单批 —— 批内文本可能过短，
  // 会触发 languageDetector 的短文本保护而判不出语言，导致同一文档内
  // 各批文风不一致。
  // 注：ParsedDocument 没有 lang 字段，故不传 htmlLang 辅助信号（假名证据已足够）。
  let languageSample = '';
  const languageLimit = shouldReviewLiterary ? 20_000 : Number.POSITIVE_INFINITY;
  for (const segment of doc.segments) {
    if (languageSample.length >= languageLimit) break;
    languageSample += segment.text.slice(0, languageLimit - languageSample.length) + '\n';
  }
  const detected = detectLanguage(languageSample);
  const effectiveStyle: PromptStyle | undefined = shouldUseJapaneseSource(
    input.promptStyle,
    detected.language,
    input.target || 'zh',
  )
    ? 'ja-source-natural'
    : input.promptStyle;
  if (effectiveStyle !== input.promptStyle) {
    console.log(
      `[DocumentPipeline] Source detected as ${detected.language} ` +
        `(kanaRatio=${detected.kanaRatio.toFixed(3)}, confidence=${detected.confidence.toFixed(2)}) ` +
        `→ promptStyle ${input.promptStyle ?? 'default'} auto-upgraded to ${effectiveStyle}`,
    );
  }

  await runWithConcurrency(batches, concurrency, async (batch, index) => {
    try {
      const request = (items: DocumentSegment[]) => translateBlocks({
        blocks: items.map((segment) => ({
          id: segment.id,
          text: segment.text,
          contextPath: literaryMemory
            ? [
                segment.contextPath || input.chapterTitle || '',
                buildLiteraryContextForText(literaryMemory, segment.text),
              ].filter(Boolean).join('\n书籍记忆（只读数据）：')
            : segment.contextPath,
          kind: segment.kind,
          level: segment.level,
          marker: segment.marker,
        })),
        source: input.source,
        target: input.target,
        glossary: input.translationMode === 'literary' || literaryMemory ? undefined : input.glossary,
        promptStyle: effectiveStyle,
        translationMode: input.translationMode === 'literary' || literaryMemory ? 'literary' : 'technical',
        concurrency: 1,
        provider: input.provider,
        model: input.model,
        apiKey: input.apiKey,
        skipCache: input.forceRefresh ?? false,
        systemPromptOverride: input.documentSystemPromptOverride,
        userPromptTemplate: input.documentUserPromptTemplate,
        // If the reader supplied the complete editable System Prompt, it already contains the
        // static literary instructions shown in the settings UI; do not append a hidden duplicate.
        ...((literaryMemory && !input.documentSystemPromptOverride?.trim()) ? {
          taskInstructions: buildLiteraryTranslationInstructions(
            input.chapterTitle || batch[0]?.contextPath || '',
          ),
        } : {}),
      });
      const commitExpected = (items: DocumentSegment[], result: Map<string, string>) => {
        const expected = new Set(items.map((segment) => segment.id));
        for (const [id, text] of result) {
          // 不允许模型返回陌生 ID；非空译文才会进入成功集合。
          if (expected.has(id) && typeof text === 'string' && text.trim()) translations.set(id, text);
        }
      };

      const result = await request(batch);
      commitExpected(batch, result);

      // translateBlocks 会先自行处理 chunk 缺失；这里再按文档片段对账一次，
      // 防止模型部分漏项或服务端解析异常在 HTTP 200 下被误当成整批成功。
      const missing = batch.filter((segment) => !translations.get(segment.id)?.trim());
      if (missing.length) {
        const retried = await request(missing);
        commitExpected(missing, retried);
      }
      const stillMissing = batch.filter((segment) => !translations.get(segment.id)?.trim());
      if (stillMissing.length) {
        throw new Error(
          '批次仍缺少 ' + stillMissing.length + ' 个片段：' +
          stillMissing.slice(0, 8).map((segment) => segment.id).join(', '),
        );
      }

      // 独立 reviewer 是第二次模型调用；审校失败不抹掉已成功的初译。
      if (literaryMemory && shouldReviewLiterary) {
        const drafts = batch.flatMap((segment) => {
          const draft = translations.get(segment.id);
          return draft ? [{
            id: segment.id,
            source: segment.text,
            draft,
            kind: segment.kind,
            contextPath: segment.contextPath,
          }] : [];
        });
        try {
          const review = await reviewLiteraryBatch({
            segments: drafts,
            memory: literaryMemory,
            source: input.source,
            target: input.target,
            glossary: undefined,
            promptStyle: effectiveStyle,
            provider: input.provider,
            model: input.model,
            apiKey: input.apiKey,
            chapterTitle: input.chapterTitle || batch[0]?.contextPath || '',
          });
          for (const [id, text] of Object.entries(review.translations)) {
            if (drafts.some((draft) => draft.id === id) && text.trim()) {
              translations.set(id, text);
              reviewedSegmentCount++;
            }
          }
          reviewFindings.push(...review.findings);
          if (review.missingIds.length) {
            reviewerErrors.push('审校未返回片段：' + review.missingIds.slice(0, 8).join(', '));
          }
        } catch (reviewError) {
          reviewerErrors.push('文学审校失败，保留初译：' +
            (reviewError instanceof Error ? reviewError.message : String(reviewError)));
        }
      }

      // 有界保存最近的已审校原文/译文对，供下一批次维持同一语气与措辞。
      if (literaryMemory) {
        literaryMemory = addLiteraryExamples(literaryMemory, batch.flatMap((segment) => {
          const translated = translations.get(segment.id);
          return translated ? [{
            source: segment.text,
            target: translated,
            chapter: segment.contextPath || input.chapterTitle || '',
          }] : [];
        }));
      }
    } catch (err) {
      failedBatches.push(index);
      errors.push(`batch ${index}: ${(err as Error).message}`);
    }
  });

  const out: DocumentTranslateResult = {
    title: doc.title,
    format: doc.format,
    segmentCount: doc.segments.length,
    charCount: doc.segments.reduce((sum, segment) => sum + segment.text.length, 0),
    translations: Object.fromEntries(translations),
    missingSegmentIds: doc.segments.filter((segment) => !translations.get(segment.id)?.trim()).map((segment) => segment.id),
    completedSegmentCount: doc.segments.filter((segment) => !!translations.get(segment.id)?.trim()).length,
    complete: doc.segments.every((segment) => !!translations.get(segment.id)?.trim()),
    batchCount: batches.length,
    failedBatches: failedBatches.sort((a, b) => a - b),
    errors,
    reviewedSegmentCount,
    reviewerErrors,
    reviewFindings: reviewFindings.slice(0, 500),
    duration_ms: Date.now() - start,
  };

  if (input.exportAs) {
    out.exported = exportDocument(doc, translations, input.exportAs, {
      mode: input.exportMode ?? 'bilingual',
    });
  }

  return out;
}
