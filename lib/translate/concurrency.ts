/**
 * 有界并发工具。
 *
 * ## 为什么需要它
 *
 * 翻译管线把文章切成 N 个 chunk 后要并发调用 LLM。早期实现是
 * `chunks.map(worker)` + `Promise.all`，即**一次性把 N 个请求全部发出**，
 * `concurrency` 参数只被打印进日志，从未真正限制并发度。
 *
 * 后果：
 *   - 长文（上百个 chunk）瞬间打满上游，触发 429 限流，反而更慢；
 *   - Cloudflare Workers 对"同时等待 response headers 的 fetch"有上限（6），
 *     超出的请求被排队，行为不可预测；
 *   - 单个请求 45~60s 超时，全并发时失败重试会雪崩。
 *
 * 本模块用固定大小的 worker 池替代全并发：始终只有 `limit` 个任务在飞，
 * 一个跑完就从队列里取下一个。
 */

/**
 * 以固定并发度执行全部任务。
 *
 * 设计要点：
 *   - **不保证顺序**：任务完成顺序取决于上游响应速度，与入参顺序无关。
 *     调用方通过写入共享的 Map 收集结果（见 pipeline 的 finalTranslations）。
 *   - **fail-fast**：任一任务抛错立即向上抛出，不再调度新任务。
 *     已启动的任务无法撤回，其 rejection 由 `Promise.all` 统一接管，
 *     避免产生 unhandled rejection。
 *   - **`limit` 非法时钳制**：小于等于 0 或 NaN 时退化为串行（limit=1），
 *     小数向上取整，大于任务数时自动收敛为任务数（不创建多余 worker）。
 *
 * @param items  任务输入列表
 * @param limit  最大同时在飞任务数
 * @param worker 任务执行体
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  // 钳制：非法值退化为串行，小数向上取整，不超过任务总数
  const raw = Number.isFinite(limit) ? Math.ceil(limit) : 1;
  const size = Math.min(Math.max(raw, 1), items.length);

  let nextIndex = 0;

  /**
   * 单个 worker：不断从游标取下一个任务，直到队列耗尽。
   * 多个 worker 共享 `nextIndex`，靠 JS 单线程语义保证不重不漏。
   */
  async function runWorker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < size; i++) {
    workers.push(runWorker());
  }

  // 任一 worker 抛错 → Promise.all 立即 reject，其余 worker 的 rejection
  // 同样被这里接管，不会产生 unhandled rejection。
  await Promise.all(workers);
}
