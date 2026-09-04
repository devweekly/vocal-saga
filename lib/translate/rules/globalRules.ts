import type { SiteRule } from './types';

/**
 * 全局展示期噪声规则 —— 对所有站点生效，不按 host 匹配。
 *
 * ## 为什么需要这一层
 *
 * 站点专属规则（SiteRule.removeSelectors）按 `hostPattern` 精确匹配，目前只注册了
 * 十几个站点。新站点翻译出来时，OneTrust Cookie 横幅、通用 modal 遮罩、`form` 订阅弹窗
 * 这类"千站一面"的噪声不会被清掉——因为那些选择器写死在各自站点的规则里，匹配不到
 * 别的主机。
 *
 * 这一层把**高置信、跨站通用**的噪声选择器收拢到一起，由 `applySiteDisplayRules`
 * 在应用站点专属规则**之前**统一打 `data-fanyi-remove` 标记，从而对任意站点自动生效，
 * 不必逐站注册。
 *
 * ## 选择器取舍（关键）
 *
 * 只收"几乎只可能出现在噪声里"的选择器，避免误删正文：
 *   - ✅ OneTrust / Cookie Law：被成千上万站点共用的同源组件，一条覆盖一片；
 *   - ✅ 通用 modal 遮罩（`[role="dialog"]`、`.modal-backdrop` 等）：弹窗几乎必带；
 *   - ✅ 订阅弹窗：按 `form[action*=newsletter]` 和 `*--popup/--modal/--overlay` 类名
 *     收窄，不碰正文里恰好含 "newsletter" 字样的普通元素。
 *   - ❌ 不放付费墙裸 class（如 `[class*="paywall"]`）、不放宽泛的
 *     `[class*="newsletter"]`：这些可能包裹正文内容，误删风险高，留给站点专属规则处理。
 *
 * 命中元素统一由 injectTranslationCss 注入的
 * `[data-fanyi-remove="true"]{display:none!important}` 兜底隐藏。
 */
export const GLOBAL_RULE: SiteRule = {
  // '*' 仅作语义标记，本规则不进 RULES 数组（避免抢在站点专属规则前 first-match），
  // 而是由 applySiteDisplayRules 始终叠加应用。
  hostPattern: '*',
  removeSelectors: [
    // —— OneTrust Cookie 同意（成千上万站点共用的同源组件，一条覆盖一片）——
    '#onetrust-consent-sdk',
    '#onetrust-banner-sdk',
    '#onetrust-pc-sdk',
    'section#ot-fltr-modal',
    '[id*="onetrust" i]',
    '[class*="onetrust" i]',
    // —— 通用 Cookie / 同意横幅（各站点自有实现，模式收敛）——
    '[id*="cookie-consent" i]',
    '[class*="cookie-banner" i]',
    '[class*="cookie-consent" i]',
    '[class*="cookie-notice" i]',
    '[id*="cookie-notice" i]',
    '#sp_message_container',
    'iframe[id*="sp_message" i]',
    '[id*="cookielaw" i]',
    // —— 通用 modal / 弹窗遮罩（div 形式的弹窗；<dialog> 标签已由通用层处理）——
    '[role="dialog"]',
    '.modal-backdrop',
    '[class*="modal-backdrop" i]',
    '[class*="modal__backdrop" i]',
    '[class*="modal-overlay" i]',
    '[id*="modal-overlay" i]',
    // —— 浮动订阅弹窗（按 action / 显式 popup 类名收窄，避免误伤正文）——
    'form[action*="newsletter" i]',
    '[class*="newsletter-popup" i]',
    '[class*="newsletter-modal" i]',
    '[class*="newsletter-overlay" i]',
  ],
};
