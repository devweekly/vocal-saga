/**
 * URL 工具函数：标准化、缓存 key 生成。
 *
 * 从 lib/app.ts 提取，保持主文件干净。
 */

/**
 * URL 标准化：统一格式以便缓存命中和去重。
 *
 * 规则：
 *   1. 剥离 http:// 或 https:// 前缀
 *   2. 无 "." 的首段域名自动补 .com（如 towardsdatascience → towardsdatascience.com）
 *
 * 注意：www.example.com 和 example.com 暂时保留为两个不同 URL，不做去重。
 */
export function normalizeUrl(rawPath: string): string {
  // 1) 剥 scheme
  let normalized = rawPath.replace(/^https?:\/\//i, '');

  // 2) 无 "." 的首段域名补 .com（如 /translate/towardsdatascience/article → towardsdatascience.com/article）
  const slashIdx = normalized.indexOf('/');
  const hostPart = slashIdx < 0 ? normalized : normalized.slice(0, slashIdx);
  const pathPart = slashIdx < 0 ? '' : normalized.slice(slashIdx);
  if (hostPart && !hostPart.includes('.')) {
    normalized = hostPart + '.com' + pathPart;
  }

  return normalized;
}

/**
 * 缓存 key 直接用完整 URL（保留 scheme 和 www）。
 * www.example.com 和 example.com 暂时视为不同 URL。
 */
export function cacheKeyUrl(url: string): string {
  return url;
}
