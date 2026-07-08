/**
 * SPA 危险脚本清理（spa guard）。
 *
 * 设计理念：不删除 SPA bootstrap 数据（让 SPA 正常初始化和应用样式），
 * 只删除 Cloudflare JSD 挑战脚本，配合 redirectGuard 拦截循环跳转。
 *
 * 保留的：
 *   - SPA chunk 脚本（main.js / vendor.js 等）— 提供样式和交互
 *   - SPA bootstrap 数据（__INITIAL_STATE__ / __next_f / __NUXT__ 等）— 让 SPA 正常初始化
 *   - analytics 配置、广告脚本等无害脚本
 *
 * 删除的：
 *   - Cloudflare JSD 挑战脚本（cdn-cgi/challenge-platform）— 代理域 CORS 失败 → reload
 *   - JSD 回调定义（window.jsdOnload）— 配合 JSD 挑战触发 reload
 *
 * 循环跳转由 redirectGuard 的导航拦截兜底（reload/assign/replace + fetch guard），
 * 不需要删除 SPA bootstrap 数据。
 */

/** 需要移除的外部脚本 src 模式 */
const DANGEROUS_CHUNK_PATTERNS: RegExp[] = [
  // Cloudflare JSD 挑战平台脚本（代理域名下 CORS 失败导致循环重载）
  /cdn-cgi\/challenge-platform\/scripts\/jsd\//i,
];

/** 需要移除的内联脚本内容模式 */
const DANGEROUS_INLINE_PATTERNS: RegExp[] = [
  // Cloudflare JSD 回调函数定义
  /window\.jsdOnload/,
];

function matchesAny(src: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(src));
}

/**
 * 判断 script src 是否属于需要移除的危险外部脚本。
 */
function isDangerousChunkScript(src: string): boolean {
  return matchesAny(src, DANGEROUS_CHUNK_PATTERNS);
}

/**
 * 判断内联脚本内容是否属于需要移除的 bootstrap 代码。
 */
function isDangerousInlineScript(text: string): boolean {
  return matchesAny(text.trim(), DANGEROUS_INLINE_PATTERNS);
}

/**
 * 移除会导致循环重载的 Cloudflare JSD 挑战脚本。
 *
 * 规则：
 *   1. 删除 cdn-cgi/challenge-platform 外部脚本
 *   2. 删除 window.jsdOnload 内联回调
 *   3. 保留所有 SPA chunk 脚本和 bootstrap 数据
 *
 * 循环跳转由 redirectGuard 拦截 reload/assign/replace 兜底。
 *
 * @param html 原始 HTML 字符串
 * @returns 清理后的 HTML 字符串
 */
export function stripDangerousScripts(html: string): string {
  // 1. 删除带 src 的危险脚本
  let cleaned = html.replace(
    /<script\b[^>]*\bsrc="([^"]*)"[^>]*><\/script>/gi,
    (match, src) => (isDangerousChunkScript(src) ? '' : match),
  );

  // 2. 删除匹配危险模式的内联脚本块
  cleaned = cleaned.replace(
    /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi,
    (match, content) => (isDangerousInlineScript(content) ? '' : match),
  );

  return cleaned;
}
