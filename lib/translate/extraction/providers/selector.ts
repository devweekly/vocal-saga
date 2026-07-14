/**
 * SelectorProvider: 基于 CSS 选择器快速定位文章根。
 *
 * 实现内容:
 *   - ARTICLE_SELECTORS 循环匹配
 *   - refineArticleRoot: 对 <article> wrapper 等场景下钻/扩展到合适容器
 *   - expandWrappers: 穿透纯包装层
 *   - chooseBestRoot: 对 candidate / parent / grandParent 评分选优
 *
 * 来自原 contentHelper.ts 的 Layer 1，按 chatgpt0714.md 建议拆分为独立 provider。
 */

import type { CandidateProvider, ArticleCandidate, CandidateProviderContext } from '../types';

// 优先级：先 class 后标签，先更具体的子容器再更通用的包裹元素。
// 像 bankingdive.com 把 <article> 用作整页 wrapper、正文放在
// .article-body 的站点，会直接定位到 .article-body。HBR 这种把整篇
// 装在 <article> 内的站点仍然走 <article>。
//
// 注意：选择器按 token 精确匹配（CSS 类选择器语义），所以 .blog-content
// 不会误命中 .blog-content__mbox / .blog-content__topic-block（BEM 子类
// 是独立 token）。Ghost 博客（commoncog.com 等）就靠这条。
const ARTICLE_SELECTORS = [
  '.article-body',
  '.article-content',
  '.article-text',
  '.story-body',
  '.story-content',
  '.u-rich-text-blog',        // Webflow blog rich text (claude.com)
  '.rich-text',               // Generic rich text wrapper
  '.post-content',            // Common blog CMS (Jane Street, Hugo, Jekyll)
  '.post__content',           // WordPress BEM (github.blog)
  '.entry-content',           // WordPress
  '.page-content',
  '.blog-content',            // Ghost 博客（commoncog.com）
  'article',
  '[role="article"]',
  '[role="main"]',
  'main',
  '.main-content',
  '.content-body',
];

/**
 * 对于 bankingdive.com 这类把 <article> 当作整页 wrapper 的站点，
 * 直接用 <article> 会把页眉（h1、导语、分享菜单、署名、图片说明）
 * 和正文混在一起进同一个 chunk：模型拿到一份头重脚轻的输入，往
 * 往正文翻译甚至直接截断。
 *
 * 策略：优先 .article-body 等具体容器，但当具体容器**外层是
 * <article> 且 <article> 里有不在该容器内的 h1/h2 标题**时，向上
 * 扩展到 <article>（TreeWalker 会一并遍历到 .first-page-pdf 里的 h1）。
 *
 * 校验：仅当 <article> 内**不在**该容器内、且有非空文本的 h1/h2
 * 才扩展。空标题（<h1></h1> 或全空格/装饰性 svg）不触发扩展，
 * 避免无谓把整页包装带回来。
 */
function hasValidHeadingOutside(
  container: Element,
  ancestor: Element
): Element | null {
  const headings = ancestor.querySelectorAll('h1, h2');
  for (const h of Array.from(headings)) {
    if (container.contains(h)) continue;
    const text = (h.textContent || '').trim();
    if (text.length < 4) continue;
    return h;
  }
  return null;
}

export function refineArticleRoot(candidate: Element): Element {
  const SPECIFIC_SELECTORS = [
    '.article-body',
    '.article-content',
    '.article-text',
    '.story-body',
    '.story-content',
    '.post-content',            // Jane Street, Hugo, Jekyll
    '.post__content',           // WordPress BEM (github.blog)
  ];

  if (SPECIFIC_SELECTORS.some((sel) => candidate.matches?.(sel))) {
    // candidate 已经是具体内容容器。如果它的祖先是 <article> 且
    // article 里有 h1/h2 标题不在 candidate 内，向上扩展到 <article>。
    const articleAncestor = candidate.closest('article');
    if (articleAncestor && articleAncestor !== candidate) {
      const heading = hasValidHeadingOutside(candidate, articleAncestor);
      if (heading) {
        console.log(
          '[SelectorProvider] Bumping root up to <article> to capture heading:',
          heading.textContent?.slice(0, 40)
        );
        return articleAncestor;
      }
    }
    return candidate;
  }

  for (const sel of SPECIFIC_SELECTORS) {
    const inner = candidate.querySelector(sel);
    if (inner && candidate.contains(inner)) {
      // candidate 是 <article> 时：如果它本身含有效 h1/h2 标题而
      // inner 不含（典型：标题在 .first-page-pdf，正文在 .article-body），
      // 保留 candidate（<article>）并依赖 SKIP_CLASS_PATTERNS 过滤
      // 噪声；否则下钻到 inner。
      if (candidate.tagName.toLowerCase() === 'article') {
        const heading = hasValidHeadingOutside(inner, candidate);
        if (heading) {
          console.log(
            '[SelectorProvider] Keeping outer <article> to preserve heading outside inner body:',
            heading.textContent?.slice(0, 40)
          );
          return candidate;
        }
      }
      console.log('[SelectorProvider] Refining article root to inner:', sel);
      return inner;
    }
  }
  return candidate;
}

/**
 * 穿透纯包装层：当 parent 的文本和 child 相同（parent 只是 wrapper）时向上穿。
 * 不负责"hero/content 是否同一篇文章"等业务判断 —— 那是 chooseBestRoot 的事。
 *
 * 保留 nav/footer/header 等 class 的守卫：这些不是 wrapper，遇到就停。
 * 命中具体正文容器（.post-content / .post__content / .article-body 等）时
 * 也不再向上展开，避免把 <main> 等 wrapper 当成 root。
 */
export function expandWrappers(el: Element): Element {
  const SPECIFIC_BODY_SELECTORS = [
    '.article-body',
    '.article-content',
    '.article-text',
    '.story-body',
    '.story-content',
    '.post-content',
    '.post__content',
  ];
  if (SPECIFIC_BODY_SELECTORS.some((sel) => el.matches?.(sel))) {
    return el;
  }

  let current: Element = el;
  const MAX_UP = 6;
  for (let i = 0; i < MAX_UP; i++) {
    const parent = current.parentElement;
    if (!parent) break;

    const tag = parent.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;

    const classes = `${parent.className || ''} ${parent.id || ''}`;
    if (/nav|menu|sidebar|footer|header|comment|widget/i.test(classes)) break;

    const parentLen = (parent.textContent || '').trim().length;
    const currentLen = (current.textContent || '').trim().length;

    // 纯包装层（文本相同），穿过它继续向上
    if (parentLen <= currentLen) {
      current = parent;
      continue;
    }
    break;
  }
  return current;
}

// =============================================================================
// ArticleRootScorer —— 基于启发式评分的根节点选择
// =============================================================================
//
// 把"hero 和正文是否同一篇文章""parent 是否比 candidate 更适合做根"等判断
// 从 ad-hoc 规则（expandIfFragmented 的兄弟文本检测）改为统一的评分函数。
// chooseBestRoot 对 candidate / parent / grandParent 三层评分，选最高分。
// 随着评分因子积累，绝大多数博客（Webflow / WordPress / Ghost / Medium /
// Hugo / Substack / OpenAI / Anthropic / Cloudflare）都能通过统一逻辑识别，
// 无需为每个站点写 site rule。

interface RootScore {
  score: number;
  reasons: string[];
}

const scoreCache = new WeakMap<Element, RootScore>();

/**
 * 对一个候选容器评分。评分不是黑盒：reasons 记录每个因子的贡献，
 * 日志一眼看出为什么选了/没选这个节点。
 */
export function scoreArticleContainer(container: Element): RootScore {
  const cached = scoreCache.get(container);
  if (cached) return cached;

  let score = 0;
  const reasons: string[] = [];

  // 1) h1：单 h1 是文章标志，多 h1 可能是列表页
  const h1Count = container.querySelectorAll('h1').length;
  if (h1Count === 1) {
    score += 20;
    reasons.push('+20 single h1');
  } else if (h1Count > 1) {
    score -= 10;
    reasons.push(`-10 multiple h1 (${h1Count})`);
  }

  // 2) h2 >= 2：说明有多个小节，像正文
  const h2Count = container.querySelectorAll('h2').length;
  if (h2Count >= 2) {
    score += 10;
    reasons.push(`+10 sections (h2=${h2Count})`);
  }

  // 3) 正文长度：800 字 +1，8000 字 +10，24000 字 +30（封顶）
  const textLength = (container.textContent ?? '').trim().length;
  const textScore = Math.min(30, textLength / 800);
  score += textScore;
  reasons.push(`+${textScore.toFixed(1)} text length (${textLength})`);

  // 4) 段落数：越多越像正文（封顶 20）
  const pCount = container.querySelectorAll('p').length;
  const pScore = Math.min(20, pCount);
  score += pScore;
  reasons.push(`+${pScore} paragraphs (${pCount})`);

  // 5) 图片：博客一般都有图（封顶 5）
  const figures = container.querySelectorAll('img, figure').length;
  const figScore = Math.min(5, figures);
  score += figScore;
  reasons.push(`+${figScore} images (${figures})`);

  // 6) 作者署名
  const author = container.querySelector(
    '[rel=author], .author, .byline, [class*=author]',
  );
  if (author) {
    score += 8;
    reasons.push('+8 author');
  }

  // 7) 发布时间
  const time = container.querySelector('time, [class*=date], [class*=publish]');
  if (time) {
    score += 6;
    reasons.push('+6 time');
  }

  // 8) 导航类元素扣分（nav/menu/sidebar/footer/header）
  const navCount = container.querySelectorAll(
    'nav, .menu, .sidebar, footer, header',
  ).length;
  if (navCount > 0) {
    const penalty = navCount * 8;
    score -= penalty;
    reasons.push(`-${penalty} nav elements (${navCount})`);
  }

  // 9) 按钮过多：CTA 页面特征
  const buttons = container.querySelectorAll('button, a.btn').length;
  if (buttons > 10) {
    score -= 15;
    reasons.push(`-15 too many buttons (${buttons})`);
  }

  // 10) 相关推荐区域扣分
  const related = container.querySelector('[class*=related], [class*=recommend]');
  if (related) {
    score -= 8;
    reasons.push('-8 related/recommend section');
  }

  // 11) 列表项过多：可能是导航/目录页
  const liCount = container.querySelectorAll('li').length;
  if (liCount > 80) {
    score -= 10;
    reasons.push(`-10 too many li (${liCount})`);
  }

  const result: RootScore = { score, reasons };
  scoreCache.set(container, result);
  return result;
}

/**
 * 判断元素是否含有"文章级" h1 标题（非导航/Logo 短文本）。
 *
 * 旧版直接用 querySelector('h1') 判断，但现代网站的 header/nav 里
 * 经常有 <h1>Home</h1> / <h1>Products</h1> 等短文本 h1，不是文章标题。
 * 这会导致 chooseBestRoot 在 nav 层就停止向上扫描，错过真正的文章根。
 *
 * 改进：h1 文本长度 5~200 字符才视为文章标题，排除 "Home" / "Sign in" 等短文本。
 */
export function hasArticleLikeHeading(el: Element): boolean {
  const h1 = el.querySelector('h1');
  if (!h1) return false;
  const text = (h1.textContent || '').trim();
  return text.length >= 5 && text.length < 200;
}

/**
 * 对 candidate / parent / grandParent 三层评分，选最高分。
 * 把"hero 和正文分属兄弟 section"这类判断从规则改为评分：
 * 如果 parent（包含 hero + 正文）的分数比 candidate（只含正文）高，就选 parent。
 *
 * 守卫：candidate 已有文章级 h1 时直接返回。h1 是文章主标题，candidate 有 h1
 * 说明它就是文章根（如 .post-content 自己带 h1），不需要向上找。
 * 只有 candidate 缺文章级 h1（如 claude.com 的 h1 在 hero section）时才向上评分。
 */
export function chooseBestRoot(candidate: Element): Element {
  // h1 守卫：candidate 已有文章级 h1（文章主标题），直接返回。
  if (hasArticleLikeHeading(candidate)) {
    return candidate;
  }

  // candidate 缺文章级 h1 时（如 claude.com 的 h1 在 hero section，正文 section 缺 h1），
  // 向上扫描直到遇到含文章级 h1 的祖先或 body/html，收集所有候选后评分选最高分。
  const list: Element[] = [];
  let p: Element | null = candidate;
  while (p) {
    const tag = p.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    list.push(p);
    // 遇到含文章级 h1 的祖先就停止向上 —— h1 是文章主标题的标志，
    // 更上层的容器（如 page_wrap 含整个页面）只会引入噪声。
    if (hasArticleLikeHeading(p)) break;
    p = p.parentElement;
  }

  let best = list[0];
  let bestScore = -Infinity;
  for (const node of list) {
    const result = scoreArticleContainer(node);
    console.log(
      `[SelectorProvider] Candidate <${node.tagName}> .${(node.className || '').slice(0, 40)} score=${result.score.toFixed(1)}`,
      result.reasons,
    );
    if (result.score > bestScore) {
      best = node;
      bestScore = result.score;
    }
  }
  return best;
}

function hasMeaningfulContent(el: Element): boolean {
  return (el.textContent || '').trim().length > 0;
}

/**
 * 通过选择器路径寻找文章根。
 * 供 selectorProvider 内部使用，也兼容旧调用方。
 */
export function findRootBySelectors(doc: Document): Element | null {
  for (const selector of ARTICLE_SELECTORS) {
    const els = Array.from(doc.querySelectorAll(selector));
    let bestInSelector: Element | null = null;
    let bestLen = 0;
    for (const el of els) {
      const len = (el.textContent || '').trim().length;
      if (len > 0 && len > bestLen) {
        bestLen = len;
        bestInSelector = el;
      }
    }
    if (bestInSelector) {
      const refined = refineArticleRoot(bestInSelector);
      const expanded = expandWrappers(refined);
      const best = chooseBestRoot(expanded);
      return best;
    }
  }
  return null;
}

export const selectorProvider: CandidateProvider = {
  name: 'selector',

  provide(doc): ArticleCandidate | null {
    const root = findRootBySelectors(doc);
    if (!root) return null;

    const textLen = (root.textContent || '').trim().length;
    const score = scoreArticleContainer(root).score;

    console.log(
      `[SelectorProvider] Selected <${root.tagName}> .${(root.className || '').slice(0, 40)} (score: ${score.toFixed(1)})`,
    );

    return {
      provider: this.name,
      root,
      textLength: textLen,
      providerScore: score,
      confidence: 0, // 由统一 scorer 重新计算
    };
  },
};
