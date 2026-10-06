/**
 * runWithConcurrency 单测。
 *
 * 覆盖重点：
 *   - 并发度真的被限制住（这是修复 P0-3 的核心断言：旧实现用
 *     chunks.map + Promise.all，concurrency 只进日志不生效，全部一次性发出）
 *   - 全部任务都被执行，不重不漏
 *   - limit 非法时钳制而不是崩掉或退化成全并发
 *   - fail-fast：任一任务抛错立即向上抛，且不产生 unhandled rejection
 */
import { describe, it, expect, vi } from 'vitest';
import { runWithConcurrency } from '../lib/translate/concurrency';

/** 让出事件循环若干次，给在飞任务推进的机会 */
const tick = (times = 6) =>
  (async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  })();

describe('runWithConcurrency', () => {
  it('并发度不超过 limit（limit=2、任务 10 个）', async () => {
    let inFlight = 0;
    let peak = 0;

    await runWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      2,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    );

    expect(peak).toBe(2);
  });


  it('所有任务恰好各执行一次，不重不漏', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];

    await runWithConcurrency(items, 4, async (item) => {
      seen.push(item);
      await new Promise((r) => setTimeout(r, 1));
    });

    expect(seen.length).toBe(50);
    expect(new Set(seen).size).toBe(50);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });


  it('空列表直接返回，不调用 worker', async () => {
    const worker = vi.fn();
    await runWithConcurrency([], 4, worker);
    expect(worker).not.toHaveBeenCalled();
  });

  describe('limit 钳制', () => {
    it('limit=0 退化为串行而不是 0 并发（否则任务永不执行）', async () => {
      let inFlight = 0;
      let peak = 0;
      const seen: number[] = [];

      await runWithConcurrency([1, 2, 3], 0, async (item) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(1);
        inFlight--;
        seen.push(item);
      });

      expect(seen.length).toBe(3);
      expect(peak).toBe(1);
    });



  });

  describe('异常处理', () => {
    it('任一任务抛错则整体 reject（fail-fast）', async () => {
      await expect(
        runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 2, async (item) => {
          if (item === 3) throw new Error('boom');
          await new Promise((r) => setTimeout(r, 1));
        })
      ).rejects.toThrow('boom');
    });

    it('抛错后不再调度新任务', async () => {
      const started: number[] = [];
      await expect(
        runWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 1, async (item) => {
          started.push(item);
          if (item === 1) throw new Error('stop');
        })
      ).rejects.toThrow('stop');

      // 串行执行，第 2 个任务抛错后应立刻停住
      expect(started).toEqual([0, 1]);
    });

  });
});
