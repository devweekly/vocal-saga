import type { DocumentSegment } from './types';

/**
 * 预算化分批（FluentRead 的 budgeted batching 思路，独立实现）。
 *
 * 为什么不"整篇丢给模型"：
 *   - 单次请求有上下文与输出上限，长文档必然被截断
 *   - 分批后可以逐段提交（per-segment commit）：某批失败只重跑该批，
 *     已完成的译文不丢，刷新/断网能续跑 —— 这是长文档翻译体验的分水岭
 *   - 批次内保留相邻上下文，翻译质量接近整篇
 */

export interface BatchBudget {
  /** 单批最大字符数（中文按 1 char 计，保守取值）。 */
  maxChars: number;
  /** 单批最大片段数，避免一次塞几千条字幕。 */
  maxSegments: number;
}

export const DEFAULT_BUDGET: BatchBudget = {
  maxChars: 3000,
  maxSegments: 24,
};

/**
 * 贪心装箱：按顺序累积，超出任一预算就切一批。
 * 单个片段自己就超预算时独立成批（不切碎，避免句子断裂）。
 */
export function buildSegmentBatches(
  segments: DocumentSegment[],
  budget: Partial<BatchBudget> = {},
): DocumentSegment[][] {
  const { maxChars, maxSegments } = { ...DEFAULT_BUDGET, ...budget };
  const batches: DocumentSegment[][] = [];
  let current: DocumentSegment[] = [];
  let chars = 0;

  for (const segment of segments) {
    const size = segment.text.length;
    const overChars = current.length > 0 && chars + size > maxChars;
    const overCount = current.length >= maxSegments;
    if (overChars || overCount) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += size;
  }

  if (current.length) batches.push(current);
  return batches;
}

/** 估算总字符数，用于 UI 展示"预计消耗"。 */
export function estimateChars(segments: DocumentSegment[]): number {
  return segments.reduce((n, s) => n + s.text.length, 0);
}
