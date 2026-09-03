import type { SiteRule } from './types';

/**
 * O'Reilly Radar（oreilly.com）站点规则。
 *
 * Radar 文章页是经典的「正文 + 右侧 rail」两栏布局：
 *   - `#right-rail` 里塞满平台推广（Try the O'Reilly learning platform）、
 *     课程推荐、Newsletter 订阅表单，高度往往比正文还长；
 *   - 离线阅读时这些推广毫无意义，还会把正文挤到左侧窄条里。
 *
 * 因此在展示阶段直接隐藏右侧 rail。正文区域（`#main` / `article`）不受影响。
 *
 * 注意：这里用 removeSelectors 而不是 skipSelectors —— 这些推广文本早就
 * 翻译过并存进 D1 了，重翻一遍不划算，展示期隐藏即可。
 */
export const oreillyRule: SiteRule = {
  hostPattern: '*.oreilly.com',
  // 展示期隐藏右侧推广栏
  removeSelectors: [
    '#right-rail',
    // 部分模板用 class 而非 id
    'div.sidebar',
    // 正文下方的「Related」推荐区与订阅 CTA
    '[data-testid="related-content"]',
  ],
};
