/**
 * ReadabilityProvider: 基于 @mozilla/readability 的候选生成器。
 *
 * 不再作为 density provider 的 fallback，而是作为一等候选参与统一评分。
 * 这样可以避免 selector provider 选中 <main> 后，Readability 没有机会参与竞争。
 */

import type { CandidateProvider, ArticleCandidate } from '../types';
import { tryReadabilityRoot } from '../../contentDetector';

export const readabilityProvider: CandidateProvider = {
  name: 'readability',

  provide(doc): ArticleCandidate | null {
    const root = tryReadabilityRoot(doc);
    if (!root) return null;

    const textLen = (root.textContent || '').trim().length;
    if (textLen < 200) return null;

    console.log(
      `[ReadabilityProvider] Selected <${root.tagName}> .${(root.className || '').slice(0, 40)} (textLen: ${textLen})`,
    );

    return {
      provider: this.name,
      root,
      textLength: textLen,
      // confidence 由统一 scorer 重新计算；这里给出一个较高先验，
      // 使 Readability 在跨 provider 比较时更有竞争力。
      confidence: 0.85,
    };
  },
};
