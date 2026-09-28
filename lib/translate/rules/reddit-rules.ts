import type { SiteRule } from './types';

export const redditRule: SiteRule = {
  // 通配符形式同时匹配 reddit.com（裸域）与 www.reddit.com 等子域。
  // 历史教训：曾写成 'reddit.com'，而 hostMatches 对非通配 pattern 做全等
  // 比较 —— 用户实际访问的 www.reddit.com 从未命中，整份 Reddit 规则
  // （含 skipSelectors / articleRootSelector）形同虚设（2026-09-28 确认）。
  hostPattern: '*.reddit.com',
  // Layer 0 最高优先级：直接钉住正文根。
  //
  // 为什么必须显式声明：Reddit 把每条评论渲染成
  // <details role="article">（shreddit-comment 内部，2026-09 验证），
  // 而 contentHelper 的 Layer 1 选择器列表里 '[role="article"]' 的优先级
  // 高于 'main' —— 于是「textContent 最长的评论子树」被当成文章根；
  // 随后 chooseBestRoot 的评分又偏爱文本密集、按钮少的评论容器
  // （main 因"按钮过多"被扣分），两层都会把根选进评论区。
  // 结果：主帖 shreddit-post 整体在根外，正文一段都不翻译
  // （症状：评论区双语正常、主帖正文纯英文，线上 /article/739 实测）。
  // main#main-content 是 post 页唯一同时包含主帖与评论区的稳定锚点。
  articleRootSelector: 'main#main-content',
  documentTerms: [
    'Home',
    'Hot',
    'New',
    'Top',
    'Rising',
    'Reddit',
    'Subreddit',
    'Upvote',
    'Downvote',
    'Karma',
    'Award',
    'Share',
    'Save',
    'Report',
    'Crosspost',
    'Moderator',
    'Admin',
    'Post',
    'Comment',
    'Sort by',
    'Best',
    'Controversial',
  ],
  skipSelectors: [
    // 注意：这里绝不能加 'shreddit-comment' —— shouldSkipBySiteRules 用
    // closest() 匹配且命中后整棵子树拒绝（REJECT），加了等于放弃整个评论区。
    // 历史上它确实存在过，但因为 hostPattern 的全等 bug 从未生效；
    // 修好 hostPattern 时若保留它，评论会从"能翻"变成"整树剪枝"。
    'faceplate-blot',
    '[data-click-id="score"]',
  ],
  // Sentry SDK injects its chunk preload list as a <p> in the DOM. Filter
  // it out so we don't ship it to the translation model.
  skipTextPatterns: [
    '^SML\\.load\\s*\\(\\s*\\[',
  ],
  promptInstructions:
    'This is a Reddit page. Keep community-specific terms, subreddit names, UI labels like "upvote/downvote/karma", and usernames untranslated.',
};
