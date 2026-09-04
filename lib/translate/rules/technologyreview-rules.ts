import type { SiteRule } from './types';

/**
 * MIT Technology Review（technologyreview.com）站点规则。
 *
 * ## 问题背景（article/560 反馈：各种弹出框）
 *
 * MIT Tech Review 文章页 SSR 出来的 DOM 里同时塞了三类噪声：
 *   1. **站点 header 重复渲染**：`header.headerTemplate__container` 与 article header
 *      并存，正文上方出现两次导航条，视觉上像"弹出了第二个 header"；
 *   2. **sticky 侧边栏 + 热门推荐**：右侧 `sidebar__wrapper` 用 `position:sticky`
 *      浮在正文旁，离线阅读时挤掉正文宽度；
 *   3. **嵌入正文里的订阅/广告**：正文中穿插 `form.stayConnected__form` 订阅表单、
 *      `related__wrap` 相关推荐、`.adUnit` 广告位。
 *
 * 这些文本早已翻译过并存进 D1，重新跑翻译 pipeline 不划算。展示期直接打
 * `data-fanyi-remove` 标记即可，由 TRANSLATION_CSS 注入的
 * `[data-fanyi-remove="true"]{display:none!important}` 兜底隐藏。
 *
 * 选择器说明：MIT Tech Review 使用 hash 化的 BEM 类名（如
 * `headerTemplate__container--ecd80005f4f4080205fa3a10b73ba2fd`），hash 部分
 * 会随部署变化。这里用稳定前缀 `class*="xxx"` 做模糊匹配，避免被 hash 变更击穿。
 */
export const technologyreviewRule: SiteRule = {
  hostPattern: '*.technologyreview.com',
  removeSelectors: [
    // 站点 header（与 article header 重复）
    '[class*="headerTemplate__container" i]',
    // 右侧 sticky 侧边栏（"Popular" 热门文章）
    'aside[class*="sidebar__wrapper" i]',
    // 正文中穿插的相关推荐
    'aside[class*="related__wrap" i]',
    // 内嵌订阅表单（"Stay Connected"）
    'form[class*="stayConnected__form" i]',
    // 广告位（leaderboard / right-rail / footer）
    '[class*="adUnit" i]',
    '[class*="adunitContainer" i]',
  ],
};