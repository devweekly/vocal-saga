/**
 * 翻译 pipeline — 串联 contentHelper / chunkBuilder / cache / service。
 *
 * 三个对外入口：
 *   - translateText   纯文本批量翻译（不抽 DOM）
 *   - translateDoc    已有 Document（service-side 用 urlFetcher.ts）
 *   - translateUrl    完整 URL → 翻译后 HTML（jsdom + cheerio 回填）
 *
 * Server 端策略：
 *   - chunk 内 missing 自动 retry 一次
 *   - 整 chunk 缓存 (translationCache)
 *   - 全并行翻译（KV cache 不跨请求）
 */

import { prepareDocument } from './contentHelper';
import { buildChunks } from './chunkBuilder';
import {
  buildRetryChunk,
  diffMissingIds,
  shouldRetryMissing,
} from './chunkRetry';
import {
  cacheTranslation,
  getCachedTranslation,
  processTranslationWithCheck,
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
  const chunkLabel = `[Chunk ${chunk.id}]`;
  const cacheKey = generateTranslationCacheKey(chunk.jsonContent, sourceLang, targetLang);

  // 1) 缓存
  const us = (ms: number) => `${Math.round(ms * 1000)}µs`;
  console.log(`${chunkLabel} start (${chunk.blocks.length} blocks, ${chunk.estimatedTokens} tokens)`);
  if (!isRetry) {
    const cached = await getCachedTranslation(cacheKey);
    if (cached) {
      console.log(`${chunkLabel} cache hit`);
      return cached;
    }
  }

  // 2) 调 service（直接并行，不走队列）
  console.log(`${chunkLabel} api.call start`);
  const tApi = performance.now();
  const raw = await service.translate(chunk.jsonContent, sourceLang, targetLang, glossary);
  console.log(`${chunkLabel} api.call done (${us(performance.now() - tApi)})`);

  // 一次 parse 完成 result 提取 + unchanged 检测（原流程 parse 两次）
  const result = processTranslationWithCheck(raw, chunk.blocks.map((b) => ({ id: b.id, text: b.text })));

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
   *   - translateUrl → 6（CF Workers 同时建立连接上限 6，全并发）
   * CF Workers 限制同时最多 6 个 fetch 等待 response headers。
   * Server 端 KV cache 不跨请求，直接全并行。
   */
  concurrency = 6
): Promise<Map<string, string>> {
  const finalTranslations = new Map<string, string>();
  if (chunks.length === 0) return finalTranslations;

  const us = (ms: number) => `${Math.round(ms * 1000)}µs`;
  console.log(`[Pipeline] translateChunks: ${chunks.length} chunks, concurrency=${concurrency}`);
  const tAll = performance.now();

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
    // 全并行翻译（server 端 KV cache 不跨请求）
    const pool = chunks.map((chunk) => processOneChunk(chunk));
    await Promise.all(pool);
    console.log(`[Pipeline] translateChunks done (${us(performance.now() - tAll)})`);
  } catch (err) {
    console.error(`[Pipeline] translateChunks failed after ${us(performance.now() - tAll)}:`, err);
    throw err;
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
  mode?: 'bilingual' | 'target';
  glossary?: Glossary;
  service?: 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare';
  model?: string;
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

  // 根据 service 参数选择翻译服务
  const serviceType = input.service || 'deepseek';
  let service: DeepSeekTranslationService;
  if (serviceType === 'openrouter') {
    const { OpenRouterTranslationService } = await import('./service/openrouter');
    service = new OpenRouterTranslationService() as any;
  } else if (serviceType === 'nvidia') {
    const { NvidiaTranslationService } = await import('./service/nvidia');
    service = new NvidiaTranslationService(input.model) as any;
  } else if (serviceType === 'cloudflare') {
    const { CloudflareAITranslationService } = await import('./service/cloudflare');
    service = new CloudflareAITranslationService() as any;
  } else {
    service = new DeepSeekTranslationService();
  }
  const tTrans = performance.now();
  const translations = await translateChunksWithRetry(
    service,
    chunks,
    sourceLang,
    targetLang,
    input.glossary,
    /* concurrency */ 6
  );
  logCost('translateChunks', tTrans);

  // 回填：一次性 querySelectorAll 建 Map → O(1) 查找（原实现 O(blocks × N)）
  const tApply = performance.now();
  const { applyBlockTranslation } = await import('./translationDisplay');
  const blockMap = new Map<string, Element>();
  page.doc.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
    const id = el.getAttribute('data-fanyi-block-id');
    if (id) blockMap.set(id, el);
  });
  for (const block of blocks) {
    const translated = translations.get(block.id);
    if (!translated) continue;
    const el = blockMap.get(block.id);
    // linkedom 的节点 instanceof jsdom.Element = false，统一用 nodeType 判别；
    // 这里任何 data-fanyi-block-id 节点都是 grabNode 出来的 Element，可信。
    if (el && (el as Node).nodeType === 1) {
      applyBlockTranslation(el as unknown as HTMLElement, translated, mode);
    }
  }
  const tApplyEnd = performance.now();
  logCost('applyTranslations', tApply);   // 含 applyBlockTranslation + querySelectorAll

  const tSer = performance.now();

  // 用 <base> 标签让浏览器原生解析相对 URL，避免手动遍历 DOM
  // 优先更新已有的 <base>，否则在最前面插入一个新的
  const baseUrl = page.finalUrl.replace(/\/?$/, '/');
  const existingBase = page.doc.querySelector('head > base');
  if (existingBase) {
    existingBase.setAttribute('href', baseUrl);
  } else {
    const base = page.doc.createElement('base');
    base.setAttribute('href', baseUrl);
    const head = page.doc.head;
    if (head) head.insertBefore(base, head.firstChild);
  }

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
  console.log(`[PERF] total ${us(logDuration)} fetch=${us(tPrep - tFetch)} prep=${us(tTrans - tPrep)} trans=${us(tApply - tTrans)} apply=${us(tApplyEnd - tApply)} ser=${us(performance.now() - tSer)}`);

  return {
    url: input.url,
    finalUrl: page.finalUrl,
    html,
    blocks: blocks.length,
    chunks: chunks.length,
    duration_ms: Date.now() - start,
  };
}
