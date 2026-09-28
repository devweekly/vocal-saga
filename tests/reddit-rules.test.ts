// 回归测试：Reddit 站点规则的 host 匹配与规则数据完整性。
//
// 回归背景（2026-09-28，线上 /article/739 实测）：
//   1. hostPattern 曾写成 'reddit.com'，而 hostMatches 对非通配 pattern 做
//      全等比较 —— 用户实际访问的 www.reddit.com 从未命中，整份 Reddit 规则
//      （skipSelectors / articleRootSelector / promptInstructions）形同虚设。
//      修复后必须用通配符 '*.reddit.com'（同时覆盖裸域与 www 等子域）。
//   2. Reddit 把每条评论渲染成 <details role="article">，扩展端 Layer 1 的
//      '[role="article"]' 选择器优先级高于 'main'，会把文章根选进评论区，
//      导致主帖 shreddit-post 整体不翻译（评论区双语正常，极具迷惑性）。
//      扩展端以 articleRootSelector: 'main#main-content' 修复（Layer 0）；
//      服务端 /fanyi/page 链路的根选择发生在扩展端，此处只锁定规则数据。
import { describe, it, expect } from 'vitest';
import { matchSiteRule } from '../lib/translate/rules';
import { redditRule } from '../lib/translate/rules/reddit-rules';

describe('Reddit 站点规则', () => {
  it('www.reddit.com 与裸域 reddit.com 都必须命中（hostPattern 通配）', () => {
    expect(matchSiteRule('https://www.reddit.com/r/ExperiencedDevs/comments/1wql3g2/x/')?.siteRule).toBe(redditRule);
    expect(matchSiteRule('https://reddit.com/r/ExperiencedDevs/comments/1wql3g2/x/')?.siteRule).toBe(redditRule);
    // 其它子域（old.reddit.com 等）同样命中
    expect(matchSiteRule('https://old.reddit.com/r/ExperiencedDevs/comments/1wql3g2/x/')?.siteRule).toBe(redditRule);
  });

  it('规则数据：articleRootSelector 钉住 main，评论容器不在 skipSelectors', () => {
    // articleRootSelector 必须指向同时包含主帖与评论区的 main 锚点
    expect(redditRule.articleRootSelector).toBe('main#main-content');
    // skipSelectors 绝不能含 'shreddit-comment'：
    // shouldSkipBySiteRules 用 closest() 匹配且命中后整棵子树拒绝（REJECT），
    // 加了等于放弃整个评论区（见扩展端 reddit-rules.ts 同名注释）。
    expect(redditRule.skipSelectors).not.toContain('shreddit-comment');
  });
});
