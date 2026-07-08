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
 * <head> 最前面（早于原站任何脚本执行），把会导致"离开当前翻译页"的导航 API
 * 拦截掉。同页 hash 导航、外部链接在新标签页打开、用户主动点击等正常行为
 * 尽量保留。
 *
 * 注意：这段脚本由 vocal-saga 注入，不是原站点自带的。
 */

/**
 * 注入到页面的守卫脚本源码。
 *
 * 设计要点：
 *   1. 在 try/catch 里逐项 patch，任何一项失败不影响其它项
 *   2. 只拦截「跨页跳转」（不同 origin 或不同 pathname），保留同页 hash 跳转
 *   3. window.open 的外部链接 / _blank 保持原行为，仅拦截在当前窗口打开的内部链接
 *   4. 静默吞掉自动跳转，不抛错——原站 SPA 跑挂也无所谓，用户留在翻译页即可
 *   5. MutationObserver 优先监听 <head>，降低性能开销
 *
 * 导出供测试直接执行验证（生产环境通过 injectRedirectGuard 注入 <script>）。
 */
export const REDIRECT_GUARD_SCRIPT = `
(function () {
  if (window.__vsRedirectGuard) return; // 防重复注入
  window.__vsRedirectGuard = true;

  var currentHref = window.location.href;
  var currentOrigin = window.location.origin;
  var currentPathname = window.location.pathname;

  /**
   * 判断 url 是否会导致离开当前页面（不同 origin 或不同 pathname）。
   * 空值/非法值视为不跳转。
   */
  function isCrossPage(url) {
    if (!url) return false;
    try {
      var parsed = new URL(url, currentHref);
      return parsed.origin !== currentOrigin || parsed.pathname !== currentPathname;
    } catch (e) {
      return false;
    }
  }

  /**
   * 判断 url 是否为外部链接（不同 origin）。
   */
  function isExternal(url) {
    if (!url) return false;
    try {
      return new URL(url, currentHref).origin !== currentOrigin;
    } catch (e) {
      return false;
    }
  }

  /**
   * 判断 url 是否只是同页 hash 跳转。
   */
  function isHashOnly(url) {
    if (!url) return false;
    try {
      var parsed = new URL(url, currentHref);
      return parsed.origin === currentOrigin &&
             parsed.pathname === currentPathname &&
             parsed.hash !== '';
    } catch (e) {
      return false;
    }
  }

  // ── 1. 编程式导航：location 写入 / assign / replace ──
  // 只拦截跨页跳转；同页 hash 跳转允许（原站 SPA 常用 hash 做状态，保留行为）。
  try {
    var loc = window.location;
    loc.assign = function (url) {
      if (isCrossPage(url)) {
        console.log('[vocal-saga] 拦截 location.assign:', url);
        return;
      }
      if (isHashOnly(url)) {
        try {
          loc.hash = new URL(url, currentHref).hash;
        } catch (e) {}
      }
    };
    loc.replace = function (url) {
      if (isCrossPage(url)) {
        console.log('[vocal-saga] 拦截 location.replace:', url);
        return;
      }
      if (isHashOnly(url)) {
        try {
          loc.hash = new URL(url, currentHref).hash;
        } catch (e) {}
      }
    };
    // location.href 是访问器属性，尝试重定义 setter 吞掉跨页写操作；
    // 某些浏览器（如 Firefox）不允许重定义 location.href，失败时静默忽略。
    try {
      Object.defineProperty(loc, 'href', {
        configurable: true,
        get: function () { return currentHref; },
        set: function (url) {
          if (isCrossPage(url)) {
            console.log('[vocal-saga] 拦截 location.href 跳转:', url);
            return;
          }
          if (isHashOnly(url)) {
            try {
              loc.hash = new URL(url, currentHref).hash;
              currentHref = loc.href;
            } catch (e) {}
          }
        }
      });
    } catch (e) {}
  } catch (e) {}

  // ── 1b. location.reload ──
  // SPA 循环跳转的最后手段：reload。直接吞掉，不真正刷新。
  try {
    var origReload = window.location.reload;
    window.location.reload = function () {
      console.log('[vocal-saga] 拦截 location.reload');
    };
  } catch (e) {}

  // ── 1c. history.go(0) / history.go(-0) ──
  // 等同于 reload，同样拦截。
  try {
    var origGo = window.history.go;
    window.history.go = function (delta) {
      if (delta === 0 || delta === -0) {
        console.log('[vocal-saga] 拦截 history.go(0)');
        return;
      }
      return origGo.apply(window.history, arguments);
    };
  } catch (e) {}

  // ── 1d. fetch guard ──
  // 拦截对 /cdn-cgi/ 等代理域下会 CORS 失败的请求，返回 fake 204，
  // 避免 SPA 因 fetch error 触发 reload。
  try {
    var origFetch = window.fetch;
    window.fetch = function () {
      var url = String(arguments[0] || '');
      if (url.indexOf('/cdn-cgi/') !== -1) {
        console.log('[vocal-saga] 拦截 fetch:', url);
        return Promise.resolve(new Response('', { status: 200 }));
      }
      return origFetch.apply(window, arguments);
    };
  } catch (e) {}

  // ── 2. History API：pushState / replaceState ──
  // 这些不会真的离开页面，但原站 SPA 会借它做客户端路由初始化，
  // 进而触发后续 API 调用。跨 pathname 时拦截；同 pathname/hash 保持原行为。
  try {
    if (window.history) {
      ['pushState', 'replaceState'].forEach(function (m) {
        var orig = window.history[m];
        window.history[m] = function (state, title, url) {
          if (url && isCrossPage(url)) {
            console.log('[vocal-saga] 拦截 history.' + m + ':', url);
            return;
          }
          return orig.apply(window.history, arguments);
        };
      });
    }
  } catch (e) {}

  // ── 3. window.open ──
  // 保留外部链接和 _blank 新窗口行为（用户主动打开），
  // 仅拦截在当前窗口打开且会导致离开翻译页的内部链接。
  try {
    var origOpen = window.open;
    window.open = function (url, target, features) {
      if (!url) return origOpen.apply(window, arguments);
      if (target === '_blank' || isExternal(url)) {
        return origOpen.apply(window, arguments);
      }
      if (isCrossPage(url)) {
        console.log('[vocal-saga] 拦截 window.open:', url);
        return null;
      }
      return origOpen.apply(window, arguments);
    };
  } catch (e) {}

  // ── 4. 文档级跳转：<meta http-equiv="refresh"> ──
  // 删除已存在的，并监控后续注入（优先只监听 <head>，降低开销）。
  try {
    function removeRefreshMeta() {
      document.querySelectorAll('meta[http-equiv="refresh" i]').forEach(function (m) { m.remove(); });
    }
    removeRefreshMeta();
    var observerTarget = document.head || document.documentElement;
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        r.addedNodes.forEach(function (n) {
          if (n && n.tagName === 'META' && /^refresh$/i.test(n.getAttribute('http-equiv') || '')) {
            n.remove();
          }
        });
      });
    }).observe(observerTarget, { childList: true, subtree: true });
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
