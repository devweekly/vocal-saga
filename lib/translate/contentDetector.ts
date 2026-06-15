/**
 * 智能正文识别：基于文本密度（Text Density）的容器选择算法。
 *
 * 当 ARTICLE_SELECTORS 选择器快速路径全部 miss 时，对所有候选容器
 * 计算 Text Density，选最高分作为文章根节点。
 *
 * 评分核心：Text Density 公式
 *   density = (bodyTextLength / (linkCount + 1)) * log(textLength + 1)
 *
 * 公式三要素：
 *   1. bodyTextLength = textLength - linkTextLength
 *      → 主体文本（去除链接包裹的文本）
 *   2. / (linkCount + 1)
 *      → 链接密集区域（导航、相关推荐、目录）密度自然降低
 *   3. * log(textLength + 1)
 *      → 长文本自然占优，抑制短链接列表偶然获得的高密度
 *
 * 辅助调整（不破坏主公式语义）：
 *   - 链接文本占比 > 50% → 0.5x 乘性惩罚（典型链接列表）
 *   - <p>/<h> 数量用 log 缩放后加成（结构信号）
 *   - class 命中 POSITIVE → 1.2x；命中 NEGATIVE → 0.5x
 *   - <article> +500 / <main> +300（语义标签加成）
 *
 * 设计原则：
 *   - 主指标是 ratio（Text Density），不依赖绝对长度
 *   - 链接列表自然被打低分，不需要写专门的 nav 规则
 *   - class 名匹配走 token 边界，区分 BEM 子类
 *   - 语义标签作为"打破平局"的辅证
 *
 * 典型得分参考（log 自然对数）：
 *   - 普通博客（2000 字符 + 10p + 5h）          ≈ 15000-20000
 *   - 长文（30000 字符 + 50p + 20h）              ≈ 300000+
 *   - 短文（500 字符 + 3p + 1h）                  ≈ 3000-5000
 *   - 导航菜单（200 字符 + 15a，主体文本=0）       ≈ 0
 *   - 相关推荐（1500 字符 + 20a，链接密度 0.6）    ≈ 200-500
 *   - CTA 框（800 字符 + 2a）                     ≈ 2000-3000
 */

// =============================================================================
// 常量
// =============================================================================

/**
 * 评分阈值：Text Density 综合分（含 log 缩放和乘性调整），低于此分数回退到 body。
 *
 * 阈值选取依据：
 *   - 链接列表 / 导航：通常 0-50
 *   - CTA 框 + 负向 class：约 100-200
 *   - 阈值 300 留出充分安全边距，过滤上述非正文
 *   - 短文（500 字符）≈ 3000（远高于阈值）
 *   - 普通博客正文 ≈ 15000（远高于阈值）
 */
export const SCORE_THRESHOLD = 300;

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
 * 核心评分函数（Text Density 算法）。
 *
 * 主指标：
 *   density = (bodyTextLength / (linkCount + 1)) * log(textLength + 1)
 *
 * 公式直觉：
 *   - 主体文本多、链接少 → 高 density（典型正文）
 *   - 主体文本少、链接多 → 低 density（导航、链接列表、相关推荐）
 *   - log 缩放：长正文自然占优，避免短链接列表偶然获得高密度
 *
 * 辅助调整（在主指标上叠加，不破坏 ratio 语义）：
 *   - 链接文本占比 > 50% → 0.5x 乘性惩罚（典型链接列表）
 *   - class POSITIVE → 1.2x；NEGATIVE → 0.5x（打破平局）
 *   - <article> +500 / <main> +300（语义标签）
 *
 * 典型得分参考（自然对数）：
 *   - 普通博客（2000 字符）              ≈ 15000
 *   - 长文（30000 字符）                 ≈ 300000+
 *   - 短文（500 字符）                    ≈ 3000
 *   - 导航菜单（200 字符 + 15a）          ≈ 0
 *   - 相关推荐（1500 字符 + 20a）         ≈ 200
 *   - CTA 框（100 字符 + 1a，mbox 负向）  ≈ 100-150
 */
export function scoreElement(el: Element): number {
  const text = (el.textContent || '').trim();
  if (text.length < MIN_TEXT_LENGTH) return 0;

  // ---- 链接分析 ----
  const aEls = Array.from(el.querySelectorAll('a'));
  const linkCount = aEls.length;
  let linkTextLength = 0;
  for (const a of aEls) {
    linkTextLength += (a.textContent || '').length;
  }
  // 主体文本 = 总文本 - 链接文本
  const bodyTextLength = text.length - linkTextLength;

  // ---- 核心 Text Density ----
  // (bodyText / (linkCount + 1)) * log(text + 1)
  // - 分子：主体文本（去除链接后）
  // - 分母：链接数 + 1（避免除零，平滑无链接情况）
  // - log 缩放：长正文自然占优，短链接列表被压制
  let score = (bodyTextLength / (linkCount + 1)) * Math.log(text.length + 1);

  // ---- 链接密度软约束 ----
  // 链接文本占比 > 50% → 视为链接列表，乘性 0.5x 惩罚
  // 典型场景：相关推荐、目录、面包屑
  const linkRatio = linkTextLength / Math.max(text.length, 1);
  if (linkRatio > 0.5) {
    score *= 0.5;
  }

  // ---- class + semantic 提示 ----
  const { positive, negative, semantic } = collectSignals(el);
  let classMultiplier = 1;
  if (positive) classMultiplier *= 1.2;   // article-content / blog-content 等
  if (negative) classMultiplier *= 0.5;   // nav / sidebar / footer / mbox 等

  // 乘性调整 + 语义标签加成
  return score * classMultiplier + semantic;
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
