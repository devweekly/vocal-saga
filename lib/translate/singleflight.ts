// Singleflight 工具 — 防止同一 key 的并发请求重复调用 LLM
//
// 用法:
//   const result = await translateSingleflight(cacheKey, () => callLLM(chunk));
//   如果多个调用者用同一 cacheKey,只会有一个 LLM 调用,其他调用者共享结果。

const inflight = new Map<string, Promise<unknown>>();

/**
 * 单飞执行:同一 key 的并发调用只执行一次 fn,所有调用者共享结果。
 *
 * @param key 单飞 key(通常用 cacheKey)
 * @param fn 实际执行函数(调 LLM 等)
 * @returns fn 的执行结果
 */
export async function translateSingleflight<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  // 如果已有 inflight 的 Promise,直接复用
  const existing = inflight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  // 创建新的 Promise 并存入 map
  const promise = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);

  return promise;
}

/**
 * 获取当前 inflight 的 key 数量(用于监控/调试)。
 */
export function getInflightCount(): number {
  return inflight.size;
}

/**
 * 清除所有 inflight(用于测试或重置)。
 */
export function clearInflight(): void {
  inflight.clear();
}
