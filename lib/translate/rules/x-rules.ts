import type { SiteRule } from './types';

/**
 * X (formerly Twitter) 站点规则。
 *
 * X 的推文正文常被拆成多个 inline <span>/<a> 片段；contentHelper 的
 * mergeInlineBlocks 已在 DOM 层合并这些碎片。这里补充站点特定的跳过规则：
 *   - 侧边栏 / 登录卡片 / 底部 fixed CTA → markGlobalNoise 统一移除
 *   - 用户名、时间戳、浏览量、互动按钮、视频叠加信息等元数据 → skipSelectors
 */
export const xRule: SiteRule = {
  hostPattern: 'x.com',
  skipSelectors: [
    // 用户名区（作者名 + @用户名 + 认证徽章）
    '[data-testid="User-Name"]',
    // "显示翻译" 按钮/链接区（紧邻 tweetText 的 Grok 翻译入口）
    '[aria-label*="翻译"]',
    // "显示更多" 展开按钮
    '[data-testid="tweet-text-show-more-link"]',
    // 时间戳 + 浏览量行（如 "上午6:15 · 2026年7月16日 · 3.9万 查看"）
    'a[href*="/analytics"]',
    'a time',
    // 主帖/回复的时间戳链接：href 含 /status/ 且带 aria-label（如 "12小时 前"）
    'a[href*="/status/"][aria-label]',
    // "查看引用" 链接
    'a[href$="/quotes"]',
    // 视频组件叠加信息（时长、作者名）
    '[data-testid="videoComponent"]',
    // 互动按钮组（回复 / 转帖 / 喜欢 / 书签 / 分享）
    '[role="group"][aria-label*="回复"]',
    '[data-testid="reply"]',
    '[data-testid="retweet"]',
    '[data-testid="unretweet"]',
    '[data-testid="like"]',
    '[data-testid="unlike"]',
    '[data-testid="bookmark"]',
    // 视频/图片叠加信息（时长、作者名）
    '[class*="pointer-events-none"][class*="absolute"][class*="bottom-"]',
    // 回复输入框（inline_reply_offscreen 里的占位文案）
    '[data-testid="inline_reply_offscreen"]',
    '[data-testid="tweetTextarea_0"]',
    // 底部相关 / 查看引用 / 查看新帖子等
    'button[data-testid="pillLabel"]',
  ],
  skipTextPatterns: [
    // 视频时长，如 "1:05"
    '^\\d{1,2}:\\d{2}$',
    // 时间戳文本，如 "上午6:15 · 2026年7月16日" 或 "12小时 · 2026年7月16日"
    '· \\d{4}年',
    // 视频叠加作者信息，如 "来自 Nous Research"
    '^来自 .+',
    // Grok "显示翻译" 链接文案
    '^显示翻译$',
  ],
  // X 的互动/导航文案应保持原样。经 withSiteDocumentTerms 合并进 glossary，
  // 以"保留原文"的形式进入 system prompt。
  documentTerms: [
    'Views',
    'View',
    '查看',
    'Reposts',
    'Likes',
    'Bookmarks',
    'Read',
    'replies',
    'Show more',
    '显示更多',
    'Follow',
    '关注',
    '回复',
    '转帖',
    '喜欢',
    '书签',
  ],
  /**
   * 离线阅读：加宽正文列。
   *
   * X 把 primaryColumn 硬编码成 `max-width: 600px`，在线场景是为了给右侧
   * 趋势栏留位置。离线展示时侧栏已经被 hideXSideColumns 移除，正文却被
   * 一起挤在 600px 里，大屏上两侧大片空白、长段落读起来很窄。
   *
   * 修复策略（article/585 反馈"离线显示太窄"）：
   *   - primaryColumn 放开到 1000px 并 `width:100%`，让它吃满可用宽度；
   *   - 包裹它的 flex 容器（含 css-* 随机类名的 div）一并放开 max-width / width，
   *     否则父级仍是 600px 会把子列重新夹住（外层约束优先于内层）；
   *   - main[role="main"] 保持居中，避免宽列贴左。
   */
  displayCss: [
    // 直接命中正文列：放开宽度并吃满
    '[data-testid="primaryColumn"] {',
    '  max-width: 1000px !important;',
    '  width: 100% !important;',
    '  min-width: 0 !important;',
    '  flex-grow: 1 !important;',
    '  margin-left: auto !important;',
    '  margin-right: auto !important;',
    '}',
    // 父级 flex 容器（X 用 css-* 随机类名包裹 primaryColumn）也要放开，
    // 否则父级 max-width:600px 会反向约束子列
    'main[role="main"] > div,',
    'main[role="main"] > div > div {',
    '  max-width: 100% !important;',
    '  width: 100% !important;',
    '}',
    'main[role="main"] {',
    '  justify-content: center !important;',
    '  max-width: 100% !important;',
    '}',
  ].join('\n'),
};
