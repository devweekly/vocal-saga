/**
 * SPA 脚本清理 — 两层分离架构。
 *
 * ## 背景
 * 翻译页面直接回吐原站点 HTML，其中包含两类独立的威胁：
 *
 * 1. **循环跳转** — Cloudflare JSD 挑战脚本在代理域下 CORS 失败 → reload
 * 2. **Hydration 覆盖** — SPA 客户端脚本执行 React/Vue hydration，
 *    用客户端渲染的 DOM 替换 SSR 翻译 DOM，导致译文消失
 *
 * 这两个问题完全独立：即使 reload 被完全阻止，hydration 仍然会覆盖翻译。
 * 反过来，即使 hydration 被阻止（删了 SPA chunk），残留的 JSD 脚本仍可能触发 reload。
 *
 * ## 两层设计
 *
 * ### stripNavigationScripts（第一层：导航防护）
 * 只删 Cloudflare JSD 挑战脚本，保留所有其他脚本和 bootstrap 数据。
 * 适用于所有页面（包括 /original 原始页面）。
 *
 * ### stripHydrationScripts（第二层：hydration 防护）
 * 删除 SPA bootstrap 数据和 chunk 脚本，阻止 hydration。
 * 适用于翻译页面（需要保留 SSR 翻译 DOM）。
 * 对 SPA-first 网站（X/Twitter、Next.js、Nuxt 等）特别重要。
 *
 * ### stripDangerousScripts（组合便捷函数）
 * 等价于 stripHydrationScripts(stripNavigationScripts(html))。
 */

// ════════════════════════════════════════════════════════════
// 第一层：Navigation Scripts（Cloudflare JSD 挑战）
// ════════════════════════════════════════════════════════════

/** JSD 挑战外部脚本 src 模式 */
const NAVIGATION_CHUNK_PATTERNS: RegExp[] = [
  // Cloudflare JSD 挑战平台脚本（代理域名下 CORS 失败导致循环重载）
  /cdn-cgi\/challenge-platform\/scripts\/jsd\//i,
];

/** JSD 挑战内联脚本内容模式 */
const NAVIGATION_INLINE_PATTERNS: RegExp[] = [
  // Cloudflare JSD 回调函数定义
  /window\.jsdOnload/,
];

function matchesAny(src: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(src));
}

/**
 * 第一层：移除 Cloudflare JSD 挑战脚本。
 *
 * 只删除 cdn-cgi/challenge-platform 外部脚本和 jsdOnload 内联回调，
 * 保留所有 SPA chunk 和 bootstrap 数据。
 *
 * 适用于所有页面（包括 /original 原始页面）。
 */
export function stripNavigationScripts(html: string): string {
  // 1. 删除带 src 的 JSD 挑战脚本
  let cleaned = html.replace(
    /<script\b[^>]*\bsrc="([^"]*)"[^>]*><\/script>/gi,
    (match, src) => (matchesAny(src, NAVIGATION_CHUNK_PATTERNS) ? '' : match),
  );

  // 2. 删除 jsdOnload 内联回调
  cleaned = cleaned.replace(
    /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi,
    (match, content) => (matchesAny(content.trim(), NAVIGATION_INLINE_PATTERNS) ? '' : match),
  );

  return cleaned;
}

// ════════════════════════════════════════════════════════════
// 第二层：Hydration Scripts（SPA bootstrap + chunk）
// ════════════════════════════════════════════════════════════

/**
 * SPA chunk 脚本 src 模式 — 删除后会阻止 hydration。
 *
 * 这些是各 SPA 框架的客户端入口 chunk，加载后执行 React/Vue hydrateRoot()，
 * 用客户端渲染的虚拟 DOM 替换 SSR 翻译 DOM。
 *
 * 注意：CSS link 标签不在此列，样式不会丢失。
 */
const HYDRATION_CHUNK_PATTERNS: RegExp[] = [
  // Next.js — 客户端 chunk（hydration 入口）
  /\/_next\/static\/chunks\//i,
  // Next.js — streaming bootstrap 脚本标记
  /<script\s+id="_R_"/i,
  // Nuxt.js — 客户端 chunk
  /\/_nuxt\//i,
  // SvelteKit — 客户端 chunk
  /\/svelte-kit\//i,
  // X/Twitter — SPA 客户端 chunk（abs.twimg.com）
  /abs\.twimg\.com\/responsive-web\//i,
  // Google Publisher Tag / AdSense — 翻译页不需要广告脚本，
  // 滚动时 GPT 可能动态填充广告槽并覆盖/替换已有翻译节点。
  /securepubads\.g\.doubleclick\.net\//i,
  /googletagservices\.com\//i,
  // Substack — SPA 客户端 chunk（React hydration 后会用客户端路由覆盖 SSR 翻译 DOM，
  // 且因代理域 URL 不匹配 Substack 路由而渲染 "Page not found"）
  /substackcdn\.com\/bundle\/static\/js\//i,
  // GitHub — 全部 githubassets JS bundle。
  // GitHub 的 repo 概览用 `react-partial` 做局部 hydration：
  //   <react-partial><script type="application/json" data-target="react-partial.embeddedData">…
  // React 挂载后会用 embeddedData 重新渲染 reactRoot，把 README 里注入的
  // .fanyi-original / .fanyi-translation 整段替换掉 → 译文消失（article/601）。
  // 只删 embeddedData 无效（客户端仍会用其它数据源重渲染），必须拦掉 JS bundle。
  // README / issue 等正文都是 SSR 输出的，去掉 JS 不影响译文与排版。
  /githubassets\.com\/assets\/[^"]*\.js/i,
];

/**
 * SPA bootstrap 数据内联脚本模式 — 删除后 SPA 无法初始化 hydration。
 *
 * 这些内联脚本为 SPA 提供初始状态数据。删除后即使 chunk 加载了，
 * 也因为缺少初始数据而不会执行 hydration。
 */
const HYDRATION_INLINE_PATTERNS: RegExp[] = [
  // Next.js — streaming data（React Server Components 数据流）
  /self\.__next_f\.push/,
  // X/Twitter — 初始状态
  /window\.__INITIAL_STATE__/,
  // X/Twitter — 脚本加载状态 / 失败上报 / GPT 广告槽初始化。
  // 删除 main.js 后这些脚本仍会执行，可能触发广告渲染或显示失败提示，
  // 一并清理确保翻译页完全静态。
  /window\.__SCRIPTS_LOADED__/,
  /window\.__SCRIPT_LOAD_FAILURE__/,
  /window\.__SSP_PROMISE__/,
  // Nuxt.js — 全局状态
  /window\.__NUXT__/,
  // SvelteKit — 内联数据
  /__sveltekit/,
];

/**
 * 第二层：移除 SPA bootstrap 数据和 chunk 脚本。
 *
 * 删除各 SPA 框架的 hydration 入口（chunk 脚本 + bootstrap 数据），
 * 阻止客户端 hydration 覆盖 SSR 翻译 DOM。
 *
 * CSS 样式不受影响（<link rel="stylesheet"> 不在删除范围）。
 * 适用于翻译页面（需要保留 SSR 翻译 DOM）。
 */
export function stripHydrationScripts(html: string): string {
  // 1. 删除 SPA chunk 脚本
  let cleaned = html.replace(
    /<script\b[^>]*\bsrc="([^"]*)"[^>]*><\/script>/gi,
    (match, src) => (matchesAny(src, HYDRATION_CHUNK_PATTERNS) ? '' : match),
  );

  // 2. 删除 Next.js streaming bootstrap（<script id="_R_">）
  cleaned = cleaned.replace(
    /<script\s+id="_R_"[^>]*>[\s\S]*?<\/script>/gi,
    '',
  );

  // 3. 删除 SPA bootstrap 数据内联脚本
  cleaned = cleaned.replace(
    /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi,
    (match, content) => (matchesAny(content.trim(), HYDRATION_INLINE_PATTERNS) ? '' : match),
  );

  return cleaned;
}

// ════════════════════════════════════════════════════════════
// 组合便捷函数
// ════════════════════════════════════════════════════════════

/**
 * 组合：先移除导航威胁，再移除 hydration 威胁。
 *
 * 等价于 stripHydrationScripts(stripNavigationScripts(html))。
 * 适用于所有翻译页面。
 */
export function stripDangerousScripts(html: string): string {
  return stripHydrationScripts(stripNavigationScripts(html));
}
