/**
 * blockExtractor 判定规则
 *
 * 所有 shouldSkip* / is* 谓词集中在这里,逻辑上分两类:
 *   1. 节点级判定: 根据元素自身属性决定 (class, hidden, namespace, ...)
 *   2. 上下文判定: 向上/向下遍历父链或子树 (isInsideArticle, hasBlockLevelParent, ...)
 *
 * 为什么独立: walker.ts 只负责"按这些规则决定 FILTER_*",不混入具体判定逻辑;
 * 每条规则都可独立加测试。
 */

import { matchSiteRule, type SiteRule } from '../rules';
import {
  ARTICLE_CONTAINER_CLASS_PATTERNS,
  DIRECT_SET,
  INLINE_SET,
  MAX_TEXT_LENGTH,
  METADATA_TOKENS,
  MIN_TEXT_LENGTH,
  PATTERNS,
  SKIP_CLASS_PATTERNS,
  XHTML_NAMESPACE,
} from './constants';

// =============================================================================
// SiteRule 缓存
// =============================================================================
//
// matchSiteRule() 内部会对 URL 做模式匹配,每个 walker 节点都查会重复工作。
// 缓存到模块级,URL 变化时刷新。SPA 路由切换会触发刷新。

let cachedRule: SiteRule | null = null;
let cachedUrl: string | null = null;

function getSiteRule(pageUrl: string): SiteRule | null {
  if (cachedUrl === pageUrl) {
    return cachedRule;
  }
  const matched = matchSiteRule(pageUrl);
  cachedUrl = pageUrl;
  cachedRule = matched?.siteRule || null;
  if (cachedRule) {
    console.log(`[getSiteRule] matched rule for ${pageUrl.slice(0, 120)} with ${cachedRule.skipSelectors?.length ?? 0} skipSelectors`);
  }
  return cachedRule;
}

/** 测试用：清空站点规则缓存 */
export function clearSiteRuleCache(): void {
  cachedRule = null;
  cachedUrl = null;
}

// =============================================================================
// Class 匹配工具
// =============================================================================

/**
 * 把 className 按空白切分,小写。
 * 防御: SVG 元素的 className 是 SVGAnimatedString,不是 string,直接当 string 用会报错。
 */
function tokenizeClass(el: Element): string[] {
  if (!el.className || typeof el.className !== 'string') return [];
  return el.className.toLowerCase().split(/\s+/);
}

/**
 * 精确 / 前后缀边界匹配 (与 SKIP_CLASS_PATTERNS 配合使用):
 *   - 精确:    "social-share" === "social-share"
 *   - 前缀:    "social-share-buttons" startsWith "social-share-"
 *   - 后缀:    "post-social-share" endsWith "-social-share"
 *   - 不匹配:  "social-shareholder-list" (前缀 'social-share' 后不是 '-' 或 '_')
 */
function matchesSkipClass(token: string, pattern: string): boolean {
  return (
    token === pattern ||
    token.startsWith(pattern + '-') ||
    token.startsWith(pattern + '_') ||
    token.endsWith('-' + pattern) ||
    token.endsWith('_' + pattern)
  );
}

/**
 * 噪声类元素文本长度安全阀：超过此长度的元素不视为噪声，防误杀长 FAQ。
 *
 * webclaw 借鉴：cookie/consent/footer 等噪声类元素若 textContent > 5000 字符，
 * 很可能是长 FAQ / 长隐私政策正文 / 长评论，不应被整棵跳过。
 *
 * 回归 case: #cookiesModal (Bootstrap modal 含 cookie policy tabs) 有 ~50k
 * 字符文本，因 class 含 "cookie" 被跳过，但它实际是页面正文。
 */
const NOISE_TEXT_SAFE_VALVE = 5000;

const _noiseSafeValveMemo = new WeakSet<Element>();

/**
 * 检查元素是否因文本过长而豁免噪声判定。
 * 用 WeakSet 缓存，同一元素不会重复计算 textContent。
 */
function isNoiseSafeValve(el: Element): boolean {
  if (_noiseSafeValveMemo.has(el)) return true;
  const text = el.textContent || '';
  if (text.length > NOISE_TEXT_SAFE_VALVE) {
    _noiseSafeValveMemo.add(el);
    return true;
  }
  return false;
}

/**
 * 是否因 class 命中 SKIP_CLASS_PATTERNS 而应跳过 (整棵子树拒绝)。
 * 跨站通用: 广告 / cookie / 推荐 / 弹窗 / 导航 等。
 *
 * 安全阀：若元素 textContent > 5000 字符，即使 class 命中噪声模式也不跳过，
 * 防止误杀长 FAQ / 长隐私政策等正文内容。
 */
export function shouldSkipByClass(el: Element): boolean {
  const tokens = tokenizeClass(el);
  if (tokens.length === 0) return false;
  for (const token of tokens) {
    for (const pattern of SKIP_CLASS_PATTERNS) {
      if (matchesSkipClass(token, pattern)) {
        // 安全阀：噪声类元素若 text > 5000 字符则不视为噪声
        if (isNoiseSafeValve(el)) return false;
        return true;
      }
    }
  }
  return false;
}

/**
 * 是否为元数据容器 (作者 / 日期 / 分类 / byline)。
 * 用**整词分割**匹配,不是子串——避免误伤 "metadata-block" / "authorship"。
 * 命中后整棵子树拒绝,避免误翻人名 / 日期格式 / 分类标签。
 */
export function isMetadataClass(el: Element): boolean {
  const tokens = tokenizeClass(el);
  if (tokens.length === 0) return false;
  // 整词分割: "post-meta-info" → ['post', 'meta', 'info']
  // 但我们的 tokens 已经是按空格切的,对 '-' '_' 分隔需要二次拆分
  for (const token of tokens) {
    for (const sub of token.split(/[_\-]+/)) {
      if (METADATA_TOKENS.has(sub)) return true;
    }
  }
  return false;
}

// =============================================================================
// Site-specific 规则
// =============================================================================

/**
 * 站点特殊规则 (src/rules/): 命中后整棵子树拒绝。
 * 通过 CSS selector 匹配,允许站点级更复杂的命中 (e.g. 复合选择器)。
 */
export function shouldSkipBySiteRules(el: Element, pageUrl: string): boolean {
  const rule = getSiteRule(pageUrl);
  if (!rule?.skipSelectors) return false;

  for (const selector of rule.skipSelectors) {
    if (el.closest(selector)) return true;
  }
  return false;
}

// =============================================================================
// 元素可见性
// =============================================================================

/**
 * 是否隐藏 (display: none / visibility: hidden / hidden 属性 / aria-hidden=true)。
 *
 * ⚠️ 性能: 原实现走父链 + getComputedStyle, 大型页面 (~1000 节点 × 15 深)
 * 触发 ~15000 次 layout。优化后只检查 el 自身 (cheap attributes + inline style
 * + 单次 getComputedStyle)。理由:
 *   1. 父链上 hidden 的元素, 它的子元素会被 rejectedCache 拦截, walker
 *      根本不会访问到——所以"父隐藏子"的情况不会浪费检查。
 *   2. display:none 几乎总在 inline style 或顶层 modal/popover 容器上,
 *      极少需要沿父链回溯。
 *   3. 如果实测有漏网, 可以升级为带 memoization 的实现 (WeakSet 已查过 visible
 *      的元素跳过 computed style 查), 见 _elementVisibilityMemo。
 */
const _elementVisibilityMemo = new WeakSet<Element>();

export function isElementHidden(el: Element): boolean {
  // 已确认可见的, 不再查 (避免在子树中重复 layout)
  if (_elementVisibilityMemo.has(el)) return false;

  // Cheap: 显式属性
  if (el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;

  // Cheap: inline style
  // linkedom 的 Element 没有 getAttribute('hidden')/style 的运行时保护，
  // 但 nodeType 一定是 ELEMENT_NODE (=1)，这里用 nodeType 判别跨平台
  if (el.nodeType === 1) {
    const s = (el as unknown as { style?: { display: string; visibility: string } }).style;
    if (s && (s.display === 'none' || s.visibility === 'hidden')) return true;
  }

  // 兜底: getComputedStyle (会触发 layout, 谨慎使用)
  if (el.nodeType === 1) {
    try {
      // linkedom 不实现 layout，getComputedStyle 调了会 throw 或返回空串，
      // catch 兜底即可（不可见判断已经在前面的 inline style 路径上完成）
      const computed = typeof window !== 'undefined' ? window.getComputedStyle(el) : null;
      if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) {
        return true;
      }
    } catch {
      // jsdom / linkedom 等无 layout 环境, 静默忽略
    }
  }

  // 标记可见, 后续子孙中的同元素 (e.g. 多个 walker visit 同一节点) 跳过
  _elementVisibilityMemo.add(el);
  return false;
}

// =============================================================================
// 命名空间
// =============================================================================

/**
 * 是否在非 HTML 命名空间 (SVG, MathML)。
 * 翻译 SVG <text> 元素很危险 (可能破坏图表); 整棵拒绝。
 */
export function isNonHTMLNamespace(el: Element): boolean {
  return el.namespaceURI !== null && el.namespaceURI !== XHTML_NAMESPACE;
}

// =============================================================================
// 文本有效性
// =============================================================================

/**
 * 文本是否值得翻译:
 *   - 长度在 [MIN, MAX) 区间
 *   - 不是全大写短 UI 文本 ("EMAIL", "SUBSCRIBE")
 *   - 不是 base64 块
 *   - 不是 Sentry / Webpack 元组列表
 *   - 不匹配站点规则的 skipTextPatterns
 */
export function isValidText(
  text: string | undefined | null,
  pageUrl?: string
): boolean {
  if (!text) return false;

  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH || trimmed.length >= MAX_TEXT_LENGTH) {
    return false;
  }

  // 全大写短 UI 文本: 翻译 "EMAIL" → "电子邮件" 反而破坏表单语义
  if (
    trimmed.length < 25 &&
    PATTERNS.UI_TEXT.test(trimmed) &&
    !PATTERNS.DIGIT_SPACE.test(trimmed)
  ) {
    return false;
  }

  // 误抓的元组列表 / base64 块
  const tupleMatches = trimmed.match(PATTERNS.TUPLE);
  if (tupleMatches && tupleMatches.length >= 8) return false;
  if (PATTERNS.BASE64.test(trimmed)) return false;

  // 站点特殊文本规则 (e.g. Reddit 的 Sentry chunk 列表)
  if (pageUrl) {
    const rule = getSiteRule(pageUrl);
    if (rule?.skipTextPatterns) {
      for (const pattern of rule.skipTextPatterns) {
        try {
          if (new RegExp(pattern, 'i').test(trimmed)) return false;
        } catch {
          // 无效正则静默忽略,不 crash 整个 extraction
        }
      }
    }
  }

  return true;
}

// =============================================================================
// 低优先级元素判定（视觉弱化）
// =============================================================================

const LOW_PRIORITY_PATTERNS = {
  tags: new Set(['nav', 'footer', 'aside']),
  // header 需额外判断：不含 h1-h6 才算低优先级
  // ≤6 字符模式用 \b 词边界，防止 "promo" 误伤 "promontory"、"share" 误伤 "shareholder"、
  // "social" 误伤 "socialism"、"navbar"/"topbar" 误伤 "navbarinfo"、"cookie" 误伤 "cookies-link"
  classTokens: /\bad\b|banner|sponsor|\bpromo\b|affiliate|\bshare\b|\bsocial\b|comment|related|recommend|sidebar|\bnavbar\b|site-nav|global-nav|\btopbar\b|subscribe|newsletter|\bcookie\b|\bconsent\b/i,
  idTokens: /\bad\b|banner|sponsor|\bpromo\b|affiliate|\bshare\b|\bsocial\b|comment|related|recommend|sidebar|\bnavbar\b|site-nav|global-nav|\btopbar\b|subscribe|newsletter|\bcookie\b|\bconsent\b/i,
};

/**
 * 判断元素是否为低优先级内容（footer/nav/aside/广告/社交/推荐等）。
 * 这些元素会被保留在 DOM 中，但视觉上弱化（opacity + grayscale）。
 */
export function isLowPriorityElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();

  // nav / footer / aside 直接判定
  if (LOW_PRIORITY_PATTERNS.tags.has(tag)) return true;

  // header：不含 h1-h6 才算低优先级（避免弱化文章标题区）
  if (tag === 'header') {
    const hasHeading = el.querySelector('h1, h2, h3, h4, h5, h6') !== null;
    return !hasHeading;
  }

  const cls = (el.getAttribute('class') || '').toLowerCase();
  const id = (el.getAttribute('id') || '').toLowerCase();

  if (LOW_PRIORITY_PATTERNS.classTokens.test(cls)) return true;
  if (LOW_PRIORITY_PATTERNS.idTokens.test(id)) return true;

  return false;
}

// =============================================================================
// 弹窗 / Overlay / Cookie Banner 判定（直接隐藏）
// =============================================================================

const OVERLAY_PATTERNS = {
  // ≤6 字符模式用 \b 词边界，防止 "dialog" 误伤 "dialogue"
  classTokens: /\bcookie\b|\bconsent\b|\bgdpr\b|privacy-banner|cookie-banner|\bpopup\b|\bmodal\b|overlay|\bdialog\b|backdrop|lightbox|subscription-popup|paywall|subscribe-popup|newsletter-modal|notification|notifications|push-notification|browser-notification|notification-prompt|subscribers/i,
  idTokens: /\bcookie\b|\bconsent\b|\bgdpr\b|privacy|\bpopup\b|\bmodal\b|overlay|\bdialog\b|notification|notifications|push-notification|browser-notification|notification-prompt|subscribers/i,
  roles: new Set(['dialog', 'alertdialog']),
};

/**
 * 判断元素是否为弹窗 / Cookie Banner / Overlay 等遮挡层。
 * 这些元素会被直接隐藏（display: none），不是页面内容的一部分。
 */
export function isOverlayElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  const cls = (el.getAttribute('class') || '').toLowerCase();
  const id = (el.getAttribute('id') || '').toLowerCase();
  const role = el.getAttribute('role') || '';

  if (OVERLAY_PATTERNS.classTokens.test(cls)) return true;
  if (OVERLAY_PATTERNS.idTokens.test(id)) return true;
  if (OVERLAY_PATTERNS.roles.has(role)) return true;

  // 固定定位的 div 也可能是干扰性 banner（但仅作为辅助信号，需结合其他特征）
  // linkedom 中 HTMLElement.style 可能不可用，用 getAttribute 兜底
  if (tag === 'div') {
    const style = (el.getAttribute('style') || '').toLowerCase();
    if (style.includes('position:fixed') || style.includes('position: sticky')) {
      // 固定定位本身不足以判定为 overlay，需结合 class/id
      // 但如果同时匹配了部分 overlay 关键词，则强化判定
      const hasOverlayHint = /banner|bar|toast|notice|alert/i.test(cls + ' ' + id);
      if (hasOverlayHint) return true;
    }
  }

  return false;
}

// =============================================================================
// 上下文判定 (parent chain / child walk)
// =============================================================================

/**
 * 元素是否在文章容器内 (<article> 标签 / role=article / role=main /
 * 常见文章类名)。仅在 INLINE_SET 元素上调用 (判断 span/a/em 是否值得抓)。
 */
export function isInsideArticle(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (tag === 'article') return true;

    const role = current.getAttribute('role');
    if (role === 'article' || role === 'main') return true;

    // 常见文章容器类名
    const tokens = tokenizeClass(current);
    for (const token of tokens) {
      for (const pattern of ARTICLE_CONTAINER_CLASS_PATTERNS) {
        if (matchesSkipClass(token, pattern)) return true;
      }
    }

    current = current.parentElement;
  }
  return false;
}

/**
 * 元素是否有 DIRECT_SET 块级父 (p/li/dd/blockquote/...)。
 * 用在 INLINE_SET 元素上: 如果外层已是块级,内联不单独抓 (会碎片化句子);
 * 如果只在 inline 容器里 (e.g. <span class="highlight">单独成段</span>),可单独抓。
 */
export function hasBlockLevelParent(el: Element): boolean {
  let current: Element | null = el.parentElement;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (DIRECT_SET.has(tag)) return true;
    if (tag === 'body' || tag === 'html') return false;
    current = current.parentElement;
  }
  return false;
}

// =============================================================================
// 子树结构分析
// =============================================================================

export interface ChildClassification {
  /** 是否有直接文本子节点 (非空)。 */
  hasDirectText: boolean;
  /** 是否有非 INLINE_SET 的子元素。 */
  hasNonInlineChild: boolean;
  /** 是否有非空子元素。 */
  hasNonEmptyElement: boolean;
  /** 是否所有子元素都在 INLINE_SET。 */
  hasOnlyInlineChildren: boolean;
}

/**
 * 把一个非块级元素分类成"容器"或"内联文本":
 *   - hasDirectText=true + hasOnlyInlineChildren=true → 当作翻译块
 *   - hasNonInlineChild=true → 容器,跳过 (子树会被独立处理)
 *   - 都没有 → 空容器,跳过
 */
export function classifyChildren(el: Element): ChildClassification {
  let hasDirectText = false;
  let hasNonEmptyElement = false;
  let hasOnlyInlineChildren = true;

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 && child.textContent?.trim()) {
      hasDirectText = true;
      continue;
    }
    if (child.nodeType !== 1) continue;

    const childEl = child as Element;
    if (childEl.textContent?.trim()) {
      hasNonEmptyElement = true;
    }
    if (!DIRECT_SET.has(childEl.tagName.toLowerCase()) &&
        !INLINE_SET.has(childEl.tagName.toLowerCase())) {
      hasOnlyInlineChildren = false;
    }
  }

  return {
    hasDirectText,
    hasNonInlineChild: !hasOnlyInlineChildren,
    hasNonEmptyElement,
    hasOnlyInlineChildren,
  };
}

// =============================================================================
// 杂项
// =============================================================================

/** 元素是否处于可编辑状态 (contenteditable / isContentEditable)。 */
export function isContentEditable(el: Element): boolean {
  return (
    !!(el as HTMLElement).isContentEditable ||
    el.getAttribute('contenteditable') === 'true'
  );
}

/** 元素是否被自身标记 "不要翻译" (fanyi-bilingual-block) 或 "notranslate"。 */
export function hasTranslateBlockClass(el: Element): boolean {
  return (
    el.classList.contains('fanyi-bilingual-block') ||
    el.classList.contains('notranslate')
  );
}

// =============================================================================
// Inline 翻译候选判定
// =============================================================================

const INLINE_MAX_CHARS = 70;      // 原文最大字符数
const INLINE_MAX_WORDS = 10;       // 原文最大单词数
const BLOCK_LEVEL_TAGS = new Set([
  'div', 'p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'pre', 'blockquote', 'table', 'section', 'article', 'header', 'footer', 'nav', 'aside'
]);

/**
 * 判断元素是否适合作为 inline 翻译候选。
 * 只基于 Extract 阶段已知信息，不读 DOM textContent（避免 hidden 子元素污染）。
 */
export function isInlineCandidate(el: Element, blockText: string): boolean {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;

  // 条件1：列表上下文（li 或 ul/ol 的直接子元素）
  const isListContext = tag === 'li' ||
    (parent !== null && (parent.tagName.toLowerCase() === 'ul' || parent.tagName.toLowerCase() === 'ol'));
  if (!isListContext) return false;

  // 条件2：原文很短（用已经提取的 blockText，不是 el.textContent）
  const text = blockText.trim();
  if (text.length > INLINE_MAX_CHARS) return false;
  const wordCount = text.split(/\s+/).length;
  if (wordCount > INLINE_MAX_WORDS) return false;

  // 条件3：内部没有 block-level 子元素
  const children = el.children;
  for (let i = 0; i < children.length; i++) {
    if (BLOCK_LEVEL_TAGS.has(children[i].tagName.toLowerCase())) {
      return false;
    }
  }

  return true;
}
