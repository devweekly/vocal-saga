import type { SiteRule } from './types';

/**
 * CNN（edition.cnn.com / www.cnn.com）站点规则。
 *
 * ## 问题背景（article/556 反馈：布局错误）
 *
 * CNN 文章页 SSR 出来的 DOM 在代理域下出现两类严重的渲染噪声：
 *
 * 1. **导航栏三重复制**：
 *    - 顶部 `nav#pageHeader`（主导航，含 Arts/Design/Fashion…）
 *    - 紧接着又一个 `nav.header__nav`（移动端折叠菜单，桌面端也会输出）
 *    - 页脚 `footer#pageFooter` 又把 `Live TV / Listen / Watch`、
 *      `Edition / US / International / Arabic`、
 *      `My Account / Settings / Newsletters / Topics you follow / Sign out`
 *      全部重新渲染一遍
 *    三层叠加后用户截图里能看到每个导航项出现三次，像"布局坏了"。
 *
 * 2. **关闭按钮被放大的下载弹窗**：
 *    `dialog#GooglePlayDialog` 和 `dialog#AppStoreDialog` 是"下载 CNN App"
 *    的 QR 码弹窗，CSS 缺失时关闭按钮（`.download-dialog__close-button`）
 *    渲染成巨大的 ✕ 图标覆盖整个屏幕。
 *
 * 修复策略（removeSelector 打 data-fanyi-remove 标记 + displayCss 兜底）：
 *   - 删掉两个 download-dialog（及其内部的 header/footer）和 ad 反馈弹窗；
 *   - 删掉重复的 `nav.header__nav`（保留 `nav#pageHeader`）和
 *     `nav.user-account-nav` / `nav.header__editionizer`（页脚中已有同样内容）；
 *   - 删掉 `footer#pageFooter`（与导航重复，且离线阅读用不到）；
 *   - 删掉 follow-topics-bar 浮动栏与所有 subscribe 按钮；
 *   - displayCss 兜底处理 `ad-slot-rail` 侧栏广告（不在 removeSelectors 里
 *     的，因为它是 grid 容器，单独走 CSS 更稳）。
 */
export const cnnRule: SiteRule = {
  hostPattern: '*.cnn.com',
  removeSelectors: [
    // 下载 App 弹窗（QR 码 + 巨大的关闭 ✕）
    'dialog#GooglePlayDialog',
    'dialog#AppStoreDialog',
    '.download-dialog',
    // 广告反馈弹窗
    '#ad-feedback__modal-overlay',
    '.ad-feedback__modal',
    // 重复的主导航（保留 nav#pageHeader）
    'nav.header__nav',
    // 用户账户导航（页脚中重复渲染）
    'nav.user-account-nav',
    // 版本切换器（页脚中重复渲染）
    'nav.header__editionizer',
    // 关注话题浮动栏
    '.follow-topics-bar_overlay',
    '.follow-topics-bar',
    // 订阅按钮（顶部 + 页脚桌面/移动）
    '#headerSubscribeButton',
    '#footerSubscribeButtonMobile',
    '#footerSubscribeButtonDesktop',
    '.header__subscribe-button',
    '.footer__subscribe-button',
    // 页脚（重复的导航 + 离线用不到）
    'footer#pageFooter',
  ],
  displayCss: [
    // ad-slot-rail 侧栏广告 grid 容器：用 CSS 隐藏，避免与 removeSelectors
    // 选择器冲突（其内部子元素也可能被打标，CSS 兜底更稳）
    '.ad-slot-rail_right,',
    '.ad-slot-rail__container {',
    '  display: none !important;',
    '}',
  ].join('\n'),
};