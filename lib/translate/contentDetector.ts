/**
 * 智能正文识别：基于评分的容器选择算法。
 *
 * 当 ARTICLE_SELECTORS 选择器快速路径全部 miss 时，
 * 对所有候选容器评分，选最高分的作为文章根节点。
 *
 * 评分维度（绝对分制）：
 *   1. textLength    — 纯文本长度（封顶 50K，超长页不会爆分）
 *   2. paragraphCount — <p> 数量（强信号）
 *   3. headingCount  — h1-h3 数量
 *   4. linkRatio     — 链接文本占总文本比例（按比例惩罚）
 *   5. linkCount     — 链接数量（弱惩罚）
 *   6. listCount     — <li> 数量（导航/列表特征）
 *   7. form/aside    — 表单/嵌套导航噪声
 *   8. classHint     — token 化 class 名匹配（避免 BEM 子类误命中）
 *
 * 设计原则：
 *   - 不用归一化分（0-1），避免特征权重被压缩到无法区分
 *   - class 名匹配走 token 边界，区分 `blog-content`（正文）和
 *     `blog-content__mbox`（BEM 子类，CTA/话题块）
 *   - Tailwind 工具类（text-gray-500、bg-body）不会进入 POSITIVE 集合
 */

// =============================================================================
// 常量
// =============================================================================

/** 评分阈值：绝对分，低于此分数回退到 body */
export const SCORE_THRESHOLD = 500;

/** 最小文本长度：低于此长度直接判 0（避免短 nav 误判） */
const MIN_TEXT_LENGTH = 50;

/**
 * 已知"正文类"class token 集合（精确匹配整个 token，不做子串扫描）。
 *
 * 用 Set 而不是正则：解决 `blog-content__mbox` 包含 "content" 子串导致
 * 误命中的问题。BEM 子类（`__mbox`、`__topic-block`）和 Tailwind
 * 工具类（`text-gray-500`）作为独立 token 都不会进入该集合。
 */
const POSITIVE_CLASS_TOKENS: ReadonlySet<string> = new Set([
  // 通用单 token
  'article',
  'content',
  'post',
  'entry',
  'rich',
  'blog',
  'story',
  'body',
  'main',
  'text',
  // 复合 token（Ghost、WordPress、Medium、Substack 等常见 CMS）
  'article-body',
  'article-content',
  'article-text',
  'post-content',
  'post-body',
  'entry-content',
  'entry-body',
  'page-content',
  'main-content',
  'story-body',
  'story-content',
  'blog-content',       // Ghost 博客
  'blog-post',
  'blog-body',
  'rich-text',          // Webflow
  'rich-content',
]);

/**
 * 已知"非正文"class token 集合（精确匹配）。
 * 一旦命中直接大幅减分，无论正文特征多强都拉低。
 */
const NEGATIVE_CLASS_TOKENS: ReadonlySet<string> = new Set([
  'nav',
  'navigation',
  'navbar',
  'menu',
  'sidebar',
  'side-bar',
  'aside',
  'footer',
  'header',
  'comment',
  'comments',
  'disqus',
  'discourse',
  'widget',
  'ad',
  'ads',
  'advert',
  'banner',
  'social',
  'share',
  'sharing',
  'related',
  'recommended',
  'cookie',
  'popup',
  'modal',
  'newsletter',
  'subscribe',
  'cta',
  'promo',
  'breadcrumb',
  'pagination',
  'toolbar',
  'metadata',
  'meta',
  'author',
  'byline',
  'timestamp',
  'tag',
  'tags',
  'category',
  'topics',
  'topic',
]);

/** id 兜底：少数站点正文只标 id 没标 class（用子串扫描，id 一般唯一） */
const POSITIVE_ID_RE = /article|content|post|entry|rich|blog|story|main|body/i;
const NEGATIVE_ID_RE = /nav|menu|sidebar|footer|header|comment|widget|ad|banner|social|share|related|cookie|popup|modal|disqus|discourse/i;

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 把 className 拆成 token 数组。
 *
 * HTML 标准：class="a b c" 空格分隔。这里再按连字符/下划线切分，
 * 避免 `blog-content` 这个 token 包含 "content" 子串带来的歧义。
 *
 * 例：class="blog-content__mbox bg-purple-50"
 *   → ["blog", "content", "mbox", "bg", "purple", "50"]
 *   → 用 [blog, content, mbox, bg, purple, 50] 跟 POSITIVE/NEGATIVE 比对
 *   → content 命中 POSITIVE，mbox 命中 NEGATIVE，二者抵消
 */
function tokenizeClass(el: Element): string[] {
  if (!el.className || typeof el.className !== 'string') return [];
  return el.className
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter(Boolean);
}

/** 祖先负向 tag：含这几种祖先的子树基本不会是正文 */
const NEGATIVE_ANCESTOR_TAGS = new Set(['nav', 'header', 'footer', 'aside']);

/**
 * 收集元素及其祖先链上的正向/负向 token 命中。
 * 祖先有 NAV/MENU 时整支子树都打折（避免子元素被孤立打分）。
 */
function collectSignals(el: Element): { positive: boolean; negative: boolean; semantic: number } {
  let positive = false;
  let negative = false;
  let semantic = 0;

  // 当前元素
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');

  if (tag === 'nav' || tag === 'header' || tag === 'footer' || tag === 'aside') {
    // 元素本身就是 nav/header/footer/aside，直接判负
    return { positive, negative: true, semantic };
  }
  if (tag === 'article' || role === 'article') {
    semantic += 500;
  } else if (tag === 'main' || role === 'main') {
    semantic += 300;
  } else if (tag === 'section') {
    // section 经常被滥用，弱 boost
    semantic += 50;
  }

  for (const token of tokenizeClass(el)) {
    if (POSITIVE_CLASS_TOKENS.has(token)) positive = true;
    if (NEGATIVE_CLASS_TOKENS.has(token)) negative = true;
  }
  if (el.id) {
    if (POSITIVE_ID_RE.test(el.id)) positive = true;
    if (NEGATIVE_ID_RE.test(el.id)) negative = true;
  }

  // 祖先链（最多 3 层）
  let parent = el.parentElement;
  for (let i = 0; i < 3 && parent; i++) {
    const parentTag = parent.tagName.toLowerCase();
    if (NEGATIVE_ANCESTOR_TAGS.has(parentTag)) {
      // 祖先含 nav/header/footer/aside，整支子树降分
      return { positive, negative: true, semantic };
    }
    for (const token of tokenizeClass(parent)) {
      if (NEGATIVE_CLASS_TOKENS.has(token)) {
        negative = true;
        // 早退：找到一次强负向就够
        if (token === 'nav' || token === 'navigation' || token === 'header' || token === 'footer' || token === 'sidebar') {
          return { positive, negative: true, semantic };
        }
      }
    }
    if (parent.id && NEGATIVE_ID_RE.test(parent.id)) {
      negative = true;
    }
    parent = parent.parentElement;
  }

  return { positive, negative, semantic };
}

// =============================================================================
// 评分函数
// =============================================================================

/**
 * 核心评分函数（绝对分制）。
 *
 * 典型 article root 得分范围：
 *   - 普通博客（5000 字符 + 16 p + 8 h + 20 a）≈ 4000-8000
 *   - 长文（30000 字符 + 50 p + 20 h）≈ 15000-30000
 *   - 短文（1000 字符 + 4 p + 2 h）≈ 1500-3000
 *
 * 典型非正文得分：
 *   - 导航菜单（200-500 字符 + 10 a + 5 li）≈ 0-300
 *   - CTA 框（800 字符 + 2 a）≈ 600-900
 *   - 相关推荐（1500 字符 + 20 a + 链接密度 0.5）≈ -500 ~ 200
 */
export function scoreElement(el: Element): number {
  const text = (el.textContent || '').trim();
  if (text.length < MIN_TEXT_LENGTH) return 0;

  // ---- 基础特征 ----
  const textLen = Math.min(text.length, 50000);   // 封顶 50K
  const pCount = el.querySelectorAll('p').length;
  const hCount = el.querySelectorAll('h1, h2, h3').length;
  const aEls = Array.from(el.querySelectorAll('a'));
  const aCount = aEls.length;
  let aTextLen = 0;
  for (const a of aEls) {
    aTextLen += (a.textContent || '').length;
  }
  const linkRatio = aTextLen / Math.max(text.length, 1);
  const liCount = el.querySelectorAll('li').length;
  const formCount = el.querySelectorAll('form').length;
  const asideNavFooterHeaderCount = el.querySelectorAll('aside, nav, footer, header').length;

  // ---- class + semantic 提示（token 化）----
  const { positive, negative, semantic } = collectSignals(el);
  let classBoost = 0;
  if (positive) classBoost += 300;
  if (negative) classBoost -= 600;

  // ---- 综合评分 ----
  let score = 0;
  score += textLen;                                    // 长度主导
  score += pCount * 80;                                // <p> 强信号
  score += hCount * 25;                                // 标题
  score -= aCount * 2;                                 // 链接数量
  score -= Math.floor(linkRatio * 2000);               // 链接密度
  score -= liCount * 5;                                // 列表/导航
  score -= formCount * 50;                             // 表单
  score -= asideNavFooterHeaderCount * 30;             // 嵌套的导航/页脚
  score += classBoost;                                 // class 提示
  score += semantic;                                   // 语义标签 boost（<article>/<main>）

  return score;
}

// =============================================================================
// 候选收集
// =============================================================================

/**
 * 收集所有可能的正文候选容器。
 * 包括：语义标签、role 属性、class 名暗示（token 化）、table 布局中的大 td、父级。
 */
export function collectCandidates(doc: Document): Element[] {
  const seen = new Set<Element>();
  const candidates: Element[] = [];

  function add(el: Element | null) {
    if (!el || seen.has(el) || el === doc.body || el === doc.documentElement) return;
    seen.add(el);
    candidates.push(el);
  }

  // 1) 语义标签
  for (const tag of ['article', 'main']) {
    for (const el of doc.querySelectorAll(tag)) {
      add(el);
    }
  }

  // 2) role 属性
  for (const sel of ['[role="main"]', '[role="article"]', '[role="region"]']) {
    for (const el of doc.querySelectorAll(sel)) {
      add(el);
    }
  }

  // 3) class 名暗示（div / section / article / main）
  //    按 token 精确匹配，避免 BEM 子类（`blog-content__mbox`）误命中
  for (const el of doc.querySelectorAll('div, section, article, main')) {
    const tokens = tokenizeClass(el);
    const hasPositive = tokens.some((t) => POSITIVE_CLASS_TOKENS.has(t));
    const idHit = el.id && POSITIVE_ID_RE.test(el.id);
    if (hasPositive || idHit) {
      add(el);
    }
  }

  // 4) table 布局中的大 td（Paul Graham 等老式站点）
  for (const td of doc.querySelectorAll('td')) {
    const text = (td.textContent || '').trim();
    if (text.length > 1000) {
      add(td);
    }
  }

  // 5) 每个候选的父级（向上 2 层）
  const originals = [...candidates];
  for (const el of originals) {
    let parent = el.parentElement;
    for (let i = 0; i < 2 && parent && parent !== doc.body; i++) {
      add(parent);
      parent = parent.parentElement;
    }
  }

  // 6) 兜底：如果候选太少，把 body 的直接子 div 也加入
  if (candidates.length < 3) {
    for (const child of doc.body.children) {
      if (child.tagName === 'DIV' || child.tagName === 'SECTION') {
        add(child);
      }
    }
  }

  return candidates;
}

// =============================================================================
// 主入口
// =============================================================================

/**
 * 智能识别文章正文容器。
 *
 * @param doc Document
 * @returns 最佳候选元素，或 null（分数不够，建议回退 body）
 */
export function detectArticleRoot(doc: Document): Element | null {
  const candidates = collectCandidates(doc);
  if (candidates.length === 0) return null;

  let bestEl: Element | null = null;
  let bestScore = -1;

  for (const el of candidates) {
    const score = scoreElement(el);
    if (score > bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }

  if (bestScore < SCORE_THRESHOLD) {
    console.log(`[ContentDetector] Best score ${bestScore} < threshold ${SCORE_THRESHOLD}, fallback to body`);
    return null;
  }

  const firstClass = (bestEl!.className || '').split(/\s+/)[0] || '';
  console.log(`[ContentDetector] Best: <${bestEl!.tagName}> .${firstClass} (score: ${bestScore})`);
  return bestEl;
}
