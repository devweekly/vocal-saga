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
// 性能日志
// =============================================================================

function logCost(label: string, startMs: number): void {
  console.log(`[PERF] ${label} ${Math.round((performance.now() - startMs) * 1000)}µs`);
}

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
  const tChunk = performance.now();
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
  console.log(`[Chunk ${chunk.id}] translate start, ${chunk.blocks.length} blocks, ${chunk.estimatedTokens} est. tokens`);
  const raw = await globalQueue.add(() =>
    service.translate(chunk.jsonContent, sourceLang, targetLang, glossary)
  );
  logCost(`Chunk ${chunk.id} translate`, tChunk);

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
  glossary?: Glossary,
  /**
   * 并行 chunk 数。
   *   - translateText（小文本，单 chunk）→ 1
   *   - translateUrl（多 chunk，30s CF 壁钟上限）→ 2
   * 增大 concurrency 会降低 DeepSeek KV cache 命中率，但减少 wall-clock 总耗时。
   * 不要超过 5，否则容易触发 DeepSeek 429 rate limit。
   */
  concurrency = 1
): Promise<Map<string, string>> {
  const finalTranslations = new Map<string, string>();
  if (chunks.length === 0) return finalTranslations;

  // 临时提高队列并发，让 worker 池能同时发出多个请求
  globalQueue.setConcurrency(concurrency);

  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < chunks.length) {
      const idx = nextIdx++;
      const chunk = chunks[idx];

      try {
        await processOneChunk(chunk);
      } catch (err) {
        // 让第一个失败的 chunk 传播到外层
        throw err;
      }
    }
  }

  async function processOneChunk(
    chunk: ReturnType<typeof buildChunks>[number]
  ): Promise<void> {
    const result = await translateChunk(service, chunk, sourceLang, targetLang, glossary);

    // 缺失检测 + 重试
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

  try {
    const pool = Array.from(
      { length: Math.min(concurrency, chunks.length) },
      () => worker()
    );
    await Promise.all(pool);
  } finally {
    // 恢复串行（保后续请求的 KV cache 命中）
    globalQueue.setConcurrency(1);
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

  const tFetch = performance.now();
  const page = await fetchPage(input.url);
  logCost('fetchPage', tFetch);
  console.log(`[Pipeline] Fetched ${input.url} → ${page.finalUrl} (${page.status}, ${page.html.length} bytes)`);

  const tPrep = performance.now();
  const { blocks, chunks } = prepareDocument(page.doc, page.finalUrl);
  logCost('prepareDocument', tPrep);
  console.log(`[Pipeline] Extracted ${blocks.length} blocks → ${chunks.length} chunks`);

  const service = new DeepSeekTranslationService(input.apiKey);
  const tTrans = performance.now();
  const translations = await translateChunksWithRetry(
    service,
    chunks,
    sourceLang,
    targetLang,
    input.glossary,
    /* concurrency */ 2
  );
  logCost('translateChunks', tTrans);

  // 回填：jsdom 写回原 Document（保留所有 children，只 wrap 一个 .fanyi-translation）
  const tApply = performance.now();
  const { applyBlockTranslation } = await import('./translationDisplay');
  let queryMs = 0;
  for (const block of blocks) {
    const translated = translations.get(block.id);
    if (!translated) continue;
    const tQ = performance.now();
    const el = page.doc.querySelector(`[data-fanyi-block-id="${block.id}"]`);
    queryMs += performance.now() - tQ;
    // linkedom 的节点 instanceof jsdom.Element = false，统一用 nodeType 判别；
    // 这里任何 data-fanyi-block-id 节点都是 grabNode 出来的 Element，可信。
    if (el && (el as Node).nodeType === 1) {
      applyBlockTranslation(el as unknown as HTMLElement, translated, mode);
    }
  }
  console.log(`[PERF] querySelectorTotal ${Math.round(queryMs * 1000)}µs`); // 仅 querySelector 累计耗时
  const tApplyEnd = performance.now();
  logCost('applyTranslations', tApply);   // 含 applyBlockTranslation + querySelector

  // 序列化为 HTML（去掉 <script> 减少泄露）
  const tSer = performance.now();
  page.doc.querySelectorAll('script').forEach((s) => s.remove());

  // 把相对 URL 转绝对 URL（先注入的 style 里没有 URL，安全放在最后一步做）
  const baseUrl = page.finalUrl.replace(/\/?$/, '/');
  const resolveAttr = (el: Element, attr: string) => {
    const val = el.getAttribute(attr);
    if (!val) return;
    // data:/blob:/# 开头、// 开头、http/https 开头 → 已是绝对，跳过
    if (/^(data:|blob:|#|https?:\/\/|\/\/)/i.test(val)) return;
    if (/^\/\//.test(val)) { el.setAttribute(attr, 'https:' + val); return; }
    el.setAttribute(attr, new URL(val, baseUrl).href);
  };
  const URL_ATTRS = ['src', 'href', 'data-src', 'poster'];
  page.doc.querySelectorAll('img, source, video, audio, iframe, embed, a, link, [data-src]').forEach((el) => {
    for (const attr of URL_ATTRS) resolveAttr(el, attr);
  });
  // srcset 特殊处理：逗号分隔的多个 URL
  page.doc.querySelectorAll('img, source').forEach((el) => {
    const val = el.getAttribute('srcset');
    if (!val) return;
    const resolved = val.split(',').map((part) => {
      const [url, ...desc] = part.trim().split(/\s+/);
      if (!url || /^(data:|blob:|#|https?:\/\/|\/\/)/i.test(url)) return part;
      const resolvedUrl = url.startsWith('//') ? 'https:' + url : new URL(url, baseUrl).href;
      return [resolvedUrl, ...desc].join(' ');
    }).join(', ');
    el.setAttribute('srcset', resolved);
  });

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
  logCost('serializeHTML', tSer);

  const logDuration = performance.now() - tFetch;
  function us(v: number): string { return `${Math.round(v * 1000)}µs`; }
  console.log(`[PERF] total ${us(logDuration)} fetch=${us(tPrep - tFetch)} prep=${us(tTrans - tPrep)} trans=${us(tApply - tTrans)} apply=${us(tApplyEnd - tApply)} ser=${us(performance.now() - tSer)} querySel=${us(queryMs)}`);

  return {
    url: input.url,
    finalUrl: page.finalUrl,
    html,
    blocks: blocks.length,
    chunks: chunks.length,
    duration_ms: Date.now() - start,
  };
}
