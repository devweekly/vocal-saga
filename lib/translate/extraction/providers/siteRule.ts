/**
 * SiteRuleProvider: 站点特定规则候选生成器。
 *
 * 当通用算法无法定位正文根时，site rule 的 articleRootSelector 提供高优先级候选。
 * 注意：chatgpt0714.md 建议 site rule 不应硬覆盖所有算法，而是作为高权重候选
 * 参与统一评分。本 provider 只负责产生候选，最终决定交给 ArticleQualityScorer。
 */

import type { CandidateProvider, ArticleCandidate, CandidateProviderContext } from '../types';
import { matchSiteRule } from '../../rules';

export const siteRuleProvider: CandidateProvider = {
  name: 'site-rule',

  provide(doc, context): ArticleCandidate | null {
    const pageUrl = context?.pageUrl;
    if (!pageUrl) return null;

    const siteRule = matchSiteRule(pageUrl)?.siteRule;
    if (!siteRule?.articleRootSelector) return null;

    const el = doc.querySelector(siteRule.articleRootSelector);
    if (!el) {
      console.warn(
        `[SiteRuleProvider] articleRootSelector "${siteRule.articleRootSelector}" matched no element`,
      );
      return null;
    }

    const textLen = (el.textContent || '').trim().length;
    if (textLen === 0) {
      console.warn(
        `[SiteRuleProvider] articleRootSelector "${siteRule.articleRootSelector}" matched empty element`,
      );
      return null;
    }

    console.log(
      `[SiteRuleProvider] ${siteRule.articleRootSelector} → <${el.tagName}> .${(el.className || '').slice(0, 40)}`,
    );

    return {
      provider: this.name,
      root: el,
      textLength: textLen,
      confidence: 0.8, // 站点规则作为强先验，但具体分数仍由统一 scorer 重新计算
    };
  },
};
