type Task<T> = () => Promise<T>;

interface QueueItem<T> {
  task: Task<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  retries: number;
}

export class TranslationQueue {
  private queue: QueueItem<any>[] = [];
  private running = 0;
  private concurrency: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor(concurrency = 4, maxRetries = 2, retryDelay = 1000) {
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  async add<T>(task: Task<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject, retries: 0 });
      this.process();
    });
  }

  private async process() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      this.running++;

      try {
        const result = await item.task();
        item.resolve(result);
      } catch (error) {
        if (item.retries < this.maxRetries) {
          item.retries++;
          await this.delay(this.retryDelay * item.retries);
          this.queue.unshift(item);
        } else {
          item.reject(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        this.running--;
        this.process();
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  setConcurrency(n: number): void {
    this.concurrency = n;
    if (n > 0) {
      this.process();
    }
  }

  /**
   * 批量执行任务：先串行执行前 warmupCount 个任务（帮助 LLM 构建 KV cache 前缀），
   * 然后并发执行剩余任务（由 maxConcurrency 控制并发度）。
   * 每个任务失败时按 maxRetries + retryDelay 自动重试（由 add -> process 处理）。
   */
  async addAllWithWarmup<T>(
    tasks: Task<T>[],
    warmupCount: number,
    maxConcurrency: number,
  ): Promise<T[]> {
    if (tasks.length === 0) return [];

    const results: T[] = [];

    // 先串行执行前 N 个任务（warmup，帮助 LLM 构建 KV cache 前缀）
    for (let i = 0; i < Math.min(warmupCount, tasks.length); i++) {
      results.push(await this.add(tasks[i]));
    }

    // 剩余任务通过 setConcurrency 提升并发度后并行执行
    if (tasks.length > warmupCount) {
      this.setConcurrency(maxConcurrency);
      const remaining = tasks.slice(warmupCount).map((t) => this.add(t));
      results.push(...(await Promise.all(remaining)));
    }

    return results;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get runningCount(): number {
    return this.running;
  }
}

// 注意：在 vocal-saga 中 pipeline.ts 使用 Promise.all 直接并行，从不调用 globalQueue。
// 此单例保留用于与 fanyi-extension 保持代码同步，实际未使用。
//
// Concurrency = 1 (serial)：DeepSeek 的 prompt cache (KV cache) 在
// 第二个起飞的请求上才能命中——并行 4 个请求同 prefix 同时打过去会全
// miss，串行则让每个请求都吃前一个的 cache，省钱 + 快。
// 测试与移动端也保持 1。
export const globalQueue = new TranslationQueue(1, 2, 1000);
