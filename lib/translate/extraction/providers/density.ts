/**
 * DensityProvider: 基于文本密度的候选生成器。
 *
 * 复用 contentDetector.ts 中的 detectArticleRoot 核心逻辑，
 * 但关闭内部的 Readability fallback，使其作为独立候选参与统一评分。
 */

import type { CandidateProvider, ArticleCandidate, CandidateProviderContext } from '../types';
import { detectArticleRoot } from '../../contentDetector';
import type { ArticleContext } from '../../blockExtractor/types';

export const densityProvider: CandidateProvider = {
  name: 'density',

  provide(doc, context): ArticleCandidate | null {
    const articleContext: Partial<ArticleContext> = {};
    // 关闭 Readability fallback：Readability 作为独立 provider 参与评分。
    const root = detectArticleRoot(doc, articleContext, { useReadability: false });
    if (!root) return null;

    const textLen = (root.textContent || '').trim().length;

    // 把 density 阶段识别的噪声共享到全局 context，供后续 block extraction 复用。
    if (context && articleContext.noiseSet) {
      if (!context.noiseSet) context.noiseSet = new WeakSet();
      // WeakSet 没有遍历方法，这里无法直接合并两个 WeakSet。
      // 解决方式：density provider 在产生候选前已经收集噪声，
      // 而后续 block extraction 需要这个噪声集。由于 WeakSet 不可遍历，
      // 我们把 density 的 noiseSet 引用直接赋给 context（覆盖）。
      context.noiseSet = articleContext.noiseSet;
    }
    if (context && articleContext.textCache) {
      context.textCache = articleContext.textCache;
    }

    return {
      provider: this.name,
      root,
      textLength: textLen,
      confidence: articleContext.confidence ?? 0,
    };
  },
};
