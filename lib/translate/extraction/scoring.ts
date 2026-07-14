/**
 * ArticleQualityScorer: 统一的文章根质量评分器。
 *
 * 对所有 CandidateProvider 返回的候选使用同一套指标评分，
 * 让 Readability/Selector/Density 的结果可以直接比较。
 *
 * 核心指标（来自 chatgpt0714.md 建议）:
 *   - textDensity: readableTextLength / totalTextLength
 *   - paragraphScore: <p> 数量
 *   - headingScore: <h1>-<h6> 数量
 *   - linkDensity: linkTextLength / textLength
 *   - boilerplatePenalty: 噪声元素占比
 *
 * 评分范围 0~1，供 findBestArticleRoot 跨 provider 选择最优候选。
 */

import type { ArticleCandidate, ArticleQualityScorer } from './types';
import { SKIP_CLASS_PATTERNS } from '../blockExtractor/constants';

/** 可接受的最小文本长度；低于此长度置信度直接为 0。 */
const MIN_TEXT_LENGTH = 100;

/**
 * 计算元素内部的可读文本长度：排除 script/style/nav/footer/aside
 * 以及命中 SKIP_CLASS_PATTERNS 的噪声子元素。
 */
function getReadableTextLength(el: Element, totalCache?: WeakMap<Element, number>): number {
  const cached = totalCache?.get(el);
  if (cached !== undefined) return cached;

  const childNodes = el.childNodes;
  let readableLen = 0;
  for (let i = 0; i < childNodes.length; i++) {
    const node = childNodes[i];
    if (node.nodeType === 3 /* TEXT_NODE */) {
      readableLen += (node.textContent || '').length;
    } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
      const child = node as Element;
      const tag = child.tagName.toLowerCase();
      if (
        tag === 'script' ||
        tag === 'style' ||
        tag === 'noscript' ||
        tag === 'nav' ||
        tag === 'footer' ||
        tag === 'aside' ||
        tag === 'iframe' ||
        tag === 'template'
      ) {
        continue;
      }
      if (shouldSkipByClass(child)) continue;
      readableLen += getReadableTextLength(child, totalCache);
    }
  }

  totalCache?.set(el, readableLen);
  return readableLen;
}

function shouldSkipByClass(el: Element): boolean {
  const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
  if (!cls) return false;
  const tokens = cls.split(/[\s\-_]+/).filter(Boolean);
  for (const token of tokens) {
    for (const pattern of SKIP_CLASS_PATTERNS) {
      const p = pattern.toLowerCase();
      if (
        token === p ||
        token.startsWith(p + '-') ||
        token.startsWith(p + '_') ||
        token.endsWith('-' + p) ||
        token.endsWith('_' + p)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** 缓存 el.textContent.length，避免重复触发 DOM subtree traversal。 */
function getTextLength(el: Element, cache: WeakMap<Element, number>): number {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;
  const len = (el.textContent || '').length;
  cache.set(el, len);
  return len;
}

/** 计算候选根的统一置信度 0~1。 */
function scoreCandidate(candidate: ArticleCandidate, doc: Document): number {
  const root = candidate.root;
  const textCache = new WeakMap<Element, number>();
  const totalText = getTextLength(root, textCache);
  if (totalText < MIN_TEXT_LENGTH) return 0;

  // 可读文本与总文本分别缓存，消除 O(N²) 重复遍历。
  const readableCache = new WeakMap<Element, number>();
  const readableText = getReadableTextLength(root, readableCache);
  const textDensity = totalText > 0 ? readableText / totalText : 1;

  // 链接密度
  let linkTextLen = 0;
  const links = root.querySelectorAll('a');
  for (const a of Array.from(links)) {
    linkTextLen += getTextLength(a, textCache);
  }
  const linkDensity = totalText > 0 ? linkTextLen / totalText : 0;

  // 结构信号
  const h1Count = root.querySelectorAll('h1').length;
  const h2Count = root.querySelectorAll('h2').length;
  const pCount = root.querySelectorAll('p').length;

  // 噪声信号：覆盖常见非正文区域
  const noiseEls = root.querySelectorAll(
    'nav, footer, aside, header, .menu, .sidebar, .related, .recommended, ' +
    '.newsletter, .subscribe, .cookie-banner, .ad, .ads, ' +
    '.bio, .bios-container, .author, .byline, .social-share, .share, ' +
    '.post-header, .post-meta, .entry-meta',
  );
  const noiseText = Array.from(noiseEls).reduce((sum, el) => sum + (el.textContent || '').length, 0);
  const boilerplateRatio = totalText > 0 ? noiseText / totalText : 0;

  // 检测候选根内部是否存在更具体的正文容器。
  // 如果 <article> 内部有 .post-content / .article-body 且后者包含主要文本，
  // 说明 <article> 过宽，应被惩罚。
  const specificBody = root.querySelector(
    '.article-body, .article-content, .post-content, .entry-content, .story-body, .story-content',
  );
  let hasSpecificBodyPenalty = 0;
  if (specificBody && specificBody !== root) {
    const specificText = (specificBody.textContent || '').trim().length;
    if (specificText > 0) {
      const coverage = totalText > 0 ? specificText / totalText : 0;
      if (coverage > 0.5 && coverage < 1) {
        hasSpecificBodyPenalty = Math.min(0.15, (1 - coverage) * 0.3);
      }
    }
  }

  // 基础分：可读文本长度（log 缩放）
  const textScore = Math.min(0.4, Math.log10(readableText / 100) / 5);

  // 结构分
  let structureScore = 0;
  if (h1Count === 1) structureScore += 0.15;
  else if (h1Count > 1) structureScore -= 0.05;
  if (h2Count >= 2) structureScore += 0.1;
  if (pCount >= 3) structureScore += 0.1;
  // 具体正文容器奖励：命中 .post-content / .article-body 等强信号
  const cls = typeof root.className === 'string' ? root.className.toLowerCase() : '';
  if (/(?:^|\s)(article-body|article-content|post-content|entry-content|story-body|story-content)(?:\s|$)/.test(cls)) {
    structureScore += 0.08;
  }
  structureScore = Math.max(0, Math.min(0.35, structureScore));

  // 纯度分：使用乘性惩罚，让高噪声容器显著降低置信度。
  let purityMultiplier = 1;
  if (textDensity > 0.7) purityMultiplier *= 1.08;
  else if (textDensity > 0.4) purityMultiplier *= 1.02;
  if (linkDensity < 0.3) purityMultiplier *= 1.04;
  if (boilerplateRatio < 0.2) purityMultiplier *= 1.04;
  // 关键：噪声比例高时显著降分（30% 噪声 → 约 0.64 倍）
  purityMultiplier *= Math.max(0.4, 1 - boilerplateRatio * 1.2);

  // provider 原始分作为微弱先验（不主导，只作 tie-breaker）
  const providerPrior = candidate.providerScore
    ? Math.min(0.05, candidate.providerScore / 10000)
    : 0;

  let rawScore = textScore + structureScore + providerPrior - hasSpecificBodyPenalty;
  let confidence = rawScore * purityMultiplier;
  confidence = Math.max(0, Math.min(1, confidence));

  // Readability provider 有强先验：它经过 Firefox Reader Mode 长期验证,
  // 在跨 provider 比较时给予小幅加成，使其更容易胜过粗粒度 <main>。
  if (candidate.provider === 'readability' && confidence > 0.3) {
    confidence = Math.min(1, confidence + 0.05);
  }

  return confidence;
}

/** 默认统一评分器实例。 */
export const defaultArticleQualityScorer: ArticleQualityScorer = {
  score(candidate, doc) {
    return scoreCandidate(candidate, doc);
  },
};
