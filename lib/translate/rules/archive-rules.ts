import type { SiteRule } from './types';

/**
 * archive.md（archive.today 镜像）站点规则。
 *
 * ## 问题背景
 *
 * archive.md 是 archive.today 的存档镜像页，在页面顶部注入了自带的
 * 黄色导航栏（#HEADER），包含 archive.today logo、搜索框、原始 URL、
 * 存档时间等信息。这个 banner 在离线展示时是纯噪声：
 *
 * - 占据首屏大量空间（min-width:1028px，黄色背景 + 红色底边）
 * - 与被存档的原文内容无关
 * - 用户在 fanyi 离线阅读模式下不需要存档工具栏
 *
 * ## 修复策略
 *
 * 使用 removeSelectors 在**展示期**隐藏 #HEADER（打 data-fanyi-remove 标记，
 * 由 TRANSLATION_CSS 的 display:none!important 生效）。
 *
 * 选择展示期而非抽取期（skipSelectors）的原因：
 * - HEADER 内无有价值的正文内容，两阶段效果相同
 * - 展示期规则可覆盖历史缓存，无需重翻
 */
export const archiveRule: SiteRule = {
  hostPattern: '*.archive.md',
  removeSelectors: [
    // archive.today 顶部导航栏（logo / 搜索框 / 原始 URL / 存档时间）
    '#HEADER',
  ],
};
