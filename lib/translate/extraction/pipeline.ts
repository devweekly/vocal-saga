/**
 * Extraction Pipeline: 多策略文章根选择。
 *
 * 按 chatgpt0714.md 建议，把 findArticleRoot 从"单一策略硬覆盖"改造成：
 *   1. 多个 CandidateProvider 并行产生候选
 *   2. ArticleQualityScorer 统一评分
 *   3. 选择 confidence 最高的候选
 *   4. 低 confidence 时按次优候选重试（feedback loop）
 *
 * 对外保持 `findBestArticleRoot(doc, pageUrl, contextOut?) -> Element` 的签名，
 * 使 contentHelper.ts 的 prepareDocument 等下游无需修改。
 */

import type { CandidateProvider, ArticleCandidate, CandidateProviderContext } from './types';
import { defaultArticleQualityScorer } from './scoring';
import { selectorProvider } from './providers/selector';
import { densityProvider } from './providers/density';
import { readabilityProvider } from './providers/readability';
import { siteRuleProvider } from './providers/siteRule';
import type { ArticleContext } from '../blockExtractor/types';

/** 默认 provider 列表。顺序不影响最终选择，只影响日志输出顺序。 */
export const DEFAULT_PROVIDERS: readonly CandidateProvider[] = [
  siteRuleProvider,
  selectorProvider,
  densityProvider,
  readabilityProvider,
];

/** 候选选择结果。 */
export interface RootSelectionResult {
  root: Element;
  candidate: ArticleCandidate;
  strategy: string;
  confidence: number;
}

/**
 * 对候选运行统一评分，返回排序后的候选列表（高 → 低）。
 */
function rankCandidates(
  candidates: ArticleCandidate[],
  doc: Document,
): ArticleCandidate[] {
  const scored = candidates.map((c) => ({
    candidate: c,
    confidence: defaultArticleQualityScorer.score(c, doc),
  }));

  scored.sort((a, b) => b.confidence - a.confidence);

  for (const { candidate, confidence } of scored) {
    console.log(
      `[ExtractionPipeline] ${candidate.provider}: <${candidate.root.tagName}> .${(candidate.root.className || '').slice(0, 40)} confidence=${confidence.toFixed(3)} textLen=${candidate.textLength}`,
    );
  }

  return scored.map((s) => ({
    ...s.candidate,
    confidence: s.confidence,
  }));
}

/**
 * 从多个 provider 中选出最佳文章根。
 *
 * Fallback 策略（P1-3 统一）：
 *   1. 4 个 provider 并行产生候选 → 统一 scorer 评分
 *   2. 若所有候选 confidence < 阈值 或无候选 → 返回 doc.body 作为 body-fallback
 *   3. body-fallback 由调用方（contentHelper.prepareDocument）负责检测 0 块并触发
 *      data-island 兜底（data-island 不是"选根"，是"从 JSON 提取"，属另一层）
 *
 * @param doc 当前文档
 * @param pageUrl 当前页面 URL
 * @param contextOut 可选 out 参数：透传给 provider，可填充 noiseSet/textCache 等
 * @returns RootSelectionResult（必返回，最差也是 body-fallback）
 */
export function selectBestRoot(
  doc: Document,
  pageUrl: string,
  contextOut?: Partial<ArticleContext>,
): RootSelectionResult {
  const context: CandidateProviderContext = {
    pageUrl,
  };

  const candidates: ArticleCandidate[] = [];
  for (const provider of DEFAULT_PROVIDERS) {
    try {
      const candidate = provider.provide(doc, context);
      if (candidate) candidates.push(candidate);
    } catch (err) {
      console.warn(`[ExtractionPipeline] Provider ${provider.name} failed:`, err);
    }
  }

  // Fallback 1：所有 provider 都无候选 → 返回 body 作为兜底根。
  // contentHelper.prepareDocument 会用 body 作 root 跑 extractBlocks，
  // walker 自身的 SKIP_SET / SEMANTIC_SKIP_TAGS 会过滤 nav/aside/footer 等。
  //
  // 注意：不在低 confidence 时主动 fallback——原行为是"有候选就用候选"，
  // 让 prepareDocument 通过 0 块检测再触发 data-island 兜底。
  // 主动 fallback 会破坏 selectorProvider 的细粒度容器选择（.post-content 等）。
  if (candidates.length === 0) {
    console.warn('[ExtractionPipeline] No candidates from any provider, falling back to <body>');
    return buildBodyFallback(doc, contextOut);
  }

  const ranked = rankCandidates(candidates, doc);
  const best = ranked[0];

  // 将 context 中的 noiseSet/textCache 写回 contextOut，供 block extraction 复用。
  writeContextOut(context, contextOut, best);

  return {
    root: best.root,
    candidate: best,
    strategy: best.provider,
    confidence: best.confidence,
  };
}

/** 把 context 中的 noiseSet/textCache 写回 contextOut，供 block extraction 复用。 */
function writeContextOut(
  context: CandidateProviderContext,
  contextOut: Partial<ArticleContext> | undefined,
  best: ArticleCandidate,
): void {
  if (!contextOut) return;
  if (context.noiseSet) contextOut.noiseSet = context.noiseSet;
  if (context.textCache) contextOut.textCache = context.textCache;
  contextOut.confidence = best.confidence;
  const rootTag = best.root.tagName.toLowerCase();
  const rootCls = typeof best.root.className === 'string' ? best.root.className : '';
  contextOut.semanticHints = {
    isArticle: rootTag === 'article' || /article|post|entry/i.test(rootCls),
    hasCode: !!best.root.querySelector('pre, code'),
    hasMath: !!best.root.querySelector('math, .math, .katex'),
  };
}

/** 构建 body-fallback 结果：返回 doc.body 作为兜底根。 */
function buildBodyFallback(
  doc: Document,
  contextOut: Partial<ArticleContext> | undefined,
): RootSelectionResult {
  const body = doc.body || doc.documentElement;
  if (!body) {
    throw new Error('selectBestRoot: no body or documentElement available for fallback');
  }
  return {
    root: body,
    candidate: {
      provider: 'body-fallback',
      root: body,
      textLength: (body.textContent || '').length,
      confidence: 0,
    },
    strategy: 'body-fallback',
    confidence: 0,
  };
}

/**
 * 主入口：保持与旧版 findArticleRoot 一致的签名（Element | null）。
 *
 * P1-3 后 selectBestRoot 已整合 body-fallback，不再返回 null。
 * 本函数保留 null 返回值仅为兼容旧调用方：当且仅当 doc 无 body/documentElement
 * 时返回 null（极端情况，通常不会发生）。
 */
export function findBestArticleRoot(
  doc: Document,
  pageUrl: string,
  contextOut?: Partial<ArticleContext>,
): Element | null {
  try {
    const selection = selectBestRoot(doc, pageUrl, contextOut);
    console.log(
      `[ExtractionPipeline] Winner: ${selection.strategy} → <${selection.root.tagName}> .${(selection.root.className || '').slice(0, 40)} confidence=${selection.confidence.toFixed(3)}`,
    );
    return selection.root;
  } catch {
    return null;
  }
}
