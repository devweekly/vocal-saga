import type { SiteRule } from './types';

/**
 * InfoQ（infoq.com）站点规则。
 *
 * ## 问题背景（article/535 反馈：去掉弹出框 + 底部大广告）
 *
 * InfoQ 文章页里有三类展示期噪声：
 *
 * 1. **登录拦截弹窗**：`div.modal_auth_required`（"Unlock the full InfoQ
 *    experience"）+ `div.modal__backdrop` 背景遮罩。原文是 div 不是 `<dialog>`，
 *    通用 `applyGlobalNoiseFromUrl` 不会清掉。
 *
 * 2. **浮动订阅表单**：右下角浮窗 `form#floatingNewsletterForm`（用户截图里
 *    看到的右侧 "InfoQ Software Architects' Newsletter" 邮件订阅卡）。
 *    还有一个 `form#dataCollectCampaignNewsletterForm` 是活动推广订阅。
 *
 * 3. **底部大广告区**：正文下方 `div.newsletter.widget`（"The InfoQ Newsletter"）
 *    一栏占了半个屏幕高，离线阅读时既冗余又遮挡正文结尾。
 *
 * 选择器说明：InfoQ 也使用 hash 化的 BEM 类名，这里尽量用稳定 id 或
 * 稳定前缀（`newsletter`）做模糊匹配。
 */
export const inforqRule: SiteRule = {
  hostPattern: '*.infoq.com',
  removeSelectors: [
    // 登录拦截弹窗（div，不是 <dialog>，通用规则不会清）
    '.modal_auth_required',
    '.modal_auth_required__content',
    '.modal_auth_required__actions',
    '.modal__backdrop',
    '.modal',
    // 浮动/活动订阅表单（用户截图里右下的订阅卡）
    '#floatingNewsletterForm',
    '#dataCollectCampaignNewsletterForm',
    'div.newsletter__subscribe',
    // 底部"InfoQ Newsletter"大广告区
    'div.newsletter.widget',
  ],
};