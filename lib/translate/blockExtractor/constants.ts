/**
 * blockExtractor 常量定义
 *
 * 全部为只读静态数据,按"用途"分类并用中文注释解释每类的来源和取舍。
 * 修改这些规则时请同步更新 src/__tests__/blockExtractor.test.ts 的对应测试。
 */

// =============================================================================
// 文本长度边界
// =============================================================================

/** 最小可翻译文本长度 (字符数)。低于此值的文本 (按钮、链接、噪声) 一律跳过。 */
export const MIN_TEXT_LENGTH = 3;

/** 最大可翻译文本长度 (字符数)。超长文本很可能是误抓的代码块 / 数据表。 */
export const MAX_TEXT_LENGTH = 3072;

/** XHTML 命名空间 URI。SVG/MathML 等非 HTML 命名空间下的元素整棵拒绝。 */
export const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

// =============================================================================
// 文本过滤正则
// =============================================================================

/**
 * 静态正则: 避免每次 isValidText 调用时实例化 RegExp 触发 V8 GC。
 * 这些正则只读不写,模块加载时实例化一次即可。
 */

/** Sentry / Webpack chunk 列表里的元组 (['x', 1234]) 形式。≥8 个匹配视为噪声。 */
const TUPLE_REGEX = /\[\s*['"][^'"]+['"]\s*,\s*-?\d+(?:\.\d+)?\s*\]/g;

/** 200+ 字符无空白的 base64-ish 字符。误判为 base64 编码块,跳过。 */
const BASE64_REGEX = /^[A-Za-z0-9+/=_-]{200,}$/;

/** 全大写 / 数字 / 空格混合的 UI 文本 ("EMAIL", "SUBSCRIBE TO NEWSLETTER")。 */
const UI_TEXT_REGEX = /^[A-Z0-9\s]+$/;

/** 纯数字 / 空格 ("1 2 3", "2024")。 */
const DIGIT_SPACE_REGEX = /^[0-9\s]+$/;

/** h1-h6 标签的快速匹配。 */
const HEADING_REGEX = /^H[1-6]$/;

export const PATTERNS = {
  TUPLE: TUPLE_REGEX,
  BASE64: BASE64_REGEX,
  UI_TEXT: UI_TEXT_REGEX,
  DIGIT_SPACE: DIGIT_SPACE_REGEX,
  HEADING: HEADING_REGEX,
} as const;

// =============================================================================
// 元素集合
// =============================================================================

/**
 * DIRECT_SET: 命中后**自身**作为翻译块返回 (前提是 text 有效)。
 * 这些是"块级"语义元素,内部不应该再嵌套块级元素。
 */
const DIRECT_SET_RAW = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',  // 标题
  'p',                                  // 段落
  'li', 'dd',                           // 列表项 / 定义描述
  'blockquote',                         // 引用
  'figcaption',                         // 图注
];
export const DIRECT_SET: ReadonlySet<string> = new Set(DIRECT_SET_RAW);

/**
 * SKIP_SET: 命中后**自身**永远不翻译,整棵子树拒绝。
 * 这些是结构性 / 交互性元素,翻译无意义或会破坏功能。
 *
 * 📋 表格元素 (<td> <th> <caption> <dt>) 故意保留在 SKIP_SET:
 *   - 代码表 / 数据表 (Wikipedia GDP 对比、Wikipedia 年度统计) 现阶段不翻,
 *     原因: 模型对数字/单位/年份的翻译一致性差,容易把 "10,000" 翻成 "一万"
 *     或把 "Q1" 翻成 "第一季度" 破坏对照阅读。
 *   - 未来如需支持, 应在 rules.ts 加 isDataTable() 判定 (table role / 数字密度
 *     / 单元格 <a> 比例) 再单独放行, 而不是粗暴地全翻。
 *   - 相关: <pre> <code> 也保留在 SKIP_SET, 防止代码块被强行翻译破坏语法。
 *
 * 📋 表单元素 (<label> <legend> <option> <optgroup> <form> <fieldset>) 故意**不**
 *    列入 SKIP_SET: 它们是用户可见文本,应让 walker 抓取翻译。fall through 到
 *    默认分类后, <label>Email</label> 会被当作纯文本节点接受, <form><p>...</p>
 *    </form> 会被当作容器让子树通过。
 *
 * 📋 媒体元素 (<video> <audio> <picture> <source>) 列入 SKIP_SET: 控件/轨道
 *    都是用户态而非正文, 早 reject 节省 walker 工作。
 */
const SKIP_SET_RAW = [
  // --- 根 / 文档元信息 (HEAD 子树通常不被 walker 访问, 防御性列出) ---
  'html', 'head', 'body', 'title', 'meta', 'link', 'base',

  // --- 脚本 / 样式 / 嵌入页 ---
  'script', 'style', 'noscript', 'iframe', 'template', 'slot',

  // --- 嵌入内容 (类似 iframe, 整棵子树不应被翻译) ---
  'embed', 'object', 'param',

  // --- 媒体播放器 (控件/字幕等是用户态, 不是正文) ---
  'video', 'audio', 'track', 'source', 'picture',

  // --- 图片地图 ---
  'map', 'area',

  // --- 表单: 仅保留真正无文本的纯输入控件, 其它(可见文本)应翻译 ---
  //   - input/textarea: value 是用户输入, 不是 DOM 文本节点
  //   - select/button: 内的 <option>/文字 是用户可见 UI, 应翻译
  //   - datalist/output/meter/progress: 同上, 文本可能可翻
  'input', 'textarea',

  // --- 代码 (保留原文, 不破坏语法) ---
  'code', 'pre', 'kbd', 'samp', 'var', 'tt',

  // --- 表格相关 (代码表 / 数据表, 现阶段不翻, 见上面注释) ---
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'col', 'colgroup', 'dt',
  // 注意: <dd> 故意不在此, 它在 DIRECT_SET 里, 要翻译定义描述 (description)。
  // 注意: <hgroup> 故意不在此, 见 walker.ts 的"其他容器"分支: 子 h1-h6 应翻译。
];
export const SKIP_SET: ReadonlySet<string> = new Set(SKIP_SET_RAW);

/**
 * SEMANTIC_SKIP_TAGS: 命中后**整棵子树**拒绝 (默认策略,header 单独处理)。
 * 这些是"语义上不属于正文"的容器。
 *
 * ⚠️ <header> 单独处理: 见 walker.ts 的 header 分支。
 *    - 含 h1-h6 → 跳过自身,走子树 (文章 header,标题要翻)
 *    - 不含     → 整棵拒绝 (navbar / site-header)
 */
const SEMANTIC_SKIP_TAGS_RAW = [
  'header',  // ⚠️ 单独处理,见 walker.ts
  'footer', 'aside', 'nav',
  'search',  // <search>: 搜索区域,语义上的 nav 兄弟
  'dialog',  // <dialog>: 模态弹窗, 类似 cookie banner
  'address', // <address>: 联系人信息, 类比 byline 不翻
];
export const SEMANTIC_SKIP_TAGS: ReadonlySet<string> = new Set(SEMANTIC_SKIP_TAGS_RAW);

/**
 * INLINE_SET: 命中后根据上下文决定: 若在 article 内且无块级父 → 作为翻译块;
 * 否则跳过 (避免内联元素被独立抓出导致句子碎片化)。
 *
 * 按 MDN [inline text semantics](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements#inline_text_semantics)
 * + [demarcating edits](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements#demarcating_edits)
 * 分类补全, 兼顾 obsolete 元素 (<font> <tt>) 兼容老站。
 */
const INLINE_SET_RAW = [
  // --- Inline text semantics (MDN 标准列表) ---
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn',
  'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong',
  'sub', 'sup', 'time', 'u', 'var', 'wbr',
  // ruby 注音 (东亚语言常用): rb/rt/rp 是 ruby 的子元素, 整体让 walker 抓
  'ruby', 'rb', 'rt', 'rp',

  // --- Demarcating edits (MDN: <del> <ins>) ---
  'del', 'ins',

  // --- Obsolete 但仍有站用 ---
  'font', 'tt', 'big', 'strike',

  // --- 媒体占位 (无文本, 但如果被独立抓也安全) ---
  'img',
];
export const INLINE_SET: ReadonlySet<string> = new Set(INLINE_SET_RAW);

// =============================================================================
// 跳过类名 (Skip Class Patterns)
// =============================================================================
//
// 命名规则: startsWith / endsWith 配合 '-' 或 '_' 边界,所以 'social-share'
// 不会误匹配 'social-shareholder-list' (前缀分隔符保护)。
// 但 'author-bio' 中的 'bio' 不会被 'author' 捕获——后者在 METADATA_TOKENS 里。
//
// 新增规则时请同时思考:
//   1. 是否会误伤正常内容 (e.g. 'inline-ad' vs 'inline-article'——后者不会
//      命中,因为 'inline-article' 不以 'inline-ad-' 开头也不以它结尾)
//   2. 是否需要整棵子树拒绝 (cookie banner 整棵拒; tag 容器整棵拒)

const SKIP_CLASS_PATTERNS_RAW = [
  // ---------- 导航 / 站点头脚 ----------
  'sidebar', 'side-bar', 'sideBar',
  'nav-menu', 'main-menu', 'navigation-menu', 'mobile-nav',
  'channels-nav', 'topics-nav', 'nav-topics',
  'footer-wrap', 'post-footer', 'site-footer', 'footer', 'footnote', 'copyright',
  'content-column-post-footer', 'content-column-mobile-footer',
  'site-header', 'site-top', 'top-bar', 'topbar', 'masthead',
  'site-branding', 'site-logo', 'header-top', 'header-main',
  'breadcrumb', 'byline', 'post-meta', 'author-box',

  // ---------- 订阅 / 注册 / 登录 ----------
  'subscribe-widget', 'widget-area', 'subscribe-',
  'login-form', 'login-box', 'login-bar', 'loginbar',
  'signin-form', 'signup-form', 'register-form', 'registration',
  'auth-form', 'auth-box', 'user-area', 'user-menu', 'user-profile',
  'member-area', 'membership',
  'newsletter-signup', 'newsletter-form', 'newsletter-subscribe',
  'newsletter-popup', 'newsletter-overlay', 'newsletter-modal',
  'email-signup', 'email-subscribe', 'email-capture', 'signup-form',
  // 内联订阅表单: 插入到正文中间或末尾的 newsletter signup 卡片。
  // 跨站通用 (NYT / Bloomberg / Medium / bankingdive 都有此模式)。
  'inline-signup', 'inline_newsletter', 'inline-newsletter',
  'inline-subscribe', 'inline-subscription',
  'embed-signup', 'embed-newsletter', 'embed-subscribe',

  // ---------- 广告 / 推广 / 联盟 ----------
  'ad-container', 'ad-slot', 'ads-box', 'advertisement',
  'adsbygoogle', 'google-ad', 'google-ads',
  'dfp-ad', 'dfp-unit', 'gpt-ad', 'div-gpt-ad',
  'ad-wrapper', 'ad-panel', 'ad-frame', 'ad-box', 'ad-inner', 'ad-holder',
  'ad-banner', 'ad-placeholder', 'ad-label', 'ad-unit', 'ad-widget', 'ad-area',
  'ad-div', 'ad-code', 'ad-block', 'ad-content', 'ad-outer',
  'adslot', 'adunit', 'adbox', 'advert', 'advertorial', 'adv',
  'display-ad', 'display-ads', 'header-ad', 'footer-ad', 'sticky-ad',
  'in-article-ad', 'inline-ad', 'incontent-ad', 'incontent-ads',
  'ezoic-ad', 'ezoic-pub', 'freestar-ad',
  'leaderboard', 'skyscraper',
  'taboola', 'taboola-widget', 'trc',
  'outbrain', 'outbrain-widget', 'ob-widget',
  'mgid', 'mgbox', 'marketgid',
  'revcontent', 'rev-content',
  'zergnet', 'zergnet-widget',
  'rc-widget',
  'native-ad', 'nativead', 'native-ads',
  // bankingdve 用 .hybrid-ad-wrapper 包桌面/移动两个尺寸的广告 div;
  // 其他站常用 .ad-slot, .ad-banner 等通用命名。一并列入。
  'hybrid-ad', 'hybrid-ad-wrapper', 'hybrid_ad_wrapper', 'hybridad',
  'content-recommendation', 'recommended-content',
  'sponsored', 'sponsored-content', 'sponsored-post', 'sponsored-link', 'sponsored-links',
  'promoted', 'promoted-content', 'promoted-post',
  'paid-content', 'paid-post',
  'affiliate', 'affiliate-link',
  'commercial', 'commercial-content',

  // ---------- Cookie / GDPR / 隐私弹窗 ----------
  'cookie-consent', 'cookie-banner', 'cookie-notice', 'cookie-policy', 'cookie-table', 'cookie-settings',
  'cookie-bar', 'cookie-box', 'cookie-modal', 'cookie-container', 'cookie-popup', 'cookie-overlay', 'cookie-wrapper',
  'cookie-law', 'cookie-disclaimer', 'cookie-management', 'cookie-accept', 'cookie-compliance', 'cookie-control',
  'cookies-modal', 'cookies-wrapper', 'cookie__wrap', 'coockies',
  'modal-cookie', 'modal-cookies', 'cookie-div',
  'cc-window', 'cc-banner', 'cc-overlay', 'cc-container', 'cc-floating',
  'cmpbox', 'cmpwrapper', 'cmp',
  'klaro',
  'onetrust-banner', 'onetrust-pc', 'onetrust-overlay',
  'ot-sdk', 'ot-pc', 'onetrust', 'ot-cookie', 'ot-policy', 'ot-category', 'ot-floating',
  'borlabs-cookie', 'brlbs',
  'cmplz', 'cmplz-cookie', 'cmplz-manage',
  'moove-gdpr',
  'cli-modal', 'cli-popup', 'cli-bar', 'wt-cli',
  'cky-consent', 'cky-notice', 'cky-modal', 'cky-banner',
  'wpfront-notification-bar',
  'gdpr', 'gdpr-banner', 'gdpr-consent', 'gdpr-modal', 'gdpr-overlay', 'gdpr-mask',
  'privacy', 'privacy-policy', 'privacy-notice', 'privacy-pref', 'privacy-popup', 'privacy-modal', 'privacy-info',
  'data-protection', 'data-privacy', 'data-consent',
  'consent', 'consent-banner', 'consent-container', 'consent-modal', 'consent-overlay',
  'consent-popup', 'consent-wrapper', 'outer-consent',
  'opt-in', 'optin',
  'eucookie', 'euc', 'cnil', 'ccpa', 'lgpd', 'rodo',
  'hinweis', 'confidentialite',
  'disclaimer', 'disclamer', 'disclaimer-container',
  'cookieman', 'cookiemgmt', 'cookie-management',
  'cbar', 'cono', 'coo', 'cook',
  'lawdiv', 'cookie-law-info',
  'banner-ad',

  // ---------- 弹窗 / 模态 / 遮罩 ----------
  'popup-overlay', 'modal-dialog', 'modal-backdrop',

  // ---------- 分享按钮 / 社交图标 ----------
  'social-share', 'share-buttons', 'share-menu', 'share-list', 'share-icons',
  'social-icons', 'social-icon-list', 'social-share-list', 'share-toolbar',

  // ---------- 相关推荐 / 热门 / 内联 carousel ----------
  'trending-stories', 'tns-trending-stories-block', 'related-posts',
  'related-articles', 'related-content', 'more-stories', 'more-articles',
  'also-read', 'you-may-like', 'read-next',
  'read-more', 'read_more', 'readmore',
  'reading-list', 'reading_list', 'readinglist',
  'recommended-reading', 'recommended_reading', 'recommendedreading',
  'recommended-articles', 'recommended_articles',
  'more-from', 'more_from', 'morefrom',
  // 站点内部文章轮播 ("Read More in Technology" 这类 inline carousel
  // 嵌在 article-body 中间): 永远是其他文章的摘要,跨站通用。
  'storylines-carousel', 'storylines-carousel-wrapper', 'storylines-carousel-block',
  'article-carousel', 'article-carousel-wrapper', 'inline-carousel',
  'related-carousel', 'related-stories', 'more-stories-carousel',

  // ---------- 评论 ----------
  'comment-list', 'comment-section', 'comment-area', 'comment-module',
  'comment-wrapper', 'comment-body', 'comment-content', 'comment-form',
  'comment-reply', 'comment-thread', 'comment-holder', 'comment-entry',
  'comments-area', 'comments-section', 'comments-wrapper',
  'commentlist', 'discussion',

  // ---------- 搜索 ----------
  'search-form', 'search-box', 'search-bar', 'searchbar', 'search-input',
  'search-wrapper', 'search-widget', 'search-container', 'search-results',

  // ---------- 翻页 / 目录 / 语言切换 ----------
  'pagination', 'pager', 'paging', 'page-nav', 'page-numbers',
  'nav-links', 'post-navigation',
  'toc', 'table-of-contents', 'toc-container', 'toc-widget',
  'lang-switcher', 'language-switcher', 'language-selector',
  'lang-select', 'lang-selector', 'locale-switcher', 'locale-selector',

  // ---------- 文章底部挂件 ----------
  'post-article-wrapper', 'post_article_wrapper', 'postarticlewrapper',
  'post-content-wrapper', 'after-article', 'after-article-wrapper',
  'below-content', 'below-content-wrapper', 'article-footer-widgets',

  // ---------- 打印模式残留 ----------
  'printed-branding', 'print-branding', 'printed-logo', 'print-logo',
  'print-only', 'print-version', 'printable',

  // ---------- 标签云 / 分类列表 ----------
  'tagcloud', 'tags-list', 'tag-list', 'categories-list', 'category-list',
  'taxonomy-list', 'meta-tags', 'entry-tags',

  // ---------- 验证码 ----------
  'captcha', 'g-recaptcha', 'recaptcha', 'h-captcha', 'hcaptcha', 'turnstile',

  // ---------- 日期 (精确类名,模糊类名走 metadata tokens) ----------
  'post-date', 'entry-date', 'entry-time', 'published-date', 'published-time',
  'posted-on', 'updated-on',

  // ---------- 评分 / 调查 ----------
  'rating-widget', 'rating-box', 'rating-container', 'star-rating', 'user-rating',
  'review-widget', 'review-box', 'review-form', 'reviews-widget', 'reviews-list',
  'poll', 'voting', 'vote-widget', 'survey',
  'exit-popup', 'exit-intent', 'welcome-popup', 'welcome-mat',

  // ---------- 用户显式标记 "不要翻译" ----------
  'notranslate',
];

/**
 * 跳过类名列表 (小写,精确匹配 + 前后缀分隔符匹配)。
 * 大小写不敏感。
 */
export const SKIP_CLASS_PATTERNS: readonly string[] = SKIP_CLASS_PATTERNS_RAW;

// =============================================================================
// 元数据类名 token (METADATA_TOKENS)
// =============================================================================
//
// 文章 header / footer 内的元数据容器 (作者 / 日期 / 分类 / tag 列表)。
// 用**整词分割**匹配 (split on [_\-\s]),不是子串,避免误伤:
//   - "metadata-block"   → 分割后 ['metadata', 'block'], 'metadata' 不在 set 里 ✓
//   - "author-bio"       → ['author', 'bio'],     'author' 在 set 里 ✓ 跳过
//   - "post-meta-info"   → ['post', 'meta', 'info'], 'meta' 在 set 里 ✓ 跳过
//   - "authorship"       → ['authorship'],         不在 set 里 ✓ 保留
//
// 翻这类内容的问题:
//   1. 翻错人名 ("John Doe" → "约翰·多伊",用户不习惯)
//   2. 翻错日期格式 ("May 26" → "5月26日",但站点可能就是英文日期)
//   3. 把分类标签翻成中文破坏 SEO / 标签云
const METADATA_TOKENS_RAW = [
  'meta',       // post-meta, entry-meta, article-meta, meta-info
  'author',     // author-name, author-bio, post-author
  'byline',     // byline, entry-byline
  'category',   // post-category, category-link
  'categories', // post-categories, categories-list
  'dateline',   // article-dateline
];
export const METADATA_TOKENS: ReadonlySet<string> = new Set(METADATA_TOKENS_RAW);

// =============================================================================
// 文章容器类名 (用于 isInsideArticle 向上追溯)
// =============================================================================
const ARTICLE_CONTAINER_CLASS_PATTERNS_RAW = [
  'article-content', 'article-body', 'article-text',
  'story-content', 'story-body', 'story-text',
  'main-content', 'content-body', 'content-area',
  'post-content', 'entry-content', 'page-content',
];
export const ARTICLE_CONTAINER_CLASS_PATTERNS: readonly string[] =
  ARTICLE_CONTAINER_CLASS_PATTERNS_RAW;

// =============================================================================
// Walker 节点计数
// =============================================================================

export interface WalkerCounters {
  /** 整棵子树拒绝的元素数 (含 class 命中、隐藏、命名空间等)。 */
  rejected: number;
  /** 跳过自身但走子树的元素数 (含 header 含标题、DIRECT_SET 含子块)。 */
  skipped: number;
  /** 真正被抽为翻译块的元素数。 */
  accepted: number;
}

export function createCounters(): WalkerCounters {
  return { rejected: 0, skipped: 0, accepted: 0 };
}
