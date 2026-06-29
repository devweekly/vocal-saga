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
import { buildChunks, type Chunk } from './chunkBuilder';
import { extractBlocksFromMarkedHtml, type TextBlock } from './blockExtractor';
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
import { parseHTML } from 'linkedom';

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

  const service = new DeepSeekTranslationService();
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
  mode?: 'bilingual';
  glossary?: Glossary;
  /** LLM 提供方，统一字段名 provider（避免与 TranslationService 类混淆） */
  provider?: 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare' | 'mimo' | 'gemini' | 'opencode';
  model?: string;
}

export interface TranslateUrlResult {
  url: string;
  finalUrl: string;
  title: string;
  html: string;
  blocks: number;
  translatedBlocks: number;
  chunks: number;
  duration_ms: number;
}

export interface TranslateHtmlInput {
  html: string;
  url: string;
  source?: string;
  target?: string;
  mode?: 'bilingual';
  glossary?: Glossary;
  /** LLM 提供方，统一字段名 provider（避免与 TranslationService 类混淆） */
  provider?: 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare' | 'mimo' | 'gemini' | 'opencode';
  model?: string;
  /** 客户端传入的 DeepSeek API Key（/fanyi/page 使用） */
  apiKey?: string;
}

async function runTranslationPipeline(
  doc: Document,
  finalUrl: string,
  sourceLang: string,
  targetLang: string,
  mode: 'bilingual',
  provider: 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare' | 'mimo' | 'gemini' | 'opencode',
  model: string | undefined,
  glossary: Glossary | undefined,
  existingBlocks?: TextBlock[],
  existingChunks?: Chunk[],
  apiKey?: string,
): Promise<{ title: string; html: string; blocks: number; translatedBlocks: number; chunks: number }> {
  const title =
    (doc.querySelector('title')?.textContent || '').trim().substring(0, 200) ||
    finalUrl;

  const tPrep = performance.now();
  let blocks: TextBlock[];
  let chunks: Chunk[];

  if (existingChunks && existingChunks.length > 0) {
    // 扩展端已分块，直接使用
    chunks = existingChunks;
    blocks = existingBlocks || chunks.flatMap((c) => c.blocks);
    console.log(`[Pipeline] Using ${blocks.length} pre-extracted blocks → ${chunks.length} pre-built chunks`);
  } else if (existingBlocks && existingBlocks.length > 0) {
    // 扩展端提供了 blocks，服务端分块
    blocks = existingBlocks;
    chunks = buildChunks(blocks);
    console.log(`[Pipeline] Using ${blocks.length} pre-extracted blocks → ${chunks.length} chunks`);
  } else {
    // 原有流程：从 HTML 提取
    const result = prepareDocument(doc, finalUrl);
    blocks = result.blocks;
    chunks = result.chunks;
    console.log(`[Pipeline] Extracted ${blocks.length} blocks → ${chunks.length} chunks`);
  }

  // 根据 provider 选择翻译服务实例（局部变量 service 指 TranslationService 实例）
  let service: DeepSeekTranslationService;
  if (provider === 'openrouter') {
    const { OpenRouterTranslationService } = await import('./service/openrouter');
    service = new OpenRouterTranslationService() as any;
  } else if (provider === 'nvidia') {
    const { NvidiaTranslationService } = await import('./service/nvidia');
    service = new NvidiaTranslationService(model) as any;
  } else if (provider === 'cloudflare') {
    const { CloudflareAITranslationService } = await import('./service/cloudflare');
    service = new CloudflareAITranslationService() as any;
  } else if (provider === 'mimo') {
    const { MimoTranslationService } = await import('./service/mimo');
    service = new MimoTranslationService() as any;
  } else if (provider === 'gemini') {
    const { GeminiTranslationService } = await import('./service/gemini');
    service = new GeminiTranslationService(model) as any;
  } else if (provider === 'opencode') {
    const { OpencodeTranslationService } = await import('./service/opencode');
    service = new OpencodeTranslationService() as any;
  } else {
    service = new DeepSeekTranslationService(apiKey);
  }
  const tTrans = performance.now();
  const translations = await translateChunksWithRetry(
    service,
    chunks,
    sourceLang,
    targetLang,
    glossary,
    /* concurrency */ 6
  );

  // 回填：一次性 querySelectorAll 建 Map → O(1) 查找（原实现 O(blocks × N)）
  const tApply = performance.now();
  const { applyBlockTranslation, applyInlineTranslation } = await import('./translationDisplay');
  const blockMap = new Map<string, Element>();
  doc.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
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
      const htmlEl = el as unknown as HTMLElement;
      // Render 阶段最终决定：candidate + 译文也要短
      const shouldInline =
        block.renderHint?.inlineCandidate === true &&
        translated.length <= 40 &&               // 译文不超过 40 字符
        translated.split(/\s+/).length <= 12;    // 译文不超过 12 词
      if (shouldInline) {
        applyInlineTranslation(htmlEl, translated, mode);
      } else {
        applyBlockTranslation(htmlEl, translated, mode);
      }
    }
  }
  const tApplyEnd = performance.now();

  const tSer = performance.now();

  // 用 <base> 标签让浏览器原生解析相对 URL，避免手动遍历 DOM
  const cleanUrl = finalUrl.split('?')[0].split('#')[0];
  let baseUrl: string;
  if (cleanUrl.endsWith('/')) {
    baseUrl = cleanUrl;
  } else if (/\.[a-zA-Z0-9]{1,10}$/.test(cleanUrl)) {
    baseUrl = new URL('.', cleanUrl).href;
  } else {
    baseUrl = cleanUrl + '/';
  }
  const existingBase = doc.querySelector('head > base');
  if (existingBase) {
    existingBase.setAttribute('href', baseUrl);
  } else {
    const base = doc.createElement('base');
    base.setAttribute('href', baseUrl);
    const head = doc.head;
    if (head) head.insertBefore(base, head.firstChild);
  }

  // 注入双语显示 CSS —— 只针对我们注入的 span，不覆盖原页面任何已有元素的样式。
  const head = doc.head;
  if (head && !head.querySelector('#fanyi-bilingual-styles')) {
    const style = doc.createElement('style');
    style.id = 'fanyi-bilingual-styles';
    style.textContent = [
      '/* 双语对照样式 —— 仅作用于翻译注入的 span，不覆盖原页面 */',
      '.fanyi-original { /* 原样保留，不动 */ }',
      '.fanyi-translation {',
      '  display: block;',
      '  margin: 0.2em 0 0.4em 0;',
      '  padding: 0.15em 0.6em;',
      '  border-left: 3px solid currentColor;',
      '}',
      '.fanyi-inline-original { /* 原文：继承原页面样式，不额外设颜色 */ }',
      '.fanyi-inline-translation {',
      '  opacity: 0.75;',
      '  font-size: 0.9em;',
      '  margin-left: 0.3em;',
      '  white-space: normal;',
      '}',
      '.fanyi-translated { /* 容器：仅加 class，不改原样式 */ }',
      '',
      '/* 低优先级元素视觉弱化（footer/nav/aside/广告/社交等） */',
      '[data-fanyi-low-priority="true"] {',
      '  opacity: 0.35;',
      '  filter: grayscale(60%);',
      '  transition: opacity 0.2s ease, filter 0.2s ease;',
      '}',
      '[data-fanyi-low-priority="true"]:hover {',
      '  opacity: 1;',
      '  filter: none;',
      '}',
      '',
      '/* 弹窗 / Cookie Banner / Overlay 直接隐藏 */',
      '[data-fanyi-remove="true"] {',
      '  display: none !important;',
      '  visibility: hidden !important;',
      '  pointer-events: none !important;',
      '}',
    ].join('\n');
    head.appendChild(style);
  }

  const html = '<!doctype html>\n' + doc.documentElement.outerHTML;

  const logDuration = performance.now() - tPrep;
  function us(v: number): string { return `${Math.round(v * 1000)}µs`; }
  console.log(`[PERF] total ${us(logDuration)} prep=${us(tTrans - tPrep)} trans=${us(tApply - tTrans)} apply=${us(tApplyEnd - tApply)} ser=${us(performance.now() - tSer)}`);

  return {
    title,
    html,
    blocks: blocks.length,
    translatedBlocks: translations.size,
    chunks: chunks.length,
  };
}

export async function translateUrl(input: TranslateUrlInput): Promise<TranslateUrlResult> {
  const start = Date.now();
  const sourceLang = input.source || 'auto';
  const targetLang = input.target || 'zh';
  const mode = input.mode || 'bilingual';

  const page = await fetchPage(input.url);

  console.log(`[Pipeline] Fetched ${input.url} → ${page.finalUrl} (${page.status}, ${page.html.length} bytes)`);

  const result = await runTranslationPipeline(
    page.doc,
    page.finalUrl,
    sourceLang,
    targetLang,
    mode,
    input.provider || 'deepseek',
    input.model,
    input.glossary,
  );

  return {
    url: input.url,
    finalUrl: page.finalUrl,
    title: result.title,
    html: result.html,
    blocks: result.blocks,
    translatedBlocks: result.translatedBlocks,
    chunks: result.chunks,
    duration_ms: Date.now() - start,
  };
}

export async function translateHtml(input: TranslateHtmlInput): Promise<TranslateUrlResult> {
  const start = Date.now();
  const sourceLang = input.source || 'auto';
  const targetLang = input.target || 'zh';
  const mode = input.mode || 'bilingual';

  // 用 linkedom 解析扩展传来的 HTML
  const { document: doc } = parseHTML(input.html) as unknown as { document: Document };

  // 设置 baseURI，让相对 URL 能正确解析
  try {
    if (doc.documentElement) {
      (doc.documentElement as unknown as { baseURI?: string }).baseURI = input.url;
    }
  } catch {
    /* ignore */
  }

  // 检测扩展端是否已在 HTML 中标记了 data-fanyi-block-id
  // 如果标记了，说明扩展端已在浏览器中执行过 walker，服务端无需重新 walk
  const hasMarkedBlocks = doc.querySelector('[data-fanyi-block-id]') !== null;
  let preExtractedBlocks: TextBlock[] | undefined;

  if (hasMarkedBlocks) {
    preExtractedBlocks = extractBlocksFromMarkedHtml(doc);
    console.log(`[Pipeline] Received pre-marked HTML from extension: ${input.url} (${input.html.length} bytes, ${preExtractedBlocks.length} blocks)`);
  } else {
    console.log(`[Pipeline] Received HTML from extension: ${input.url} (${input.html.length} bytes, no pre-marked blocks)`);
  }

  const result = await runTranslationPipeline(
    doc,
    input.url,
    sourceLang,
    targetLang,
    mode,
    input.provider || 'deepseek',
    input.model,
    input.glossary,
    preExtractedBlocks,
    undefined,
    input.apiKey,
  );

  return {
    url: input.url,
    finalUrl: input.url,
    title: result.title,
    html: result.html,
    blocks: result.blocks,
    translatedBlocks: result.translatedBlocks,
    chunks: result.chunks,
    duration_ms: Date.now() - start,
  };
}
