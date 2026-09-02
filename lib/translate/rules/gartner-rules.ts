import type { SiteRule } from './types';

/**
 * Gartner 新闻稿页（Adobe Experience Manager 生成）正文结构特征：
 * - 正文被切成 9 个 <article class="article-text ..."> **兄弟碎片**，各自含一段，
 *   共同祖先是 div.aem-Grid（该 div 同时包含 h1 标题与全部 9 个碎片）。
 * - 服务端（vocal-saga）用 linkedom 解析，其检测器（Readability + 文本密度评分 +
 *   body 兜底）已能在无规则时正确选到 div.aem-Grid 并提取 103 blocks（已验证）。
 * - 但为消除 linkedom 解析 AEM 复杂 HTML 的潜在脆弱性（属性偶发损坏）导致
 *   "No translatable content found" 的风险，这里用站点规则**确定性锁定**正文根。
 *   与 fanyi-extension 的 gartnerRule 保持逐字节一致，确保两端行为对称。
 *
 * 选择器用 [class*="aem-Grid"] 而非 div.aem-Grid：aem-Grid 是 AEM 页面布局网格，
 * 文档顺序中第一个匹配项即包裹整篇（h1 + 9 碎片）的顶层网格，直接作为 article
 * root 跳过启发式扩展。该属性选择器已在 linkedom（服务端）与 jsdom（扩展测试）
 * 下均验证可稳定解析。
 */
export const gartnerRule: SiteRule = {
  hostPattern: '*.gartner.com',
  articleRootSelector: '[class*="aem-Grid"]',
};
