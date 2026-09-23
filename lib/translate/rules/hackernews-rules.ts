import type { SiteRule } from './types';

export const hackernewsRule: SiteRule = {
  hostPattern: 'news.ycombinator.com',
  documentTerms: [
    'Hacker News',
    'new',
    'past',
    'comments',
    'hide',
    'favorite',
    'flag',
    'upvote',
    'points',
    'user',
    'about',
    'favorite',
    'submit',
    'show',
    'ask',
    'jobs',
    'threads',
    'guidelines',
    'FAQ',
    'API',
    'Security',
    'YC',
    'Startup',
    'Book',
    'Login',
  ],
  skipSelectors: [
    // --- 投票 / 排名 / 元信息（故事头部） ---
    '.votelinks',
    '.rank',
    '.score',
    '.subtext',
    // --- 评论头部（作者 / 时间 / prev-next 导航）与 "reply" 链接 ---
    // 必须显式剪枝：`.reply` 里的 <p><font><u><a>reply</a> 会让 <p> 走
    // DIRECT_SET 分支单独成块，译文里冒出一个孤立的 "reply" 块。
    '.comhead',
    '.pagetop',
    '.reply',
    // --- 代码块保持原样（不破坏语法） ---
    // 注意：这两个**不能**进 excludeFromTextSelectors —— HN 评论里大量
    // 行内 <code>（如 `std::map`）是正文的一部分，剔除会让句子残缺。
    'code',
    'pre',
  ],
  // HN 用嵌套 <table> 做整页布局（#hnmain > tr > td > table.fatitem /
  // table.comment-tree）。不开启这项，SKIP_SET 会把整棵 table 子树剪掉，
  // 整页抽取结果为 0 个块。
  translateTables: true,
  // 正文块：HN 的「一段正文」是 div.commtext 里**裸文本 + 嵌套 <p>** 混排
  // （首段是裸文本，后续段落才是 <p>）。必须整体抓取，否则首段会整个丢失。
  // `.titleline` 是故事标题（`<a>` + 站点名 span）——HN 没有 <article> 语义，
  // 不显式声明的话标题抓不到（span 走 INLINE_SET 分支要求 isInsideArticle）。
  blockSelectors: ['.commtext', '.titleline'],
  // 这些是包裹层里唯一的文本，不剔除的话「只剩导航」的容器
  // （div[style="margin-top:2px…"] / 顶栏 <td>）会被判为有效块抓出来翻译。
  excludeFromTextSelectors: ['.comhead', '.pagetop', '.reply'],
  promptInstructions:
    'This is Hacker News. Keep navigation terms, voting-related vocabulary, YC-specific terminology, and code snippets untranslated. Comment threads are the primary content: translate them faithfully and preserve the conversational tone.',
};
