import type { SiteRule } from './types';

/**
 * Stack Overflow Blog（stackoverflow.blog）站点规则。
 *
 * ## 问题背景（article/544 反馈：布局混乱 + 弹出框）
 *
 * Stack Exchange 旗下站点统一挂载 OneTrust Cookie Consent SDK。SSR HTML 里
 * 直接嵌入了：
 *   - `div#onetrust-consent-sdk`：左下角 Cookie 同意横幅（用户截图里能看到
 *     "By clicking 'Accept all cookies'…" 那块淡紫色面板）；
 *   - `div#onetrust-pc-sdk`：Cookie 偏好中心 modal（`aria-modal="true"`）；
 *   - `section#ot-fltr-modal`：偏好中心里的筛选弹窗。
 *
 * 这些不是 generic 的 `aside`/`dialog`，所以 `applyGlobalNoiseFromUrl` 的
 * 通用兜底不会清掉，必须显式列出来。
 *
 * 另外博客页还有一个 `aside.flex--item3.pt12` 推 Podcast 订阅，离线阅读
 * 时无意义，一并清掉。
 */
export const stackoverflowblogRule: SiteRule = {
  hostPattern: 'stackoverflow.blog',
  removeSelectors: [
    // OneTrust Cookie 同意横幅（左下角浮窗）
    '#onetrust-consent-sdk',
    '#onetrust-banner-sdk',
    // Cookie 偏好中心 modal
    '#onetrust-pc-sdk',
    'section#ot-fltr-modal',
    // 博客侧栏 Podcast 订阅
    'aside.flex--item3.pt12',
  ],
};