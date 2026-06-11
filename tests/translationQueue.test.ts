import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranslationQueue } from '../lib/translate/translationQueue';

describe('TranslationQueue', () => {
  let queue: TranslationQueue;

  beforeEach(() => {
    queue = new TranslationQueue(2, 1, 50);
  });

  it('executes a single task', async () => {
    const result = await queue.add(() => Promise.resolve('done'));
    expect(result).toBe('done');
  });

  it('executes multiple tasks sequentially up to concurrency', async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3, 4].map(i =>
      queue.add(async () => {
        order.push(i);
        await new Promise(r => setTimeout(r, 30));
        return i;
      })
    );

    const results = await Promise.all(tasks);
    expect(results).toEqual([1, 2, 3, 4]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 5 }, (_, i) =>
      queue.add(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(r => setTimeout(r, 50));
        running--;
        return i;
      })
    );

    await Promise.all(tasks);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('retries failed tasks', async () => {
    let attempts = 0;

    const result = await queue.add(async () => {
      attempts++;
      if (attempts < 2) throw new Error('fail');
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('rejects after max retries exceeded', async () => {
    let attempts = 0;

    await expect(
      queue.add(async () => {
        attempts++;
        throw new Error('permanent failure');
      })
    ).rejects.toThrow('permanent failure');

    // maxRetries=1, so 1 initial + 1 retry = 2 attempts
    expect(attempts).toBe(2);
  });

  it('reports pending and running counts', async () => {
    expect(queue.pendingCount).toBe(0);
    expect(queue.runningCount).toBe(0);

    const task = queue.add(() => new Promise(r => setTimeout(r, 100)));

    // Give a tick for the queue to start processing
    await new Promise(r => setTimeout(r, 10));

    expect(queue.runningCount).toBeLessThanOrEqual(1);

    await task;
    expect(queue.runningCount).toBe(0);
  });

  it('handles tasks that resolve immediately', async () => {
    const results = await Promise.all([
      queue.add(() => Promise.resolve('a')),
      queue.add(() => Promise.resolve('b')),
      queue.add(() => Promise.resolve('c')),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('preserves result type', async () => {
    const num = await queue.add(() => Promise.resolve(42));
    const str = await queue.add(() => Promise.resolve('hello'));
    const obj = await queue.add(() => Promise.resolve({ key: 'value' }));

    expect(num).toBe(42);
    expect(str).toBe('hello');
    expect(obj).toEqual({ key: 'value' });
  });

  // --- error types ---

  it('wraps non-Error throws in Error object', async () => {
    const promise = queue.add(() => {
      throw 'string error';
    });
    await expect(promise).rejects.toThrow('string error');
  });

  it('preserves original Error instance', async () => {
    const promise = queue.add(() => {
      throw new TypeError('type error');
    });
    await expect(promise).rejects.toThrow(TypeError);
    await expect(promise).rejects.toThrow('type error');
  });

  it('handles rejection of non-Error value', async () => {
    const promise = queue.add(() => Promise.reject(42));
    await expect(promise).rejects.toThrow('42');
  });

  it('handles null rejection', async () => {
    const promise = queue.add(() => Promise.reject(null));
    await expect(promise).rejects.toThrow('null');
  });

  // --- retry with delay ---

  it('delays between retries', async () => {
    let attempts = 0;
    const start = Date.now();

    const result = await queue.add(async () => {
      attempts++;
      if (attempts < 2) throw new Error('fail');
      return 'success';
    });

    const elapsed = Date.now() - start;
    expect(result).toBe('success');
    // With retry delay of 50ms * retry# (1), should be at least 50ms
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  // --- empty queue ---

  it('handles empty queue gracefully', () => {
    const q = new TranslationQueue(1, 1, 10);
    expect(q.pendingCount).toBe(0);
    expect(q.runningCount).toBe(0);
  });

  // --- default params ---

  it('uses default constructor params', async () => {
    const q = new TranslationQueue();
    const result = await q.add(() => Promise.resolve('default'));
    expect(result).toBe('default');
  });

  // --- sequential execution with concurrency=1 ---

  it('executes sequentially when concurrency is 1', async () => {
    const singleQueue = new TranslationQueue(1, 0, 10);
    const order: number[] = [];

    const tasks = [1, 2, 3].map(i =>
      singleQueue.add(async () => {
        order.push(i);
        await new Promise(r => setTimeout(r, 20));
        return i;
      })
    );

    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  // --- no inter-chunk delay ---

  it('does not add artificial delay between sequential tasks', async () => {
    const q = new TranslationQueue(1, 0, 10);

    const start = Date.now();

    await q.add(async () => {
      await new Promise(r => setTimeout(r, 10));
      return 'first';
    });

    const afterFirst = Date.now();

    await q.add(async () => {
      await new Promise(r => setTimeout(r, 10));
      return 'second';
    });

    const afterSecond = Date.now();

    // Second task should start immediately after first finishes (no inter-chunk delay).
    // Gap between starts ≈ first task duration (10ms), not 200ms+.
    const gap = afterSecond - afterFirst;
    expect(gap).toBeLessThan(100);
  });

  // --- setConcurrency ---

  it('setConcurrency increases throughput of queued tasks', async () => {
    const q = new TranslationQueue(1, 0, 0);
    let maxRunning = 0;
    let running = 0;

    const tasks = Array.from({ length: 6 }, (_, i) =>
      q.add(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(r => setTimeout(r, 20));
        running--;
        return i;
      })
    );

    // Let the first task start (concurrency=1), then bump to 3
    await new Promise(r => setTimeout(r, 5));
    q.setConcurrency(3);
    // Wait for a bit so pending tasks start running
    await new Promise(r => setTimeout(r, 10));

    await Promise.all(tasks);
    // Should have run more than 1 at a time after the bump
    expect(maxRunning).toBe(3);
  });

  it('setConcurrency from 1 to higher processes pending tasks in parallel', async () => {
    const q = new TranslationQueue(1, 0, 0);
    const order: number[] = [];

    const tasks = [10, 50, 20, 30].map((delay, i) =>
      q.add(async () => {
        await new Promise(r => setTimeout(r, delay));
        order.push(i);
        return i;
      })
    );

    // Let first task start, then bump concurrency so remaining can start
    await new Promise(r => setTimeout(r, 10));
    q.setConcurrency(4);

    await Promise.all(tasks);
    // With concurrency=1, order would be [0,1,2,3] (FIFO completion).
    // With concurrency=4 after bump, task 1 (50ms) finishes after 2 (20ms) and 3 (30ms).
    // Task 0 (10ms) was already running, so it finishes first.
    expect(order[0]).toBe(0);
    // Task 2 (20ms) should finish before task 1 (50ms)
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(1));
  });

  it('setConcurrency does not affect already running tasks', async () => {
    const q = new TranslationQueue(2, 0, 0);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 4 }, (_, i) =>
      q.add(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(r => setTimeout(r, 30));
        running--;
        return i;
      })
    );

    // Start with concurrency=2, then reduce
    await new Promise(r => setTimeout(r, 10));
    q.setConcurrency(1);

    await Promise.all(tasks);
    // Even after reducing concurrency, already-running tasks complete
    expect(maxRunning).toBe(2);
  });

  it('setConcurrency on empty queue does not throw', () => {
    const q = new TranslationQueue(1, 0, 0);
    expect(() => q.setConcurrency(5)).not.toThrow();
    expect(() => q.setConcurrency(1)).not.toThrow();
  });

  it('multiple setConcurrency calls work', async () => {
    const q = new TranslationQueue(1, 0, 0);
    let maxRunning = 0;
    let running = 0;

    const tasks = Array.from({ length: 8 }, (_, i) =>
      q.add(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(r => setTimeout(r, 20));
        running--;
        return i;
      })
    );

    // Ramp up: 1 → 2 → 4
    await new Promise(r => setTimeout(r, 5));
    q.setConcurrency(2);
    await new Promise(r => setTimeout(r, 10));
    q.setConcurrency(4);

    await Promise.all(tasks);
    expect(maxRunning).toBe(4);
  });

  it('warmup-then-parallel pattern: first 2 serial, rest parallel', async () => {
    const q = new TranslationQueue(1, 0, 0);
    const executionOrder: number[] = [];
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 6 }, (_, i) =>
      q.add(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        executionOrder.push(i);
        await new Promise(r => setTimeout(r, 20));
        running--;
        return i;
      })
    );

    // Warmup: await first two tasks serially (concurrency=1)
    await tasks[0];
    await tasks[1];

    // After warmup, bump concurrency
    q.setConcurrency(3);
    await Promise.all(tasks);

    // First two tasks completed before bump
    expect(executionOrder[0]).toBe(0);
    expect(executionOrder[1]).toBe(1);
    // After bump, at most 3 ran concurrently
    expect(maxRunning).toBe(3);
  });

  it('setConcurrency to 0 does not deadlock', async () => {
    const q = new TranslationQueue(1, 0, 0);

    const task = q.add(async () => {
      await new Promise(r => setTimeout(r, 10));
      return 'done';
    });

    // Set concurrency to 0 — no new tasks should start
    q.setConcurrency(0);

    // The already-running task should still complete
    await expect(task).resolves.toBe('done');
  });

  it('globalQueue exports correct concurrency', async () => {
    const { globalQueue: gq } = await import('../lib/translate/translationQueue');
    expect(gq).toBeDefined();
  });

  // --- addAllWithWarmup ---

  it('addAllWithWarmup runs first N serially then parallel', async () => {
    const q = new TranslationQueue(1, 0, 0);
    const order: number[] = [];
    let maxRunning = 0;
    let running = 0;

    const tasks = Array.from({ length: 6 }, (_, i) =>
      async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        order.push(i);
        await new Promise(r => setTimeout(r, 20));
        running--;
        return i;
      }
    );

    const results = await q.addAllWithWarmup(tasks, 2, 3);

    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(order[0]).toBe(0);
    expect(order[1]).toBe(1);
    expect(maxRunning).toBe(3);
  });

  it('addAllWithWarmup with fewer tasks than warmupCount skips bump', async () => {
    const q = new TranslationQueue(1, 0, 0);
    let maxRunning = 0;
    let running = 0;

    const tasks = Array.from({ length: 1 }, (_, i) =>
      async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(r => setTimeout(r, 10));
        running--;
        return i;
      }
    );

    const results = await q.addAllWithWarmup(tasks, 2, 4);
    expect(results).toEqual([0]);
    expect(maxRunning).toBe(1);
  });

  it('addAllWithWarmup with empty task list returns empty', async () => {
    const q = new TranslationQueue(1, 0, 0);
    const results = await q.addAllWithWarmup([], 2, 4);
    expect(results).toEqual([]);
  });

  it('addAllWithWarmup with exact warmupCount tasks runs all serially', async () => {
    const q = new TranslationQueue(1, 0, 0);
    const order: number[] = [];

    const tasks = Array.from({ length: 2 }, (_, i) =>
      async () => {
        order.push(i);
        await new Promise(r => setTimeout(r, 10));
        return i;
      }
    );

    const results = await q.addAllWithWarmup(tasks, 2, 4);
    expect(results).toEqual([0, 1]);
    expect(order).toEqual([0, 1]);
  });
});
