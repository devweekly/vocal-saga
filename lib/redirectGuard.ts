/**
 * 重定向守卫（redirect guard）— 两层架构。
 *
 * ## 设计背景
 * 翻译页面直接回吐原站点的 HTML，其中带有原站的 SPA 入口脚本。
 * 这些脚本在代理域下运行时，API 请求 CORS 失败后会触发循环跳转。
 *
 * ## 关键发现
 *   - `location.href` 在 Chrome 中 `configurable: false`，**无法用 JS 拦截**
 *   - `location.reload` 同样不可靠 patch
 *   - X/Twitter SPA 用 `location.href = url` 触发 reload，传统拦截无效
 *   - Navigation API（Chrome 102+）的 `navigate` 事件可以拦截所有导航类型
 *
 * ## 防御层次
 *   1. **Navigation API**（主要）— 拦截 `navigate` 事件，阻止同页 reload/replace
 *   2. **fetch guard** — 拦截 api.x.com / ads-api.x.com / cdn-cgi 请求，返回 fake 响应
 *   3. **XHR guard** — 同上，拦截 XMLHttpRequest
 *   4. **history.pushState/replaceState** — 拦截跨页 SPA 路由
 *   5. **history.go(0)** — 拦截等同于 reload 的调用
 *   6. **window.open** — 拦截当前窗口打开内部链接
 *   7. **<meta refresh>** — 移除并监控
 *
 * 注意：`location.reload/assign/replace` 在真实浏览器中无法可靠 patch
 * （`configurable: false`），所以不尝试 patch。Navigation API 是替代方案。
 * 在 jsdom 测试环境中这些方法可以 patch，保留 history 等其他拦截。
 */

/**
 * 注入到页面的守卫脚本源码。
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
  var currentSearch = window.location.search;

  /**
   * 判断 url 是否会导致离开当前页面（不同 origin / pathname / search）。
   * 空值/非法值视为不跳转。
   */
  function isCrossPage(url) {
    if (!url) return false;
    try {
      var parsed = new URL(url, currentHref);
      return parsed.origin !== currentOrigin ||
             parsed.pathname !== currentPathname ||
             parsed.search !== currentSearch;
    } catch (e) {
      return false;
    }
  }

  function isExternal(url) {
    if (!url) return false;
    try {
      return new URL(url, currentHref).origin !== currentOrigin;
    } catch (e) {
      return false;
    }
  }

  /**
   * 判断请求 URL 是否应被拦截（CORS 会失败并触发 SPA reload 的域名/路径）。
   * - /cdn-cgi/ — Cloudflare JSD 挑战，代理域下必定 CORS 失败
   * - api.x.com / ads-api.x.com — X/Twitter SPA 后端 API，代理域下必定 CORS 失败
   */
  function shouldBlock(url) {
    if (!url) return false;
    return url.indexOf('/cdn-cgi/') !== -1 ||
           url.indexOf('api.x.com') !== -1 ||
           url.indexOf('ads-api.x.com') !== -1;
  }

  /**
   * 根据 URL 构造匹配 X/Twitter SPA 预期的 fake 响应体。
   * 不同端点期望不同的 JSON 结构，返回不匹配的结构会导致
   * SPA 解析异常 → reload。
   */
  function buildFakeResponse(url) {
    // GraphQL 查询：期望 {data: {...}}
    if (url.indexOf('/graphql/') !== -1) {
      return '{"data":{},"extensions":{}}';
    }
    // hashflags：期望数组
    if (url.indexOf('hashflags') !== -1) {
      return '[]';
    }
    // badge_count：期望 {ntab:0, xchat:0}
    if (url.indexOf('badge_count') !== -1) {
      return '{"ntab":0,"xchat":0,"total":0}';
    }
    // viewer_context：期望 {viewer:{...}}
    if (url.indexOf('viewer_context') !== -1) {
      return '{"viewer":{"id":"0","rest_id":"0","is_logged_in":false}}';
    }
    // account/settings：期望对象
    if (url.indexOf('account/settings') !== -1) {
      return '{}';
    }
    // permissionsState：期望对象
    if (url.indexOf('permissionsState') !== -1) {
      return '{}';
    }
    // ads-api measurement：期望空对象
    if (url.indexOf('ads-api') !== -1) {
      return '{}';
    }
    // 默认：空 JSON 对象
    return '{}';
  }

  var results = {};

  // ── 1. Navigation API（主要防线）──
  // Chrome 102+ 提供 Navigation API，可以拦截所有类型的导航（reload/replace/push）。
  // 这是拦截 location.href = url 和 location.reload() 的唯一可靠方式，
  // 因为这些 Location 属性在 Chrome 中 configurable: false 无法 patch。
  // 规则：只拦截同页 reload/replace（SPA 错误处理触发的循环跳转），
  // 跨页导航放行（用户点击外部链接等）。
  try {
    if (window.navigation) {
      navigation.addEventListener('navigate', function (ev) {
        var dest = ev.destination ? ev.destination.url : '';
        // 同页 reload 或 replace → 拦截（SPA 循环跳转）
        if (ev.navigationType === 'reload' || dest === currentHref) {
          console.log('[vocal-saga] 拦截 navigation:', ev.navigationType, dest.slice(0, 100));
          ev.preventDefault();
          return;
        }
        // 跨页导航 → 放行
      });
      results.navigation = true;
      console.log('[vocal-saga] Navigation API guard active');
    } else {
      results.navigation = false;
      console.log('[vocal-saga] Navigation API not available');
    }
  } catch (e) {
    results.navigation = false;
    console.error('[vocal-saga] Navigation API setup failed:', e.message);
  }

  // ── 2. fetch guard ──
  // 拦截 CORS 会失败的请求，返回匹配 SPA 预期的 fake 200 响应，
  // 避免 SPA 因 fetch error 进入错误状态并触发 reload。
  try {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input :
                (input && typeof input === 'object' && input.url) ? input.url :
                String(input || '');
      if (shouldBlock(url)) {
        var fakeBody = buildFakeResponse(url);
        console.log('[vocal-saga] 拦截 fetch:', url);
        return Promise.resolve(new Response(fakeBody, {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
      try {
        return origFetch.apply(window, arguments);
      } catch (e) {
        // 原生 fetch 同步抛错（如 URL 非法），返回 rejected Promise 不让 SPA 崩溃
        console.log('[vocal-saga] 吞掉 fetch 错误:', e.message, url);
        return Promise.reject(e);
      }
    };
    results.fetch = true;
  } catch (e) {
    results.fetch = false;
    console.error('[vocal-saga] patch fetch failed:', e.message);
  }

  // ── 3. XMLHttpRequest guard ──
  // 拦截 CORS 会失败的 XHR 请求，设置 status/responseText/response 等属性，
  // 并触发 onload/onreadystatechange 回调，让 SPA 认为请求成功。
  try {
    var origXhrOpen = XMLHttpRequest.prototype.open;
    var origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__vsUrl = String(url || '');
      return origXhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (shouldBlock(this.__vsUrl)) {
        var self = this;
        var fakeBody = buildFakeResponse(self.__vsUrl);
        console.log('[vocal-saga] 拦截 XHR:', self.__vsUrl);
        setTimeout(function () {
          try {
            Object.defineProperty(self, 'status', { configurable: true, value: 200 });
            Object.defineProperty(self, 'statusText', { configurable: true, value: 'OK' });
            Object.defineProperty(self, 'responseText', { configurable: true, value: fakeBody });
            Object.defineProperty(self, 'response', { configurable: true, value: fakeBody });
            Object.defineProperty(self, 'responseURL', { configurable: true, value: self.__vsUrl });
            Object.defineProperty(self, 'readyState', { configurable: true, value: 4 });
            if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
            if (typeof self.onload === 'function') self.onload(new ProgressEvent('load'));
            self.dispatchEvent(new ProgressEvent('load'));
            self.dispatchEvent(new ProgressEvent('loadend'));
          } catch (e) {
            console.error('[vocal-saga] XHR fake response error:', e.message);
          }
        }, 0);
        return;
      }
      try {
        return origXhrSend.apply(this, arguments);
      } catch (e) {
        // 原生 XHR.send 同步抛错（如网络层拒绝），触发 onerror 不让 SPA 崩溃
        console.log('[vocal-saga] 吞掉 XHR.send 错误:', e.message, this.__vsUrl);
        var self = this;
        setTimeout(function () {
          try {
            Object.defineProperty(self, 'status', { configurable: true, value: 0 });
            Object.defineProperty(self, 'readyState', { configurable: true, value: 4 });
            if (typeof self.onerror === 'function') self.onerror(new ProgressEvent('error'));
            self.dispatchEvent(new ProgressEvent('error'));
            self.dispatchEvent(new ProgressEvent('loadend'));
          } catch (e2) {}
        }, 0);
      }
    };
    results.xhr = true;
  } catch (e) {
    results.xhr = false;
    console.error('[vocal-saga] patch XHR failed:', e.message);
  }

  // ── 4. history.pushState / replaceState ──
  // 拦截跨页 SPA 路由跳转（同页 hash 跳转允许）。
  // 额外用 try/catch 包裹原生调用：跨域 URL 会触发 SecurityError，
  // 静默吞掉避免 SPA 崩溃（如 Substack 的 componentDidMount 崩溃）。
  try {
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      history[m] = function (state, title, url) {
        if (url && isCrossPage(url)) {
          console.log('[vocal-saga] 拦截 history.' + m + ':', url);
          return;
        }
        try {
          return orig.apply(history, arguments);
        } catch (e) {
          // 跨域 URL 触发 SecurityError，静默吞掉
          console.log('[vocal-saga] 吞掉 history.' + m + ' 错误:', e.message, url);
        }
      };
    });
    results.pushState = true;
    results.replaceState = true;
  } catch (e) {
    results.pushState = false;
    results.replaceState = false;
    console.error('[vocal-saga] patch history.pushState/replaceState failed:', e.message);
  }

  // ── 5. history.go(0) ──
  // history.go(0) 等同于 reload，拦截。
  // 其他值用 try/catch 包裹原生调用，防止抛错崩溃 SPA。
  try {
    var origGo = history.go;
    history.go = function (delta) {
      if (delta === 0) {
        console.log('[vocal-saga] 拦截 history.go(0)');
        return;
      }
      try {
        return origGo.apply(history, arguments);
      } catch (e) {
        console.log('[vocal-saga] 吞掉 history.go 错误:', e.message);
      }
    };
    results.go = true;
  } catch (e) {
    results.go = false;
    console.error('[vocal-saga] patch history.go failed:', e.message);
  }

  // ── 6. window.open ──
  // 拦截当前窗口（_self）打开内部跨页链接，_blank 和外部链接放行。
  // 原生调用用 try/catch 包裹，弹窗被拦截或安全策略抛错时不崩溃 SPA。
  try {
    var origOpen = window.open;
    window.open = function (url, target, features) {
      var args = arguments;
      function callOrig() {
        try {
          return origOpen.apply(window, args);
        } catch (e) {
          console.log('[vocal-saga] 吞掉 window.open 错误:', e.message, url);
          return null;
        }
      }
      if (!url) return callOrig();
      if (target === '_blank' || isExternal(url)) {
        return callOrig();
      }
      if (isCrossPage(url)) {
        console.log('[vocal-saga] 拦截 window.open:', url);
        return null;
      }
      return callOrig();
    };
    results.open = true;
  } catch (e) {
    results.open = false;
    console.error('[vocal-saga] patch window.open failed:', e.message);
  }

  // ── 7. <meta http-equiv="refresh"> ──
  // 移除已有的 meta refresh，并用 MutationObserver 监控后续注入。
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
    results.metaRefresh = true;
  } catch (e) {
    results.metaRefresh = false;
    console.error('[vocal-saga] patch metaRefresh failed:', e.message);
  }

  // ── 验证日志 ──
  console.log('[vocal-saga] redirectGuard patches:', JSON.stringify(results));
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
  const rescueScript = `<script>${SVG_RESCUE_SCRIPT}</script>`;

  // 情况 1：有 <head ...> 标签 → 守卫脚本插到 head 内最前面
  const headOpenMatch = html.match(/<head(\s[^>]*)?>/i);
  if (headOpenMatch) {
    const insertAt = headOpenMatch.index! + headOpenMatch[0].length;
    let result = html.slice(0, insertAt) + scriptTag + html.slice(insertAt);
    // 救援脚本放在 </body> 前（最后执行）
    result = injectBeforeBodyClose(result, rescueScript);
    return result;
  }

  // 情况 2：有 <html ...> 但没 <head> → 在 html 标签后补一个 head
  const htmlOpenMatch = html.match(/<html(\s[^>]*)?>/i);
  if (htmlOpenMatch) {
    const insertAt = htmlOpenMatch.index! + htmlOpenMatch[0].length;
    let result = html.slice(0, insertAt) + `<head>${scriptTag}</head>` + html.slice(insertAt);
    result = injectBeforeBodyClose(result, rescueScript);
    return result;
  }

  // 情况 3：HTML 片段，无结构标签 → 直接前置拼接
  return scriptTag + rescueScript + html;
}

/** 把脚本注入到 </body> 前（如果有的话） */
function injectBeforeBodyClose(html: string, scriptTag: string): string {
  const bodyCloseMatch = html.match(/<\/body>/i);
  if (bodyCloseMatch) {
    const insertAt = bodyCloseMatch.index!;
    return html.slice(0, insertAt) + scriptTag + html.slice(insertAt);
  }
  return html + scriptTag;
}

/**
 * SVG 救援脚本 — 在所有脚本执行后运行。
 *
 * 某些站点（如 Substack）的运行时 JavaScript 会动态创建带 <title> 的 SVG 图标。
 * 浏览器将 SVG <title> 视为 HTML integration point，其内部 <path> 不自闭合，
 * 导致后续 HTML 内容被困在 SVG 内不可见。
 *
 * 此脚本检测被困内容并移出 SVG。
 */
export const SVG_RESCUE_SCRIPT = `
(function () {
  if (window.__vsSvgRescue) return;
  window.__vsSvgRescue = true;

  var SVG_TAGS = ['svg', 'path', 'g', 'rect', 'circle', 'ellipse', 'line',
    'polyline', 'polygon', 'title', 'defs', 'use', 'symbol', 'mask',
    'clippath', 'lineargradient', 'radialgradient', 'stop', 'text', 'tspan'];

  function isInsideSvg(el) {
    var parent = el.parentElement;
    while (parent) {
      if (parent.tagName === 'SVG' || SVG_TAGS.indexOf(parent.tagName.toLowerCase()) >= 0) {
        return true;
      }
      parent = parent.parentElement;
    }
    return false;
  }

  function findSvgAncestor(el) {
    var parent = el.parentElement;
    while (parent) {
      if (parent.tagName === 'SVG') return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function rescueTrappedContent() {
    // 查找可能被困在 SVG 内的内容元素
    var selectors = '.available-content, .body.markup, .body, [class*="body markup"]';
    var trapped = document.querySelectorAll(selectors);
    trapped.forEach(function (el) {
      if (!isInsideSvg(el)) return;
      var svg = findSvgAncestor(el);
      if (!svg) return;
      // 找到 SVG 的最近非 SVG 祖先（通常是 button 或 div）
      var safeParent = svg.parentElement;
      while (safeParent && isInsideSvg(safeParent)) {
        safeParent = safeParent.parentElement;
      }
      if (safeParent) {
        // 移到 SVG 的父元素中（SVG 之后）
        safeParent.insertBefore(el, svg.nextSibling);
        console.log('[vocal-saga] SVG rescue: moved', el.className, 'out of SVG');
      }
    });
  }

  // DOMContentLoaded 时执行一次
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rescueTrappedContent);
  } else {
    rescueTrappedContent();
  }

  // 用 MutationObserver 监控后续 DOM 变化
  var rescueTimer = null;
  var observer = new MutationObserver(function () {
    if (rescueTimer) return;
    rescueTimer = setTimeout(function () {
      rescueTimer = null;
      rescueTrappedContent();
    }, 100);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 5 秒后停止监听（避免长期性能开销）
  setTimeout(function () { observer.disconnect(); }, 5000);
})();
`;
