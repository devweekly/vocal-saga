import type { SiteRule } from './types';

/**
 * Towards Data Science（towardsdatascience.com）站点规则。
 *
 * ## 问题背景（article/579 反馈：样式乱了、图片超大）
 *
 * TDS 是 Next.js + Tailwind 站点，正文布局完全依赖 Tailwind 工具类
 * （`flex` / `w-full` / `object-cover` / `absolute inset-0` 等），样式来自
 * 内容哈希 CSS `<link href="/assets/app-xxxx.css">`。
 *
 * 翻译结果页在代理域下打开时，这个相对路径解析到 `s.sunxiunan.com/assets/...`
 * 直接 404，Chrome ORB 把整张样式表拦掉 → 所有 Tailwind 类失效：
 *   - 容器塌成内容宽度，顶部导航变成一堆裸蓝色链接；
 *   - 封面图用 `class="w-full absolute inset-0 h-full object-cover"` 绝对定位
 *     铺满父容器，父容器无高度时图片按原始像素（637×1024 / 超宽）渲染，
 *     撑出横向滚动条，视觉上就是"超大灰色大图"。
 *
 * 修复策略（展示期 displayCss 兜底）：
 *   - 图片强制 `position:static + max-width:100% + height:auto`，撤销绝对定位、
 *     压回容器内，解决"图片超大"；
 *   - 正文容器设 `max-width:720px` 居中，恢复可读阅读宽度；
 *   - 顶部品牌栏（Tailwind 缺失时退化为裸链接）与 Cookie 横幅弱化隐藏，
 *     清理视觉噪声。只打站点特有的窄选择器，避免误伤正文内的 header/nav。
 *
 * 注意：这只是"让历史缓存能读"的兜底。真正的根因是外链 CSS 404，长期应让
 * cssInliner 把 CSS 内联进缓存（见 lib/translate/cssInliner.ts，目前未接线）。
 * 一旦内联生效，本规则的兜底 CSS 不会与之冲突（都带 !important，且只做最小修复）。
 */
export const towardsdatascienceRule: SiteRule = {
  hostPattern: 'towardsdatascience.com',
  displayCss: [
    // 1) 图片兜底：撤销绝对定位 + 压回容器，解决"超大灰图"
    'img {',
    '  position: static !important;',
    '  max-width: 100% !important;',
    '  height: auto !important;',
    '  width: auto !important;',
    '}',
    // 2) 正文阅读宽度：原站 max-w-article ≈ 680~720px，离线居中
    'article.mx-auto, article {',
    '  max-width: 720px !important;',
    '  margin-left: auto !important;',
    '  margin-right: auto !important;',
    '}',
    // 3) 清理视觉噪声：仅打站点特有选择器，避免误伤正文
    //    顶部品牌栏（bg-brand 在 Tailwind 缺失时退化为裸链接）+ Cookie 横幅
    'header.bg-brand {',
    '  display: none !important;',
    '}',
    '[class*="cookie" i], [id*="cookie" i] {',
    '  display: none !important;',
    '}',
  ].join('\n'),
};
