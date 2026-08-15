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

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { SKIP_CLASS_PATTERNS } from './blockExtractor/constants';
import type { ArticleContext } from './blockExtractor/types';
import {
  mapReadabilityToRoot,
  type ReadabilityMappingResult,
} from './readabilityRootMapper';

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
// Consent / Cookie / 广告 SDK 容器绝对排除
// =============================================================================
//
// OneTrust / Cookiebot / TrustArc / Quantcast Choice 等隐私同意 SDK 容器
// 文本密度天然高（GDPR 法律文本又长又没链接），评分会超过真文章。
// 但它们绝不该被当作 article root —— 走 extractBlocks 后整棵子树会被 overlay /
// cookie 规则剪枝, 返回 0 块, 最终用户看到 "No translatable content found"。
// (回归 case: databricks.com 博客, OneTrust #ot-pc-content 抢走了 root。)
//
// 命中任一 token 的元素 (含其祖先) 直接从候选里剔除, 不参与评分。

const CONSENT_SDK_ID_RE =
  /(?:onetrust|cookiebot|trustarc|quantcast|consent|gdpr|cookielaw|cookie-law|cookie|privacy)/i;
const CONSENT_SDK_CLASS_RE =
  /(?:onetrust|\bot-sdk|ot-pc|ot-cookie|cookiebot|trustarc|quantcast|qc-cmp|cookie-banner|consent-banner|gdpr-banner|privacy-banner|\bcookie[s]?\b)/i;

/**
 * 噪声类元素文本长度安全阀：超过此长度的元素不视为 consent SDK 容器。
 *
 * webclaw 借鉴：cookie/consent/gdpr 类容器若 textContent > 5000 字符，
 * 很可能是长 FAQ / 长隐私政策正文，不应被绝对排除。
 *
 * 回归 case: #cookiesModal (Bootstrap modal 含 cookie policy tabs) 有 ~50k
 * 字符文本，因 id 含 "cookie" 被排除为 consent SDK，但它实际是页面正文，
 * 排除后 detectArticleRoot 选不到 root，用户看到 "No translatable content"。
 */
const CONSENT_SAFE_VALVE = 5000;

/**
 * 检查元素是否因文本过长而豁免 consent SDK 判定。
 * 不再使用全局 WeakSet 缓存——SPA 路由切换后同一 DOM 元素内容可能变化,
 * 全局缓存会导致旧判断残留。改为每次 detectArticleRoot 调用时传参缓存。
 */
function isConsentSafeValve(
  el: Element,
  memo?: WeakMap<Element, boolean>,
): boolean {
  if (memo) {
    const cached = memo.get(el);
    if (cached !== undefined) return cached;
  }
  const text = el.textContent || '';
  const result = text.length > CONSENT_SAFE_VALVE;
  if (memo) memo.set(el, result);
  return result;
}

/**
 * 元素 (或其任意祖先) 是否是隐私同意 / Cookie / 广告 SDK 容器。
 * 用于在 detectArticleRoot 里绝对排除这类高密度但非正文的容器。
 *
 * 安全阀：若元素 textContent > 5000 字符，即使命中 consent SDK 模式也不排除，
 * 防止误杀长隐私政策 / 长 FAQ 等正文内容。
 */
function isConsentSdkContainer(
  el: Element,
  memo?: WeakMap<Element, boolean>,
): boolean {
  let current: Element | null = el;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') return false;

    const id = current.id || '';
    if (id && CONSENT_SDK_ID_RE.test(id)) {
      // 安全阀：文本过长的元素不视为 consent SDK 容器
      if (isConsentSafeValve(el, memo)) return false;
      return true;
    }

    const cls = typeof current.className === 'string' ? current.className : '';
    if (cls && CONSENT_SDK_CLASS_RE.test(cls)) {
      // 安全阀：文本过长的元素不视为 consent SDK 容器
      if (isConsentSafeValve(el, memo)) return false;
      return true;
    }

    current = current.parentElement;
  }
  return false;
}

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
  section: 1.02,
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
// TextContent 缓存（消除 O(N²) 重复 subtree traversal）
// =============================================================================

/**
 * 缓存 el.textContent 长度, 避免同一元素在 scoreElement + sibling normalization
 * + global ratio 等多处重复触发 DOM subtree traversal。
 *
 * 生命周期: 一次 detectArticleRoot 调用, 随调用结束 GC。
 */
type TextLenCache = WeakMap<Element, number>;

function getTextLength(el: Element, cache?: TextLenCache): number {
  if (cache) {
    const cached = cache.get(el);
    if (cached !== undefined) return cached;
  }
  const len = (el.textContent || '').length;
  if (cache) cache.set(el, len);
  return len;
}

/**
 * 计算 "可读文本" 长度: 排除噪声子元素 (cookie banner, nav, ad 等) 后的文本长度。
 *
 * 问题: raw textContent 包含所有后代文本, 包括嵌套的 cookie 弹窗 / 广告 /
 * 导航等噪声内容。scoreElement 用 raw textLength 会把噪声也算进正文,
 * 导致 <article> 内嵌 <div class="cookie-policy"> 50k chars 的场景误判为高分。
 *
 * 方案: 遍历直接子元素, 对命中 SKIP_CLASS_PATTERNS 或 SEMANTIC_SKIP_TAGS
 * 的子树跳过, 只累计 "可读" 子树的文本长度。
 *
 * 性能: 只遍历直接子元素 (不递归), 每个子元素用 textLengthCache 查长度。
 */
function getReadableTextLength(
  el: Element,
  textCache?: TextLenCache,
  noiseSet?: Set<Element>,
): number {
  // 快速路径: 无子元素时直接返回自身文本长度
  const childCount = el.children?.length || 0;
  if (childCount === 0) {
    return getTextLength(el, textCache);
  }

  // 遍历子节点, 保留 Text Node 内容 + 非噪声子元素内容
  let readableLen = 0;
  const childNodes = el.childNodes;
  for (let i = 0; i < childNodes.length; i++) {
    const node = childNodes[i];
    if (node.nodeType === 3 /* TEXT_NODE */) {
      readableLen += (node.textContent || '').length;
    } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
      const child = node as Element;
      // 跳过噪声子元素
      if (noiseSet && noiseSet.has(child)) continue;
      // 内联检查: 跳过 script/style/nav/footer/aside 等
      const tag = child.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' ||
          tag === 'nav' || tag === 'footer' || tag === 'aside' ||
          tag === 'iframe' || tag === 'template') {
        continue;
      }
      // 跳过 class 命中 SKIP_CLASS_PATTERNS 的子元素
      if (shouldSkipByClassName(child)) continue;
      readableLen += getTextLength(child, textCache);
    }
  }
  return readableLen;
}

/**
 * 快速检查 class 是否命中 SKIP_CLASS_PATTERNS (从 contentDetector 本地判断,
 * 不依赖 blockExtractor 的 shouldSkipByClass, 避免循环依赖)。
 */
const SKIP_CLASS_SET = new Set(SKIP_CLASS_PATTERNS.map((p) => p.toLowerCase()));

function shouldSkipByClassName(el: Element): boolean {
  const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
  if (!cls) return false;
  for (const pattern of SKIP_CLASS_SET) {
    if (cls === pattern || cls.startsWith(pattern + '-') || cls.startsWith(pattern + '_') ||
        cls.endsWith('-' + pattern) || cls.endsWith('_' + pattern) ||
        cls.includes(' ' + pattern + ' ') || cls.includes(pattern + '-') || cls.includes(pattern + '_')) {
      return true;
    }
  }
  return false;
}

// =============================================================================
// 评分函数
// =============================================================================

/**
 * 核心评分函数（Text Density 算法，纯 multiplicative 模型）。
 *
 * 主指标（density）:
 *   density = (bodyTextLength / (linkCount + 1)) * log(readableTextLength + 1)
 *
 * 改进 (P0):
 *   - 使用 readableTextLength 替代 raw textContent.length, 排除噪声子元素
 *   - 新增 textDensity = readableTextLength / totalTextLength 评分信号
 *   - textLengthCache 缓存避免重复 subtree traversal
 *
 * 公式直觉：
 *   - 主体文本多、链接少 → 高 density（典型正文）
 *   - 主体文本少、链接多 → 低 density（导航、链接列表、相关推荐）
 *   - log 缩放：长正文自然占优，避免短链接列表偶然获得高密度
 *   - textDensity: 可读文本 / 总文本 → 排除内嵌噪声后的纯度
 *
 * 调整项（全部 multiplicative, ranking 单调）:
 *   - textDensity * 30 加成 (纯度越高正文可能性越大)
 *   - 链接文本占比 > 50% → 0.5x（典型链接列表）
 *   - <article> 1.3x / <main> 1.2x / <section> 1.05x / role=article 1.3x
 *   - class POSITIVE → 1.2x；NEGATIVE → 0.5x
 *   - META (author/timestamp 等 metadata) → 0.92x 弱 penalty
 */
export function scoreElement(
  el: Element,
  textCache?: TextLenCache,
): number {
  // 使用缓存获取文本长度, 避免 O(N²) 重复 subtree traversal
  const totalTextLength = getTextLength(el, textCache);
  if (totalTextLength < MIN_TEXT_LENGTH) return 0;

  // 计算 "可读文本" 长度 (排除噪声子元素)
  const readableTextLength = getReadableTextLength(el, textCache);

  const text = (el.textContent || '').trim();
  if (text.length < MIN_TEXT_LENGTH) return 0;

  // ---- 链接分析 ----
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
  const bodyTextLength = readableTextLength - linkTextLength;

  // ---- 核心 Text Density ----
  // (bodyText / (linkCount + 1)) * log(readableText + 1)
  let score = (bodyTextLength / (linkCount + 1)) * Math.log(readableTextLength + 1);

  // ---- 新增: Text Density 纯度信号 ----
  // density = readableTextLength / totalTextLength
  // 正文容器通常 > 0.8; 导航/链接列表 < 0.3
  const textDensity = totalTextLength > 0
    ? readableTextLength / totalTextLength
    : 1;
  // 纯度 > 0.7 → 1.1x 加成; < 0.4 → 0.7x 惩罚
  let densityBoost = 1;
  if (textDensity > 0.7) densityBoost *= 1.1;
  else if (textDensity < 0.4) densityBoost *= 0.7;

  // ---- 信号收集 (multiplicative 体系) ----
  const { positive, negative, meta } = collectSignals(el);

  // 1) 语义标签乘性加成
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  let structureBoost = 1;
  if (tag === 'article' || role === 'article') structureBoost *= STRUCTURE_BOOST.article;
  else if (tag === 'main' || role === 'main') structureBoost *= STRUCTURE_BOOST.main;
  else if (tag === 'section') structureBoost *= STRUCTURE_BOOST.section;

  // 2) class 乘性调整
  let classMultiplier = 1;
  if (positive) classMultiplier *= 1.2;
  if (negative) classMultiplier *= 0.5;
  if (meta) classMultiplier *= 0.92;

  // FIX 1: smooth link penalty
  const linkRatio = linkTextLength / Math.max(readableTextLength, 1);
  score *= 1 / (1 + linkRatio * 2);

  // FIX 2: container penalty
  const childCount = el.children?.length || 0;
  const densityPerChild = readableTextLength / Math.max(childCount, 1);
  let containerPenalty = 1;
  if (childCount > 20 && densityPerChild < 25) {
    containerPenalty *= 0.85;
  }

  // FIX 3: sibling normalization (用缓存避免重复 textContent)
  let siblingBoost = 1;
  const parent = el.parentElement;
  if (parent) {
    const siblings = parent.children;
    let maxSiblingText = 0;
    let total = 0;
    for (let i = 0; i < siblings.length; i++) {
      const len = getTextLength(siblings[i], textCache);
      total += len;
      if (len > maxSiblingText) maxSiblingText = len;
    }
    const myLen = readableTextLength;
    if (maxSiblingText > 0 && myLen < maxSiblingText * 0.7) {
      siblingBoost *= 0.85;
    }
    if (siblings.length > 3) {
      const avg = total / siblings.length;
      if (Math.abs(myLen - avg) / avg < 0.25) {
        siblingBoost *= 0.9;
      }
    }
  }

  // FIX 4: depth normalization
  let depthBoost = 1;
  let depth = 0;
  let p: Element | null = el.parentElement;
  while (p) {
    depth++;
    p = p.parentElement;
  }
  if (depth < 3) depthBoost = 0.95;
  if (depth > 7) depthBoost *= 0.9;

  // global ratio boost: 用 readableTextLength 而非 raw textContent
  let globalRatioBoost = 1;
  const ownerDoc = el.ownerDocument;
  const bodyEl = ownerDoc?.body;
  if (bodyEl && bodyEl !== el) {
    const bodyTextLen = getTextLength(bodyEl, textCache);
    if (bodyTextLen > 0) {
      const ratio = readableTextLength / bodyTextLen;
      if (ratio >= 0.4) {
        globalRatioBoost = 1.3;
      } else if (ratio >= 0.25) {
        globalRatioBoost = 1.15;
      } else if (ratio < 0.05) {
        globalRatioBoost = Math.max(0.1, ratio / 0.05);
      }
    }
  }

  return (
    score *
    densityBoost *
    structureBoost *
    classMultiplier *
    containerPenalty *
    siblingBoost *
    depthBoost *
    globalRatioBoost
  );
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
export function collectCandidates(
  doc: Document,
  consentMemo?: WeakMap<Element, boolean>,
  noiseSet?: WeakSet<Element>,
): Element[] {
  const seen = new Set<Element>();
  const candidates: Element[] = [];

  function add(el: Element | null) {
    if (!el || seen.has(el) || el === doc.body || el === doc.documentElement) return;
    // 绝对排除: 隐私同意 / Cookie / 广告 SDK 容器 (含祖先命中)。
    if (isConsentSdkContainer(el, consentMemo)) {
      // 共享给 block extraction: 标记为已知噪声, O(1) 跳过避免重复判定
      if (noiseSet) noiseSet.add(el);
      return;
    }
    seen.add(el);
    candidates.push(el);
  }

  // 1) 语义标签
  const semanticAll = doc.querySelectorAll('article, main');
  for (let i = 0; i < semanticAll.length; i++) add(semanticAll[i]);

  // 2) role 属性
  const roleAll = doc.querySelectorAll('[role="main"], [role="article"]');
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
// Readability fallback
// =============================================================================

/**
 * 当评分算法无法给出可靠根节点时，使用 @mozilla/readability 提取正文，
 * 并在原始 DOM 中定位对应的容器作为 fallback 根节点。
 *
 * 适用场景：页面没有 article/main 语义标签，且内容被切成多个高密度小碎片
 * （如 developers.googleblog.com 的 .inner-block-content.rich-content），
 * 评分算法容易选错。Readability 的启发式规则能更稳定地找到主文章区域。
 */
/**
 * 检测 best 是否只是“多个同级 section 构成文章”中的一个小节。
 *
 * 很多学术/技术站点把文章切成多个 <section> 或 <div> 同级块，
 * contentDetector 的评分会选中其中一个密度最高的小节，导致只翻译局部。
 * 当 best 的父容器包含 ≥3 个长度相当的文本块，且 best 仅占父容器一小部分时，
 * 认为页面是碎片化的，应启用 Readability fallback。
 */
function isFragmentedArticleRoot(best: Element, doc: Document): boolean {
  const parent = best.parentElement;
  if (!parent || parent === doc.body || parent === doc.documentElement) return false;

  const bestTag = best.tagName.toLowerCase();
  if (bestTag !== 'section' && bestTag !== 'div') return false;

  const siblings = Array.from(parent.children).filter((c) => {
    const tag = c.tagName.toLowerCase();
    return (tag === 'section' || tag === 'div') && (c.textContent || '').trim().length > 100;
  });

  if (siblings.length < 3) return false;

  const bestLen = (best.textContent || '').length;
  const totalLen = siblings.reduce((sum, c) => sum + (c.textContent || '').length, 0);
  if (totalLen === 0) return false;

  // best 占同类型兄弟总文本比例 < 30%，说明它只是多节文章的一部分
  return bestLen / totalLen < 0.3;
}

export function tryReadabilityRoot(doc: Document): ReadabilityMappingResult | null {
  try {
    // Readability 会修改传入的文档树，因此必须在克隆的文档上运行。
    // linkedom 没有 document.implementation.createHTMLDocument，故通过 outerHTML 重新解析。
    const cloneDoc = parseHTML(doc.documentElement.outerHTML).document;

    const reader = new Readability(cloneDoc);
    const article = reader.parse();
    if (!article || !article.textContent || article.textContent.trim().length < 200) {
      return null;
    }

    // 多锚点 + LCA 映射（共享算法，见 readabilityRootMapper.ts）。
    // 替代旧版「单签名 + Jaccard + 祖先爬升 80%」：跨首/中/尾多段定位、
    // 取最低公共祖先、以内容覆盖率（语义）衡量可信度，降低噪声区 collision 风险。
    const result = mapReadabilityToRoot(doc, article, {
      isConsent: (el) => isConsentSdkContainer(el, new WeakMap()),
    });
    if (!result) return null;

    console.log(
      `[ContentDetector] Readability mapping: <${result.root.tagName}> .${(result.root.className || '').slice(0, 40)} ` +
        `anchors=${result.matchedAnchors}/${result.totalAnchors} mappingConf=${result.mappingConfidence.toFixed(2)} ` +
        `contentCov=${result.contentCoverage.toFixed(2)}`,
    );
    return result;
  } catch (e) {
    console.warn('[ContentDetector] Readability fallback failed:', e);
    return null;
  }
}

// =============================================================================
// 主入口
// =============================================================================

/**
 * 智能识别文章正文容器。
 *
 * @param doc Document
 * @param contextOut 可选的 out 参数: 函数返回时, contextOut 中会填充
 *                   - noiseSet: 已识别的噪声元素集合 (consent SDK 容器)
 *                   - textCache: textLength 缓存, 供 block extraction 复用
 *                   - confidence: root 的置信度 (0~1)
 *                   - semanticHints: 语义提示 (isArticle/hasCode/hasMath)
 * @returns 最佳候选元素，或 null（分数不够，建议回退 body）
 */
export interface DetectArticleRootOptions {
  /** 是否启用 Readability fallback（默认 true，保持旧行为）。 */
  useReadability?: boolean;
}

export function detectArticleRoot(
  doc: Document,
  contextOut?: Partial<ArticleContext>,
  options: DetectArticleRootOptions = {},
): Element | null {
  const { useReadability = true } = options;
  // Per-traversal 缓存: 一次 detectArticleRoot 调用内共享, 结束后 GC。
  // - textCache: 缓存 el.textContent.length, 消除 O(N²) subtree traversal
  // - consentMemo: 缓存 consent SDK 安全阀判定, 避免全局 WeakSet 跨调用残留
  // - noiseSet: 收集 collectCandidates 期间被排除的 consent SDK 容器,
  //             共享给 block extraction 的 WalkCache.knownNoise, 实现
  //             "root detection 已识别的噪声 → block extractor O(1) 跳过"。
  const textCache: TextLenCache = new WeakMap();
  const consentMemo = new WeakMap<Element, boolean>();
  const noiseSet = new WeakSet<Element>();

  const candidates = collectCandidates(doc, consentMemo, noiseSet);
  if (candidates.length === 0) return null;

  let bestEl: Element | null = null;
  let bestScore = -1;

  for (const el of candidates) {
    const score = scoreElement(el, textCache);
    if (score > bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }

  // 判断当前最佳候选是否可靠：分数不足、占 body 文本比例过低，
  // 或者 best 是孤立的 section 等局部容器时，启用 Readability fallback。
  let shouldTryReadability = false;
  if (useReadability && bestEl && doc.body) {
    const bodyText = getTextLength(doc.body, textCache);
    const bestTextLen = getTextLength(bestEl, textCache);
    const ratio = bodyText > 0 ? bestTextLen / bodyText : 0;
    if (bestScore < SCORE_THRESHOLD || ratio < 0.15) {
      shouldTryReadability = true;
    } else if (isFragmentedArticleRoot(bestEl, doc)) {
      console.log(
        `[ContentDetector] Best candidate looks like a fragmented section, trying Readability fallback`,
      );
      shouldTryReadability = true;
    }
  } else if (useReadability) {
    shouldTryReadability = true;
  }

  if (shouldTryReadability) {
    const readabilityMapping = tryReadabilityRoot(doc);
    if (readabilityMapping) {
      const readabilityRoot = readabilityMapping.root;
      const s = scoreElement(readabilityRoot, textCache);
      const readabilityTextLen = getTextLength(readabilityRoot, textCache);
      const bestTextLen = bestEl ? getTextLength(bestEl, textCache) : 0;
      if (readabilityTextLen >= bestTextLen * 0.5) {
        bestScore = Math.max(s, SCORE_THRESHOLD + 1);
        bestEl = readabilityRoot;
        console.log(
          `[ContentDetector] Readability fallback root: <${bestEl.tagName}> .${(bestEl.className || '').split(/\s+/)[0]} (score: ${bestScore.toFixed(1)}, raw: ${s.toFixed(1)}, textLen: ${readabilityTextLen})`,
        );
      }
    }
  }

  if (bestScore < SCORE_THRESHOLD) {
    console.log(`[ContentDetector] Best score ${bestScore} < threshold ${SCORE_THRESHOLD}, fallback to body`);
    return null;
  }

  // 防御: 即便通过了 collectCandidates 过滤, 也再校验一次冠军不是 consent SDK
  // (理论上不会命中, 但 collectCandidates 的祖先展开可能引入外层包装)。
  if (bestEl && isConsentSdkContainer(bestEl, consentMemo)) {
    console.log(
      `[ContentDetector] Best candidate is a consent/cookie SDK container, ignoring (score: ${bestScore})`,
    );
    return null;
  }

  const firstClass = (bestEl!.className || '').split(/\s+/)[0] || '';
  console.log(`[ContentDetector] Best: <${bestEl!.tagName}> .${firstClass} (score: ${bestScore})`);

  // 把 root detection 期间收集的 noiseSet / textCache / confidence 共享给
  // block extraction, 避免 detectArticleRoot 已识别的噪声在 collectBlocks
  // 中被重复判定 (旧版两个阶段各自独立过滤, 既浪费 CPU 又可能产生冲突)。
  if (contextOut) {
    contextOut.noiseSet = noiseSet;
    contextOut.textCache = textCache;
    // confidence: 分数超过阈值 5x 视为高置信 (0.95), 否则按比例缩放到 0.5~0.9
    contextOut.confidence = bestScore >= SCORE_THRESHOLD * 5
      ? 0.95
      : 0.5 + Math.min(0.4, (bestScore - SCORE_THRESHOLD) / (SCORE_THRESHOLD * 5) * 0.4);
    // semanticHints: 简单基于 best 元素的内容推断
    const bestTag = bestEl!.tagName.toLowerCase();
    const bestCls = typeof bestEl!.className === 'string' ? bestEl!.className : '';
    contextOut.semanticHints = {
      isArticle: bestTag === 'article' || /article|post|entry/i.test(bestCls),
      hasCode: !!bestEl!.querySelector('pre, code'),
      hasMath: !!bestEl!.querySelector('math, .math, .katex'),
    };
  }

  return bestEl;
}
