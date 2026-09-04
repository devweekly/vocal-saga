/**
 * 站点展示期规则 —— 作用在"已经翻译完、准备渲染给用户看"的 HTML 上。
 *
 * ## 为什么需要单独一层
 *
 * 已有的站点规则（skipSelectors / documentTerms / articleRootSelector）都作用在
 * **翻译前**的抽取阶段。但 D1 里存的历史缓存是几个月前翻译的，当时还没有这些规则；
 * 重翻一遍代价高（LLM 费用 + 时间），而用户只想"把右侧栏藏掉""把正文列加宽"。
 * 展示期规则只改 DOM 属性 / 追加 CSS，不碰译文，因此可以直接作用于历史缓存。
 *
 * ## 与 applyGlobalNoiseFromUrl 的分工
 *
 * - `applyGlobalNoiseFromUrl`：通用噪声（aside / fixed 底部栏 / 浮动分享栏）+ x.com 特例
 * - `applySiteDisplayRules`：SiteRule 上显式声明的站点专属配置（本文件）
 *
 * 两者都在 /article/:id 的渲染链路上，互不覆盖。
 */

import { parseHTML } from 'linkedom';
import { matchSiteRule } from './rules';
import { GLOBAL_RULE } from './rules/globalRules';
import type { SiteRule } from './rules/types';

/**
 * 对已渲染 HTML 应用站点展示期规则。
 *
 * @param html   待渲染的完整 HTML
 * @param pageUrl 页面原始 URL（用于匹配站点规则）
 * @returns 应用规则后的 HTML；无匹配规则或解析失败时原样返回
 */
export function applySiteDisplayRules(html: string, pageUrl: string): string {
  // 空 URL：无法确定站点，也无全局噪声可应用，直接原样返回
  if (!pageUrl) return html;
  const matched = matchSiteRule(pageUrl);
  // 全局规则（GLOBAL_RULE）始终生效；命中站点专属规则时两者都应用，
  // 站点专属规则排在后面，优先级更高（displayCss 后追加、removeSelectors 叠加）。
  const rules = [GLOBAL_RULE, ...(matched ? [matched.siteRule] : [])];
  const applicable = rules.filter(hasDisplayConfig);
  if (applicable.length === 0) return html;

  try {
    const { document } = parseHTML(html) as unknown as { document: Document };
    if (!document.documentElement) return html;

    for (const rule of applicable) {
      markRemoveSelectors(document, rule.removeSelectors);
      appendDisplayCss(document, rule.displayCss);
      appendDisplayJs(document, rule.displayJs);
    }

    return '<!doctype html>\n' + document.documentElement.outerHTML;
  } catch {
    // 解析失败保持原 HTML，不破坏现有渲染
    return html;
  }
}

/** 该站点规则是否配置了任何展示期行为（没有就不必解析 DOM） */
function hasDisplayConfig(rule: SiteRule): boolean {
  return Boolean(
    (rule.removeSelectors && rule.removeSelectors.length > 0) ||
      rule.displayCss ||
      rule.displayJs,
  );
}

/**
 * 给命中 removeSelectors 的元素打隐藏标记。
 * 由页面自带的 `[data-fanyi-remove="true"]{display:none!important}` 规则隐藏。
 */
function markRemoveSelectors(doc: Document, selectors: string[] | undefined): void {
  if (!selectors || selectors.length === 0) return;
  for (const selector of selectors) {
    const trimmed = selector.trim();
    if (!trimmed) continue;
    let nodes: ArrayLike<Element>;
    try {
      nodes = doc.querySelectorAll(trimmed);
    } catch {
      // 非法选择器直接跳过，不影响其余规则
      continue;
    }
    Array.from(nodes).forEach((el) => {
      el.setAttribute('data-fanyi-remove', 'true');
    });
  }
}

/**
 * 把站点 CSS 追加到 <head> 末尾。
 * 追加而非插入：确保站点样式优先级高于原页面样式和通用双语样式。
 */
function appendDisplayCss(doc: Document, css: string | undefined): void {
  if (!css || !css.trim()) return;
  const style = doc.createElement('style');
  style.setAttribute('data-fanyi-site-css', 'true');
  style.textContent = css;
  (doc.head || doc.documentElement).appendChild(style);
}

/**
 * 把站点 JS 追加到 <body> 末尾。
 * 放在最后执行，确保 DOM 已就绪（包括前面注入的噪声标记）。
 */
function appendDisplayJs(doc: Document, js: string | undefined): void {
  if (!js || !js.trim()) return;
  const script = doc.createElement('script');
  script.setAttribute('data-fanyi-site-js', 'true');
  script.textContent = js;
  (doc.body || doc.documentElement).appendChild(script);
}
