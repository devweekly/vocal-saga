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
 *   - 有界并发翻译（KV cache 不跨请求）
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
import { translateSingleflight } from './singleflight.js';
import { DeepSeekTranslationService } from './service/deepseek';
import type { Glossary } from './service/_service';
import type { PromptStyle } from './service/shared';
import { fetchPage } from './urlFetcher';
import { runWithConcurrency } from './concurrency';
import { matchSiteRule } from './rules';
import { parseHTML } from 'linkedom';
import { inlineExternalStylesheets } from './cssInliner';

// =============================================================================
// 性能日志
// =============================================================================

function logCost(label: string, startMs: number): void {
  console.log(`[PERF] ${label} ${Math.round((performance.now() - startMs) * 1000)}µs`);
}

/**
 * 防御：data-fanyi-remove 是抽取/清理阶段的运行时标记，不应出现在对外输出的 HTML 中。
 * 尤其不能留在 <main> 的祖先（例如 Drupal 的 dialog-off-canvas-main-canvas）上——
 * 否则输出 HTML 自带的 [data-fanyi-remove]{display:none} CSS 会把整页容器隐藏，导致白屏。
 * 这里只剥离"正文根祖先"上的标记；真正的浮层/广告（与正文平级）仍保留隐藏，保持干净的译文视图。
 */
function stripRemoveMarkersFromAncestors(doc: Document): void {
  const main = doc.querySelector('main, article, [role="main"]');
  if (!main) return;
  const ancestors = new Set<Element>();
  let p: Element | null = main.parentElement;
  while (p) {
    ancestors.add(p);
    p = p.parentElement;
  }
  for (const el of Array.from(doc.querySelectorAll('[data-fanyi-remove="true"]'))) {
    if (ancestors.has(el)) {
      el.removeAttribute('data-fanyi-remove');
    }
  }
}

// =============================================================================
// 内部：chunk → translation
// =============================================================================

/**
 * 把站点规则里的 `documentTerms`（各站点手工维护的专有名词表）合并进 glossary。
 *
 * 合并而不是替换：调用方（/fanyi/page 等）可能已经传了自定义术语，站点词表
 * 只是补充。重复项无需处理 —— 进 prompt 前 `sanitizeDocumentTerms` 会去重。
 *
 * 为什么放在这里：只有 pipeline 同时拿得到 `finalUrl`（决定命中哪条站点规则）
 * 和 glossary，service 层两者都看不到。
 */
export function withSiteDocumentTerms(
  glossary: Glossary | undefined,
  finalUrl: string
): Glossary | undefined {
  const siteTerms = matchSiteRule(finalUrl)?.siteRule.documentTerms;
  if (!siteTerms || siteTerms.length === 0) return glossary;
  return {
    ...glossary,
    document_terms: [...(glossary?.document_terms ?? []), ...siteTerms],
  };
}

async function translateChunk(
  service: DeepSeekTranslationService,
  chunk: ReturnType<typeof buildChunks>[number],
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary,
  isRetry = false,
  /** LLM 提供方，纳入 cacheKey 避免 provider 切换后读到脏缓存 */
  provider?: string,
  /** 翻译文风，纳入 cacheKey 避免 style 切换后读到脏缓存 */
  promptStyle?: string,
  /** 跳过 chunk 缓存读取（强制刷新场景：/force/* 路由） */
  skipCache = false,
): Promise<Map<string, string>> {
  const tChunk = performance.now();
  const chunkLabel = `[Chunk ${chunk.id}]`;
  const cacheKey = generateTranslationCacheKey(chunk.jsonContent, sourceLang, targetLang, provider, promptStyle);

  // 1) 缓存
  const us = (ms: number) => `${Math.round(ms * 1000)}µs`;
  console.log(`${chunkLabel} start (${chunk.blocks.length} blocks, ${chunk.estimatedTokens} tokens)`);
  // skipCache=true 时跳过 chunk 缓存查询，直接调 LLM（强制刷新）
  if (!isRetry && !skipCache) {
    const cached = await getCachedTranslation(cacheKey);
    if (cached) {
      console.log(`${chunkLabel} cache hit`);
      return cached;
    }
  }

  // 2) 调 service（直接并行，不走队列）
  console.log(`${chunkLabel} api.call start`);
  const tApi = performance.now();

  // 故障隔离：单个 chunk 的 provider 调用或解析失败，不应拖垮整页翻译。
  // 返回空 Map → 所有 block 计为缺失 → 触发一次缺失重试；重试仍失败则
  // 这些 block 保持未翻译（页面原样渲染），而不是让 /fanyi/page 整体 500。
  let raw: string;
  try {
    raw = await translateSingleflight(cacheKey, () => service.translate(chunk.jsonContent, sourceLang, targetLang, glossary));
  } catch (err) {
    console.error(`${chunkLabel} provider call failed, treating all blocks as missing (retry will follow):`, (err as Error)?.message);
    return new Map<string, string>();
  }
  console.log(`${chunkLabel} api.call done (${us(performance.now() - tApi)})`);

  // 一次 parse 完成 result 提取 + unchanged 检测（原流程 parse 两次）
  // processTranslationWithCheck 自身已容错（解析彻底失败返回空 Map），
  // 这里再包一层防御，确保任何意外异常都能降级而非上抛。
  let result: Map<string, string>;
  try {
    result = processTranslationWithCheck(raw, chunk.blocks.map((b) => ({ id: b.id, text: b.text })));
  } catch (err) {
    console.error(`${chunkLabel} translation parse failed, treating all blocks as missing:`, (err as Error)?.message);
    result = new Map<string, string>();
  }

  // 3) 缓存（仅首次；skipCache 时仍写入以刷新旧缓存，只跳过读取）
  // 注意：空结果（provider/解析失败）绝不写入缓存，否则会污染 KV，
  // 后续缓存命中直接返回空 → 永远缺失且不再重试。
  if (!isRetry && result.size > 0) {
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
  concurrency = 6,
  /** LLM 提供方，透传给 translateChunk 纳入 cacheKey */
  provider?: string,
  /** 翻译文风，透传给 translateChunk 纳入 cacheKey */
  promptStyle?: string,
  /** 跳过 chunk 缓存读取（强制刷新场景） */
  skipCache = false,
): Promise<Map<string, string>> {
  const finalTranslations = new Map<string, string>();
  if (chunks.length === 0) return finalTranslations;

  const us = (ms: number) => `${Math.round(ms * 1000)}µs`;
  console.log(`[Pipeline] translateChunks: ${chunks.length} chunks, concurrency=${concurrency}`);
  const tAll = performance.now();

  async function processOneChunk(
    chunk: ReturnType<typeof buildChunks>[number]
  ): Promise<void> {
    const result = await translateChunk(service, chunk, sourceLang, targetLang, glossary, false, provider, promptStyle, skipCache);

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
        /* isRetry */ true,
        provider,
        promptStyle,
        skipCache,
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
    // 有界并发：始终只有 `concurrency` 个 chunk 在飞。
    // 早期这里是 chunks.map(...) + Promise.all（全并发），concurrency 只进日志、
    // 不生效，长文会瞬间打满上游触发 429。详见 lib/translate/concurrency.ts。
    await runWithConcurrency(chunks, concurrency, processOneChunk);
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
  /** 翻译文风，默认通用直译 */
  promptStyle?: PromptStyle;
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

  const service = new DeepSeekTranslationService(undefined, input.promptStyle);
  const translations = await translateChunksWithRetry(
    service,
    chunks,
    sourceLang,
    targetLang,
    input.glossary,
    6,
    /* provider */ 'deepseek',
    input.promptStyle,
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
  /** 翻译文风，默认通用直译 */
  promptStyle?: PromptStyle;
  /** 跳过 chunk 缓存读取（强制刷新场景：/force/* 路由） */
  skipCache?: boolean;
  /**
   * 覆盖默认的 SSRF 校验函数，透传给 fetchPage，**仅用于单元测试**。
   * 生产不传，使用默认的 assertPublicUrl。
   */
  ssrfGuard?: (url: string) => void;
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
  /** 翻译文风，默认通用直译 */
  promptStyle?: PromptStyle;
  /** 跳过 chunk 缓存读取（强制刷新场景：/force/* 路由） */
  skipCache?: boolean;
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
  style?: PromptStyle,
  /** 跳过 chunk 缓存读取（强制刷新场景） */
  skipCache = false,
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

  // 根据 provider 选择翻译服务实例，传入 style 切换文风
  let service: DeepSeekTranslationService;
  if (provider === 'openrouter') {
    const { OpenRouterTranslationService } = await import('./service/openrouter');
    service = new OpenRouterTranslationService(style) as any;
  } else if (provider === 'nvidia') {
    const { NvidiaTranslationService } = await import('./service/nvidia');
    service = new NvidiaTranslationService(model, style) as any;
  } else if (provider === 'cloudflare') {
    const { CloudflareAITranslationService } = await import('./service/cloudflare');
    service = new CloudflareAITranslationService(style) as any;
  } else if (provider === 'mimo') {
    const { MimoTranslationService } = await import('./service/mimo');
    service = new MimoTranslationService(style) as any;
  } else if (provider === 'gemini') {
    const { GeminiTranslationService } = await import('./service/gemini');
    service = new GeminiTranslationService(model, style) as any;
  } else if (provider === 'opencode') {
    const { OpencodeTranslationService } = await import('./service/opencode');
    service = new OpencodeTranslationService(style) as any;
  } else {
    service = new DeepSeekTranslationService(apiKey, style);
  }
  const tTrans = performance.now();
  // 并发度：opencode 限流严格（CF Worker 共享 IP 易触发 429）与 openrouter 的
  // 免费模型都串行；deepseek 放宽到 4；其余 provider 取 2。
  // 该值此前只是打印进日志、实际全并发（见 lib/translate/concurrency.ts）。
  const concurrency =
    provider === 'opencode' || provider === 'openrouter'
      ? 1
      : provider === 'deepseek'
        ? 4
        : 2;
  const translations = await translateChunksWithRetry(
    service,
    chunks,
    sourceLang,
    targetLang,
    withSiteDocumentTerms(glossary, finalUrl),
    concurrency,
    provider,
    style,
    skipCache,
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
  // 用 <base> 标签让浏览器原生解析相对 URL，避免手动遍历 DOM。
  // 注意：<base> 必须位于所有相对 URL 引用之前（如 <link rel="stylesheet">、<script src="/...">），
  // 否则浏览器会用当前页面地址解析这些资源。arxiv / ar5iv 等站点的原页面常把 <base>
  // 放在 <head> 末尾，翻译后会导致 CSS/JS 404，因此更新 href 后必须把它移到最前面。
  const head = doc.head;
  const existingBase = doc.querySelector('head > base');
  if (existingBase) {
    existingBase.setAttribute('href', baseUrl);
    if (head && head.firstChild !== existingBase) {
      head.insertBefore(existingBase, head.firstChild);
    }
  } else {
    const base = doc.createElement('base');
    base.setAttribute('href', baseUrl);
    if (head) head.insertBefore(base, head.firstChild);
  }

  // 注入双语显示 CSS —— 只针对我们注入的 span，不覆盖原页面任何已有元素的样式。
  if (head && !head.querySelector('#fanyi-bilingual-styles')) {
    const style = doc.createElement('style');
    style.id = 'fanyi-bilingual-styles';
    style.textContent = [
      '/* 双语对照样式 —— 仅作用于翻译注入的 span，不覆盖原页面 */',
      '.fanyi-original { /* 原样保留，不动 */ }',
      '.fanyi-translation {',
      '  display: block;',
      '  margin: 0.2em 0 0.4em 0;',
      // 说明：早期版本使用 `border-left: 3px solid currentColor` 作为视觉分隔，
      // 但 currentColor 在绝大多数页面解析为黑色，导致中文译文段前出现明显的竖黑条，
      // 视觉上像原文被"涂改"。移除该 border，保留 padding 维持缩进感。
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
      '',
      '/* 动态注入的通知/订阅弹窗兜底隐藏（InfoWorld 等站点的 subscribers notification prompt） */',
      '[class*="notification"], [id*="notification"],',
      '[class*="subscribers"], [id*="subscribers"],',
      '[class*="push-notification"], [id*="push-notification"] {',
      '  display: none !important;',
      '}',
    ].join('\n');
    head.appendChild(style);
  }

  // 防御：剥离正文根祖先上的 data-fanyi-remove（见 stripRemoveMarkersFromAncestors）。
  // 否则对外输出的 HTML 自带 [data-fanyi-remove]{display:none} CSS，会隐藏整页容器 → 白屏。
  stripRemoveMarkersFromAncestors(doc);

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

  const page = await fetchPage(input.url, {
    // 生产路径不传 ssrfGuard，走默认 assertPublicUrl
    ...(input.ssrfGuard ? { ssrfGuard: input.ssrfGuard } : {}),
  });

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
    undefined,
    undefined,
    undefined,
    input.promptStyle,
    input.skipCache ?? false,
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

  // 扩展传来的 HTML 里，样式表仍然是外链且多为内容哈希文件名（/assets/app-XXXX.css）。
  // 存进 D1 后原站一发版就 404，页面布局类全部失效。这里和 translateUrl 一样
  // 先内联再解析，让入库的 HTML 自包含。
  const selfContainedHtml = await inlineExternalStylesheets(input.html, { baseUrl: input.url });

  // 用 linkedom 解析扩展传来的 HTML
  const { document: doc } = parseHTML(selfContainedHtml) as unknown as { document: Document };

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
    input.promptStyle,
    input.skipCache ?? false,
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
