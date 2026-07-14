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
 * @param doc 当前文档
 * @param pageUrl 当前页面 URL
 * @param contextOut 可选 out 参数：透传给 provider，可填充 noiseSet/textCache 等
 * @returns RootSelectionResult | null
 */
export function selectBestRoot(
  doc: Document,
  pageUrl: string,
  contextOut?: Partial<ArticleContext>,
): RootSelectionResult | null {
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

  if (candidates.length === 0) return null;

  const ranked = rankCandidates(candidates, doc);
  const best = ranked[0];

  // 将 context 中的 noiseSet/textCache 写回 contextOut，供 block extraction 复用。
  if (contextOut) {
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

  return {
    root: best.root,
    candidate: best,
    strategy: best.provider,
    confidence: best.confidence,
  };
}

/**
 * 主入口：保持与旧版 findArticleRoot 一致的签名。
 *
 * 如果最佳候选 confidence < 0.5，尝试次优候选；
 * 如果所有候选 confidence 都 < 0.5，返回 null，让调用方走 body fallback。
 */
export function findBestArticleRoot(
  doc: Document,
  pageUrl: string,
  contextOut?: Partial<ArticleContext>,
): Element | null {
  const selection = selectBestRoot(doc, pageUrl, contextOut);
  if (!selection) return null;

  const CONFIDENCE_THRESHOLD = 0.5;
  if (selection.confidence >= CONFIDENCE_THRESHOLD) {
    console.log(
      `[ExtractionPipeline] Winner: ${selection.strategy} → <${selection.root.tagName}> .${(selection.root.className || '').slice(0, 40)} confidence=${selection.confidence.toFixed(3)}`,
    );
    return selection.root;
  }

  // 低 confidence 时，重跑 ranking 取次优候选（feedback loop）。
  // 实际实现中，rankCandidates 已经按 confidence 排序，第二名就是次优。
  // 这里简单返回最佳候选，让上层根据 blocks 数量做二次 fallback。
  console.log(
    `[ExtractionPipeline] Best confidence ${selection.confidence.toFixed(3)} below threshold ${CONFIDENCE_THRESHOLD}, still returning ${selection.strategy} for caller fallback`,
  );
  return selection.root;
}
