/**
 * 翻译 pipeline — 串联 contentHelper / chunkBuilder / translationQueue / cache / service。
 *
 * 三个对外入口：
 *   - translateText   纯文本批量翻译（不抽 DOM）
 *   - translateDoc    已有 Document（service-side 用 urlFetcher.ts）
 *   - translateUrl    完整 URL → 翻译后 HTML（jsdom + cheerio 回填）
 *
 * 保留 fanyi-extension 的核心策略：
 *   - 串行请求 (globalQueue.concurrency=1) 保 DeepSeek KV cache 命中
 *   - chunk 内 missing 自动 retry 一次
 *   - 整 chunk 缓存 (translationCache)
 */

import { prepareDocument } from './contentHelper';
import { buildChunks } from './chunkBuilder';
import {
  buildRetryChunk,
  diffMissingIds,
  shouldRetryMissing,
} from './chunkRetry';
import { globalQueue } from './translationQueue';
import {
  cacheTranslation,
  getCachedTranslation,
  processTranslationResult,
} from './translateApi';
import { generateTranslationCacheKey } from './cacheKey';
import { DeepSeekTranslationService } from './service/deepseek';
import type { Glossary } from './service/_service';
import { fetchPage } from './urlFetcher';

// =============================================================================
// 内部：chunk → translation
// =============================================================================

async function translateChunk(
  service: DeepSeekTranslationService,
  chunk: ReturnType<typeof buildChunks>[number],
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary,
  isRetry = false
): Promise<Map<string, string>> {
  const cacheKey = generateTranslationCacheKey(chunk.jsonContent, sourceLang, targetLang);

  // 1) 缓存
  if (!isRetry) {
    const cached = await getCachedTranslation(cacheKey);
    if (cached) {
      console.log(`[Pipeline] cache hit ${cacheKey} (${chunk.blocks.length} blocks)`);
      return cached;
    }
  }

  // 2) 调 service（串行队列保 KV cache）
  const raw = await globalQueue.add(() =>
    service.translate(chunk.jsonContent, sourceLang, targetLang, glossary)
  );

  const result = processTranslationResult(raw);

  // 3) 缓存（仅首次）
  if (!isRetry) {
    await cacheTranslation(cacheKey, result);
  }

  return result;
}

async function translateChunksWithRetry(
  service: DeepSeekTranslationService,
  chunks: ReturnType<typeof buildChunks>,
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary
): Promise<Map<string, string>> {
  const finalTranslations = new Map<string, string>();

  for (const chunk of chunks) {
    const result = await translateChunk(service, chunk, sourceLang, targetLang, glossary);

    // 缺失检测
    const inputIds = chunk.blocks.map((b) => b.id);
    const outputIds = Array.from(result.keys());
    const missingIds = diffMissingIds(inputIds, outputIds);

    if (
      shouldRetryMissing({
        missingCount: missingIds.length,
        totalCount: chunk.blocks.length,
        isRetry: chunk.id.endsWith('_retry'),
      })
    ) {
      console.warn(
        `[Pipeline] ${chunk.id} missing ${missingIds.length}/${chunk.blocks.length}, retrying`
      );
      const retryChunk = buildRetryChunk(chunk, missingIds);
      const retryResult = await translateChunk(
        service,
        retryChunk,
        sourceLang,
        targetLang,
        glossary,
        /* isRetry */ true
      );
      for (const [id, text] of retryResult) {
        result.set(id, text);
      }
    }

    for (const [id, text] of result) {
      finalTranslations.set(id, text);
    }
  }

  return finalTranslations;
}

// =============================================================================
// 对外：translateText
// =============================================================================

export interface TranslateTextInput {
  text: string;
  source?: string;
  target?: string;
  apiKey: string;
  glossary?: Glossary;
}

export interface TranslateTextResult {
  translations: Array<{ id: string; text: string }>;
  chunks: number;
  duration_ms: number;
}

export async function translateText(input: TranslateTextInput): Promise<TranslateTextResult> {
  const start = Date.now();
  const sourceLang = input.source || 'auto';
  const targetLang = input.target || 'zh';

  if (!input.text.trim()) {
    return { translations: [], chunks: 0, duration_ms: 0 };
  }

  // 把整段文本当作一个 block（id=b1）→ chunkBuilder 按 token 切
  const blocks = [
    { id: 'b1', xpath: '', tag: 'p', text: input.text.trim() },
  ];
  const chunks = buildChunks(blocks as any);

  const service = new DeepSeekTranslationService(input.apiKey);
  const translations = await translateChunksWithRetry(
    service,
    chunks,
    sourceLang,
    targetLang,
    input.glossary
  );

  return {
    translations: Array.from(translations, ([id, text]) => ({ id, text })),
    chunks: chunks.length,
    duration_ms: Date.now() - start,
  };
}

// =============================================================================
// 对外：translateUrl → 返回翻译后 HTML
// =============================================================================

export interface TranslateUrlInput {
  url: string;
  source?: string;
  target?: string;
  apiKey: string;
  mode?: 'bilingual' | 'target';
  glossary?: Glossary;
}

export interface TranslateUrlResult {
  url: string;
  finalUrl: string;
  html: string;
  blocks: number;
  chunks: number;
  duration_ms: number;
}

export async function translateUrl(input: TranslateUrlInput): Promise<TranslateUrlResult> {
  const start = Date.now();
  const sourceLang = input.source || 'auto';
  const targetLang = input.target || 'zh';
  const mode = input.mode || 'bilingual';

  const page = await fetchPage(input.url);
  console.log(`[Pipeline] Fetched ${input.url} → ${page.finalUrl} (${page.status}, ${page.html.length} bytes)`);

  const { blocks, chunks } = prepareDocument(page.doc, page.finalUrl);
  console.log(`[Pipeline] Extracted ${blocks.length} blocks → ${chunks.length} chunks`);

  const service = new DeepSeekTranslationService(input.apiKey);
  const translations = await translateChunksWithRetry(
    service,
    chunks,
    sourceLang,
    targetLang,
    input.glossary
  );

  // 回填：jsdom 写回原 Document（保留所有 children，只 wrap 一个 .fanyi-translation）
  const { applyBlockTranslation } = await import('./translationDisplay');
  for (const block of blocks) {
    const translated = translations.get(block.id);
    if (!translated) continue;
    const el = page.doc.querySelector(`[data-fanyi-block-id="${block.id}"]`);
    // linkedom 的节点 instanceof jsdom.Element = false，统一用 nodeType 判别；
    // 这里任何 data-fanyi-block-id 节点都是 grabNode 出来的 Element，可信。
    if (el && (el as Node).nodeType === 1) {
      applyBlockTranslation(el as unknown as HTMLElement, translated, mode);
    }
  }

  // 序列化为 HTML（去掉 <script> 减少泄露）
  page.doc.querySelectorAll('script').forEach((s) => s.remove());

  // 注入双语显示 CSS —— 只针对我们注入的 .fanyi-original / .fanyi-translation，
  // 不覆盖原页面任何已有元素的样式（用 currentColor + 0 opacity，没有强制颜色）。
  const head = page.doc.head;
  if (head && !head.querySelector('#fanyi-bilingual-styles')) {
    const style = page.doc.createElement('style');
    style.id = 'fanyi-bilingual-styles';
    style.textContent = [
      '/* 双语对照样式 —— 仅作用于翻译注入的 span，不覆盖原页面 */',
      '.fanyi-original { /* 原样保留，不动 */ }',
      '.fanyi-translation {',
      '  display: block;',
      '  margin: 0.2em 0 0.4em 0;',
      '  padding: 0.15em 0.6em;',
      '  border-left: 3px solid currentColor;',
      '  font-style: italic;',
      '  opacity: 0.7;',
      '  font-size: 0.95em;',
      '  line-height: 1.4;',
      '}',
      '.fanyi-translated { /* 容器：仅加 class，不改原样式 */ }',
    ].join('\n');
    head.appendChild(style);
  }

  const html = '<!doctype html>\n' + page.doc.documentElement.outerHTML;

  return {
    url: input.url,
    finalUrl: page.finalUrl,
    html,
    blocks: blocks.length,
    chunks: chunks.length,
    duration_ms: Date.now() - start,
  };
}
