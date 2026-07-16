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
  skipTerms: [
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
  promptInstructions:
    'This is an X (Twitter) post. Preserve @mentions, hashtags, URLs, and emoji as-is. Translate only the human-readable prose; do not translate metrics like view counts or dates.',
};
