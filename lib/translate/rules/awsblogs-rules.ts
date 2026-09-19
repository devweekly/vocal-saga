import type { SiteRule } from './types';

/**
 * AWS Blogs（aws.amazon.com/blogs/...）站点规则。
 *
 * ## 问题背景（article/676 反馈：网页上固定浮动一个 AWS banner）
 *
 * AWS Blogs 文章页在 DOM 里放了两个 `position:fixed` 的浮层：
 *   1. **子导航条**：`#m-subnav`（`data-testid="subnav-desktop"`），内容就是
 *      "AWS Blogs / Home / Blogs / Editions"。它的 CSS 是
 *      `position:fixed; top:16px; z-index:5000; --subnav-voffset:125px`，
 *      离线阅读时永远悬在正文上方，挡住标题和正文；
 *   2. **右下角反馈按钮**：`[data-testid="feedback-button"]`，
 *      `position:fixed; top:50%; right:...; z-index:5000`。
 *
 * 二者文本早已翻译并存进 D1，重新跑 pipeline 不划算。展示期直接打
 * `data-fanyi-remove` 标记即可，由 TRANSLATION_CSS 注入的
 * `[data-fanyi-remove="true"]{display:none!important}` 兜底隐藏。
 *
 * 选择器说明：AWS 用的是 hash 化类名（`rgsn_359d1dc8` / `rggn_65f0a205`），
 * hash 会随发版变化，所以这里只认稳定的 id / data-testid。
 * 子导航是 `position:fixed` 而非 sticky，隐藏后不会留下占位空隙。
 */
export const awsblogsRule: SiteRule = {
  hostPattern: 'aws.amazon.com',
  removeSelectors: [
    // 固定浮动的子导航条（AWS Blogs / Home / Blogs / Editions）
    '#m-subnav',
    '#subnav-desktop',
    '[data-testid="subnav-desktop"]',
    // 移动端展开的子导航
    '#mobile-subnav-expanded',
    '[data-testid="mobile-subnav-expanded"]',
    // 右下角固定反馈按钮
    '#feedback-button',
    '[data-testid="feedback-button"]',
  ],
  // 兜底：万一 id/testid 变更，也把这两个固定层压掉
  displayCss: `
/* AWS Blogs：隐藏固定浮动的子导航与反馈按钮 */
#m-subnav,
[data-testid="subnav-desktop"],
#mobile-subnav-expanded,
[data-testid="mobile-subnav-expanded"],
#feedback-button,
[data-testid="feedback-button"] {
  display: none !important;
}
`,
};
