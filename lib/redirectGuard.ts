/**
 * 重定向守卫（redirect guard）。
 *
 * 背景：翻译页面直接回吐原站点的 HTML，其中往往带有原站的 SPA 入口脚本。
 * 这些脚本会在浏览器里运行，并按自身 URL 逻辑去请求原站 API（跨域），
 * 触发 CORS 失败后把页面渲染成错误视图（例如 X/Twitter 的
 * "Something went wrong"）。典型链路：
 *   s.sunxiunan.com/97 → 原 X 页面 HTML → entry-client-logged-out.js
 *   → 读 location.pathname("/97") 当作 screenName → fetch api.x.com → CORS 失败
 *
 * 解决思路：vocal-saga 在返回 HTML 前，注入一段自己的 monkey-patch 脚本到
 * <head> 最前面（早于原站任何脚本执行），把所有会导致"离开当前页"的导航 API
 * 硬拦截掉。原站的展示性脚本（折叠、懒加载等）照常运行，只是无法把用户带走。
 *
 * 注意：这段脚本由 vocal-saga 注入，不是原站点自带的。
 */

/**
 * 注入到页面的守卫脚本源码。
 *
 * 设计要点：
 *   1. 在 try/catch 里逐项 patch，任何一项失败不影响其它项
 *   2. 同时拦截「编程式导航」（location / history / window.open）和
 *      「文档级跳转」（meta refresh）
 *   3. 静默吞掉，不抛错——原站 SPA 跑挂也无所谓，用户留在翻译页即可
 *
 * 导出供测试直接执行验证（生产环境通过 injectRedirectGuard 注入 <script>）。
 */
export const REDIRECT_GUARD_SCRIPT = `
(function () {
  if (window.__vsRedirectGuard) return; // 防重复注入
  window.__vsRedirectGuard = true;

  // ── 1. 编程式导航：location 写入 / assign / replace ──
  try {
    window.location.assign = function () { /* vocal-saga: 已拦截 location.assign */ };
    window.location.replace = function () { /* vocal-saga: 已拦截 location.replace */ };
    // location.href 是访问器属性，尝试重定义 setter 吞掉写操作；
    // 某些浏览器（如 Firefox）不允许重定义 location.href，失败时静默忽略。
    try {
      var origHref = window.location.href;
      Object.defineProperty(window.location, 'href', {
        configurable: true,
        get: function () { return origHref; },
        set: function () { /* vocal-saga: 已拦截 location.href 跳转 */ }
      });
    } catch (e) {}
  } catch (e) {}

  // ── 2. History API：pushState / replaceState ──
  // 这些不会真的离开页面，但原站 SPA 会借它做客户端路由初始化，
  // 进而触发后续 API 调用。直接吞掉，保持地址栏不变。
  try {
    if (window.history) {
      ['pushState', 'replaceState'].forEach(function (m) {
        window.history[m] = function () { /* vocal-saga: 已拦截 history. */ + m; };
      });
    }
  } catch (e) {}

  // ── 3. window.open ──
  try {
    window.open = function () { return null; };
  } catch (e) {}

  // ── 4. 文档级跳转：<meta http-equiv="refresh"> ──
  // 删除已存在的，并监控后续注入
  try {
    document.querySelectorAll('meta[http-equiv="refresh" i]').forEach(function (m) { m.remove(); });
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        r.addedNodes.forEach(function (n) {
          if (n && n.tagName === 'META' && /^refresh$/i.test(n.getAttribute('http-equiv') || '')) {
            n.remove();
          }
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
})();
`;

/**
 * 把重定向守卫脚本注入到 HTML 的 <head> 最前面。
 *
 * 注入策略：
 *   - 有 <head>：插到 head 第一个子节点前，保证最早执行
 *   - 无 <head> 但有 <html>：在 <html> 开头补一个 <head>
 *   - 都没有（HTML 片段）：直接在开头拼接脚本
 *
 * @param html 原始 HTML 字符串
 * @returns 注入守卫后的 HTML 字符串
 */
export function injectRedirectGuard(html: string): string {
  const scriptTag = `<script>${REDIRECT_GUARD_SCRIPT}</script>`;

  // 情况 1：有 <head ...> 标签 → 插到 head 内最前面
  const headOpenMatch = html.match(/<head(\s[^>]*)?>/i);
  if (headOpenMatch) {
    const insertAt = headOpenMatch.index! + headOpenMatch[0].length;
    return html.slice(0, insertAt) + scriptTag + html.slice(insertAt);
  }

  // 情况 2：有 <html ...> 但没 <head> → 在 html 标签后补一个 head
  const htmlOpenMatch = html.match(/<html(\s[^>]*)?>/i);
  if (htmlOpenMatch) {
    const insertAt = htmlOpenMatch.index! + htmlOpenMatch[0].length;
    return html.slice(0, insertAt) + `<head>${scriptTag}</head>` + html.slice(insertAt);
  }

  // 情况 3：HTML 片段，无结构标签 → 直接前置拼接
  return scriptTag + html;
}
