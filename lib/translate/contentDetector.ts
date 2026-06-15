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
 * 评分阈值：Text Density 综合分（log 缩放 + 乘性调整），低于此分数回退到 body。
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

// =============================================================================
// Token 系统 (POSITIVE / NEGATIVE / META 分离)
// =============================================================================
//
// 旧版把 "text" / "content" / "body" / "blog" 当 POSITIVE token, 实际太宽泛:
//   - "text" 是 Tailwind utility (.text-gray-500)
//   - "content" 在 carousel / sidebar / ad container 都用
//   - "body" 在 footer / card body 出现
//   - "blog" 在 blog-sidebar / blog-meta 等非正文区也用
//
// 新版三层设计:
//   1) POSITIVE_TOKENS     单 token, 严格 CMS/语义词汇
//   2) POSITIVE_COMPOUND_RE 直接对原始 className 跑 regex, 命中 CMS 复合类
//                            (article-content / post-body / entry-content ...)
//   3) NEGATIVE_CONTAINER  容器级噪声 (nav / sidebar / footer / ad ...)
//      META                元数据 (author / timestamp / tag / category ...),
//                          不参与主 negative scoring, 走弱 penalty
//
// 为什么 metadata 不算 negative container:
//   author / timestamp / tag / category 在 Medium / Substack 文章 header
//   是合法 metadata 区域, 不应和 nav / footer 同等惩罚。改成 0.85x 弱 penalty。

/**
 * 已知"正文类"单 token 集合。严格收紧：只保留语义/结构上明确指示正文的词。
 */
const POSITIVE_TOKENS: ReadonlySet<string> = new Set([
  // 语义单 token
  'article',
  'post',
  'entry',
  'rich',
  'story',
  'main',
  // BEM 块名 (Ghost / WordPress / Webflow 等)
  'post-content-block',
  'post-content-wrapper',
  'article-container',
  'article-wrapper',
]);

/**
 * 已知"正文类"复合模式。在原始 className 上做 regex 匹配，
 * 解决 token 拆分后丢失"article-content"这种组合语义的问题。
 */
const POSITIVE_COMPOUND_RE: RegExp = /(?:^|[\s_-])(article|post|entry|blog|page|story|rich)[_-](content|body|text|inner|main)(?:[\s_-]|$)/i;

/**
 * 容器级 negative tokens。命中视为"整棵子树不是正文"，乘性 0.5x。
 */
const NEGATIVE_CONTAINER_TOKENS: ReadonlySet<string> = new Set([
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
  'mbox',             // BEM element: blog-content__mbox (Ghost callout box)
  'callout',
  'pullquote',
]);

/**
 * 元数据 tokens。author / timestamp / tag / category 是文章 metadata 区域,
 * 走 0.85x 弱 penalty (不被 negative 0.5x 重击, 但仍提示"非主体正文")。
 */
const META_TOKENS: ReadonlySet<string> = new Set([
  'metadata',
  'meta',
  'author',
  'byline',
  'timestamp',
  'tag',
  'tags',
  'category',
  'categories',
  'topics',
  'topic',
  'date',
  'time',
  'reading-time',
  'post-meta',
  'entry-meta',
  'article-meta',
]);

/** id 兜底：少数站点正文只标 id 没标 class（用子串扫描，id 一般唯一） */
const POSITIVE_ID_RE = /(?:article|content|post|entry|rich|blog|story|main|body)/i;
const NEGATIVE_CONTAINER_ID_RE = /(?:nav|menu|sidebar|footer|header|comment|widget|ad|banner|social|share|related|cookie|popup|modal|disqus|discourse)/i;
const META_ID_RE = /(?:author|byline|timestamp|tag|category|topic|date|meta)/i;

// =============================================================================
// 语义标签乘性加成 (替代旧版 semantic += 500 / 300 / 50 的加法体系)
// =============================================================================
//
// 旧版问题: 绝对加分在小 DOM 上把 article tag 拉爆, 与 density 乘性项
// 互不对齐, 导致 ranking 在不同 scale 下不稳定。
//
// 新版: 全部 multiplicative, ranking 单调。
//   - <article>    1.3x   (强语义信号)
//   - <main>       1.2x
//   - <section>    1.05x  (弱, section 经常被滥用)
//   - role=main    1.2x
//   - role=article 1.3x
const STRUCTURE_BOOST: Record<string, number> = {
  article: 1.3,
  main: 1.2,
  section: 1.05,
};

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

/**
 * 收集元素自身的正向/负向/元数据 class 信号。
 *
 * 设计原则（修复旧版问题）:
 *   1) **不传播 ancestor 信号**: 旧版 "祖先含 nav/header/footer/aside → 立即 return"
 *      会误杀 <article> inside <aside> 这类合法 SPA layout (article preview card
 *      in sidebar)。即使去掉 early return, 仍以 0.5x 乘性惩罚 ancestor negative,
 *      等价于 own negative, 同样会误杀 (post-content 被压到 0.6x, 输给 wrapper 节点)。
 *      新版只收集元素自身 class/id 信号, ancestor 仅作为 control-flow 决策 (early return
 *      已被取消, 所以不再有 ancestor 维度)。
 *   2) **semantic 字段移除**: 旧版 += 500 / 300 / 50 绝对加分破坏 multiplicative 体系;
 *      语义标签 boost 改在 scoreElement 里通过 STRUCTURE_BOOST 乘数处理。
 *   3) **META tokens 单独 flag**: author / timestamp / tag 走 0.85x 弱 penalty,
 *      不和 nav / footer 同等被 negative 0.5x 重击。
 */
function collectSignals(
  el: Element
): { positive: boolean; negative: boolean; meta: boolean } {
  let positive = false;
  let negative = false;
  let meta = false;

  // ---- 当前元素 class token 匹配 ----
  for (const token of tokenizeClass(el)) {
    if (POSITIVE_TOKENS.has(token)) positive = true;
    if (NEGATIVE_CONTAINER_TOKENS.has(token)) negative = true;
    if (META_TOKENS.has(token)) meta = true;
  }
  // 复合类名匹配: 在原始 className 上跑 regex, 命中 CMS 复合类
  if (el.className && typeof el.className === 'string' && POSITIVE_COMPOUND_RE.test(el.className)) {
    positive = true;
  }
  // ---- 当前元素 id 兜底 ----
  if (el.id) {
    if (POSITIVE_ID_RE.test(el.id)) positive = true;
    if (NEGATIVE_CONTAINER_ID_RE.test(el.id)) negative = true;
    if (META_ID_RE.test(el.id)) meta = true;
  }

  // 注意: 不再遍历 ancestor 链。
  // 旧设计的 ancestor 早退 / ancestor negative 都被取消, 因为:
  //   - SPA 布局: <article> in <aside> 常见且合法
  //   - 元素自身 class (article-content / post-content) 已经是强 signal
  //   - ancestor 维度会让 scoring 在 ancestor wrapper 与自身 article 之间互相干扰
  // 如果未来 ancestor 信号要重新引入, 必须用"软权重" (0.9x) 而非 own signal 的 0.5x。

  return { positive, negative, meta };
}

// =============================================================================
// 评分函数
// =============================================================================

/**
 * 核心评分函数（Text Density 算法，纯 multiplicative 模型）。
 *
 * 主指标（density）:
 *   density = (bodyTextLength / (linkCount + 1)) * log(textLength + 1)
 *
 * 公式直觉：
 *   - 主体文本多、链接少 → 高 density（典型正文）
 *   - 主体文本少、链接多 → 低 density（导航、链接列表、相关推荐）
 *   - log 缩放：长正文自然占优，避免短链接列表偶然获得高密度
 *
 * 调整项（全部 multiplicative, ranking 单调）:
 *   - 链接文本占比 > 50% → 0.5x（典型链接列表）
 *   - <article> 1.3x / <main> 1.2x / <section> 1.05x / role=article 1.3x
 *   - class POSITIVE → 1.2x；NEGATIVE → 0.5x
 *   - META (author/timestamp 等 metadata) → 0.85x 弱 penalty
 *
 * 旧版 (mixed additive) 问题:
 *   - semantic += 500/300/50 在小 DOM 上把 article tag 拉爆
 *   - ranking 在不同 scale 下不稳定, 阈值难以统一
 *
 * 典型得分参考（自然对数）:
 *   - 普通博客（2000 字符）              ≈ 15000 * structureBoost
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
  // linkTextLength 修复: 旧版用 a.textContent 会包含嵌套 DOM (icon font / aria-label /
  // 嵌入 <span> 等), 出现 double count 和 overshoot。改为只统计直接 text node,
  // 与"用户在浏览器看到的链接文字"语义一致。
  const aEls = el.querySelectorAll('a');
  const linkCount = aEls.length;
  let linkTextLength = 0;
  for (let i = 0; i < aEls.length; i++) {
    const a = aEls[i];
    const children = a.childNodes;
    for (let j = 0; j < children.length; j++) {
      const n = children[j];
      if (n.nodeType === 3 /* TEXT_NODE */) {
        linkTextLength += (n.textContent || '').length;
      }
    }
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

  // ---- 信号收集 (multiplicative 体系) ----
  const { positive, negative, meta } = collectSignals(el);

  // 1) 语义标签乘性加成 (替代旧版 semantic += 500)
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  let structureBoost = 1;
  if (tag === 'article' || role === 'article') structureBoost *= STRUCTURE_BOOST.article;
  else if (tag === 'main' || role === 'main') structureBoost *= STRUCTURE_BOOST.main;
  else if (tag === 'section') structureBoost *= STRUCTURE_BOOST.section;

  // 2) class 乘性调整
  let classMultiplier = 1;
  if (positive) classMultiplier *= 1.2;   // article-content / post-content 等
  if (negative) classMultiplier *= 0.5;   // nav / sidebar / footer / mbox 等
  if (meta) classMultiplier *= 0.85;      // author / timestamp / tag (弱)

  return score * structureBoost * classMultiplier;
}

// =============================================================================
// 候选收集
// =============================================================================

/**
 * 收集所有可能的正文候选容器。
 * 包括：语义标签、role 属性、class 名暗示（token 化 + 复合 regex）、table 布局中的大 td、父级。
 *
 * 设计取舍（subtree dedupe 暂不启用）:
 *   理论上同一棵 DOM 子树多个候选只评一次即可, 避免 CPU 浪费。
 *   但实测中: 兄弟级容器（wrapper > nav + article-body）会被错误合并, 导致
 *   本应胜出的 article-body 子节点被压到 wrapper 的得分。算法应该信任 score
 *   排序, 而不是提前合并:
 *     - 同节点用 `seen` Set 已去重
 *     - 不同节点即使 ancestor / descendant, 评分函数会基于 density + class
 *       信号自行区分（positive/negative 乘性 + structureBoost）
 *   候选数量通常 < 30, 多评几次的 CPU 开销可忽略。
 *   如未来要重做 dedupe, 需区分"严格 ancestor 关系"vs"兄弟级合并",
 *   避免误伤 article inside wrapper 的常见 CMS 布局。
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
  const semanticAll = doc.querySelectorAll('article, main');
  for (let i = 0; i < semanticAll.length; i++) add(semanticAll[i]);

  // 2) role 属性
  const roleAll = doc.querySelectorAll('[role="main"], [role="article"], [role="region"]');
  for (let i = 0; i < roleAll.length; i++) add(roleAll[i]);

  // 3) class 名暗示 (div / section / article / main)
  //    - 单 token 命中 POSITIVE_TOKENS (article / post / entry / rich / story / main)
  //    - 或 原始 className 命中 POSITIVE_COMPOUND_RE (article-content / post-body 等)
  //    - 或 id 命中 POSITIVE_ID_RE
  const classAll = doc.querySelectorAll('div, section, article, main');
  for (let i = 0; i < classAll.length; i++) {
    const el = classAll[i];
    const tokens = tokenizeClass(el);
    const hasToken = tokens.some((t) => POSITIVE_TOKENS.has(t));
    const hasCompound = el.className && typeof el.className === 'string' && POSITIVE_COMPOUND_RE.test(el.className);
    const idHit = el.id && POSITIVE_ID_RE.test(el.id);
    if (hasToken || hasCompound || idHit) {
      add(el);
    }
  }

  // 4) table 布局中的大 td（Paul Graham 等老式站点）
  const tdAll = doc.querySelectorAll('td');
  for (let i = 0; i < tdAll.length; i++) {
    const td = tdAll[i];
    const text = (td.textContent || '').trim();
    if (text.length > 1000) {
      add(td);
    }
  }

  // 5) 每个候选的父级（向上 2 层）
  //    把 ancestor 维度加入 scoring 空间, 让 density 自然区分:
  //    - 小 article 子节点 (高 density + positive signal) 会胜过其大 wrapper 祖先
  //    - 配合 collectSignals 提供的 positive/negative 信号综合排序
  const originals = candidates.slice();
  for (let i = 0; i < originals.length; i++) {
    let parent = originals[i].parentElement;
    for (let j = 0; j < 2 && parent && parent !== doc.body; j++) {
      add(parent);
      parent = parent.parentElement;
    }
  }

  // 6) 兜底：如果候选太少，把 body 的直接子 div 也加入
  if (candidates.length < 3) {
    const bodyChildren = doc.body.children;
    for (let i = 0; i < bodyChildren.length; i++) {
      const child = bodyChildren[i];
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
