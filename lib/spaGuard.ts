/**
 * SPA hydration 脚本清理（spa guard）。
 *
 * 背景：vocal-saga 返回的翻译 HTML 是服务端渲染好的双语内容，但原站如果
 * 是 SPA（Next.js、Nuxt、SvelteKit、X/Twitter 等），客户端加载的 hydration
 * 脚本会重新渲染页面，导致两种问题：
 *   1. 翻译节点被覆盖/移除（React/Vue hydration 不匹配 → 丢弃 SSR DOM）
 *   2. 页面循环跳转（SPA 入口脚本 CORS 调用原站 API 失败 → 重载页面）
 *
 * 解决思路：在返回翻译 HTML 之前，移除已知的 SPA 客户端脚本和会导致循环的
 * 挑战脚本，让浏览器只渲染服务端输出的静态 HTML。
 *
 * 当前覆盖的框架 / 场景：
 *   - Next.js：`/_next/static/chunks/*.js`、`<script id="_R_">`
 *   - Nuxt.js (Vue SSR)：`/_nuxt/*.js`、`window.__NUXT__`
 *   - SvelteKit：`/svelte-kit/` 路径脚本
 *   - X/Twitter：`abs.twimg.com/responsive-web/client-web/*.js`、
 *     `window.__INITIAL_STATE__`、`window.jsdOnload`
 *   - Cloudflare JSD 挑战：`cdn-cgi/challenge-platform` 相关脚本
 *
 * 未来若遇到其他框架的类似问题，可在此扩展匹配规则。
 */

/** 需要移除的 SPA chunk script src 模式 */
const SPA_CHUNK_PATTERNS: RegExp[] = [
  // Next.js hydration chunks
  /\/_next\/static\/chunks\/[^"]+\.js/i,
  // Nuxt.js (Vue SSR) 客户端构建产物
  /\/_nuxt\/[^"]+\.js/i,
  // SvelteKit 客户端模块
  /\/svelte-kit\//i,
  // X/Twitter SPA 入口脚本（main.js / vendor.js / ondemand.s.*.js 等）
  /abs\.twimg\.com\/responsive-web\/client-web\/[^"]+\.js/i,
  // Cloudflare JSD 挑战平台脚本（在代理域名下运行会 CORS 失败导致循环重载）
  /cdn-cgi\/challenge-platform\/scripts\/jsd\//i,
];

/** 需要移除的内联脚本内容模式（匹配 textContent 任意位置） */
const SPA_INLINE_PATTERNS: RegExp[] = [
  // X/Twitter 初始状态注入（SPA 启动数据）
  /window\.__INITIAL_STATE__/,
  // Nuxt.js (Nuxt 2) 全局状态注入
  /window\.__NUXT__/,
  // Cloudflare JSD 回调函数定义
  /window\.jsdOnload/,
];

/**
 * 判断 script src 是否属于需要移除的 SPA chunk。
 */
function isSpaChunkScript(src: string): boolean {
  return SPA_CHUNK_PATTERNS.some((re) => re.test(src));
}

/**
 * 判断内联脚本内容是否属于需要移除的 SPA 引导代码。
 */
function isSpaInlineScript(text: string): boolean {
  const trimmed = text.trim();
  return SPA_INLINE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * 移除会导致 SPA hydration 覆盖翻译内容或循环跳转的脚本。
 *
 * 规则：
 *   1. 删除匹配 SPA chunk 模式的带 src 脚本标签
 *   2. 删除 Next.js streaming bootstrap `<script id="_R_" ...></script>`
 *   3. 删除匹配 SPA 内联模式的 `<script>...</script>` 块
 *
 * @param html 原始 HTML 字符串
 * @returns 清理后的 HTML 字符串
 */
export function stripHydrationScripts(html: string): string {
  // 1. 删除带 src 的 chunk 脚本
  let cleaned = html.replace(
    /<script\b[^>]*\bsrc="([^"]*)"[^>]*><\/script>/gi,
    (match, src) => (isSpaChunkScript(src) ? '' : match),
  );

  // 2. 删除 Next.js streaming root script（无 src，只有 id="_R_"）
  cleaned = cleaned.replace(/<script[^>]*\bid="_R_"[^>]*><\/script>/gi, '');

  // 3. 删除匹配 SPA 内联模式的 <script>...</script> 块
  //    使用非贪婪匹配，逐个检查内联内容
  cleaned = cleaned.replace(
    /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi,
    (match, content) => (isSpaInlineScript(content) ? '' : match),
  );

  return cleaned;
}
