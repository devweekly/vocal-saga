/**
 * SPA hydration 脚本清理（spa guard）。
 *
 * 背景：vocal-saga 返回的翻译 HTML 是服务端渲染好的双语内容，但原站如果
 * 是 Next.js 等 SPA，客户端加载的 hydration 脚本会重新渲染页面，把已插入的
 * 翻译节点整体替换/移除，表现为“中文译文一闪而过就消失”。
 *
 * 解决思路：在返回翻译 HTML 之前，移除已知的 SPA 客户端 chunk 脚本，让浏览器
 * 只渲染服务端输出的静态 HTML。这样不会触发 hydration，翻译节点自然保留。
 * 该处理只针对翻译后的页面，/original 等原始页面代理不做此清理。
 *
 * 当前覆盖的框架：
 *   - Next.js App/Pages Router：`/_next/static/chunks/*.js`、`<script id="_R_">`
 *
 * 未来若遇到其他框架（如 Nuxt、SvelteKit）的类似问题，可在此扩展匹配规则，
 * 而不是为单个站点写特例。
 */

/** 需要移除的 SPA chunk script src 模式 */
const SPA_CHUNK_PATTERNS: RegExp[] = [
  /\/_next\/static\/chunks\/[^"]+\.js/i,
];

/**
 * 判断 script src 是否属于 SPA hydration chunk。
 */
function isSpaChunkScript(src: string): boolean {
  return SPA_CHUNK_PATTERNS.some((re) => re.test(src));
}

/**
 * 移除会导致 SPA hydration 覆盖翻译内容的脚本。
 *
 * 规则：
 *   1. 删除 `<script src=".../_next/static/chunks/...js"></script>`
 *   2. 删除 Next.js streaming bootstrap `<script id="_R_" ...></script>`
 *
 * @param html 原始 HTML 字符串
 * @returns 清理后的 HTML 字符串
 */
export function stripHydrationScripts(html: string): string {
  // 删除带 src 的 chunk 脚本
  let cleaned = html.replace(/<script[^>]*src="([^"]*)"[^>]*><\/script>/gi, (match, src) => {
    return isSpaChunkScript(src) ? '' : match;
  });

  // 删除 Next.js streaming root script（无 src，只有 id="_R_"）
  cleaned = cleaned.replace(/<script[^>]*\bid="_R_"[^>]*><\/script>/gi, '');

  return cleaned;
}
