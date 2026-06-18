import { describe, it, expect } from 'vitest';
import { estimateMaxTokens } from '../lib/translate/service/shared';

describe('estimateMaxTokens', () => {
  it('returns at least 2048 for empty input', () => {
    expect(estimateMaxTokens('')).toBe(2048);
  });

  it('scales with input length', () => {
    // 1000 字符的 JSON，估算输入 tokens ≈ 500，输出余量 6x → 3000，再被 2048 兜底
    const small = 'x'.repeat(1000);
    expect(estimateMaxTokens(small)).toBe(3000);

    // 10000 字符的 JSON，估算输入 tokens ≈ 5000，输出余量 6x → 30000
    const medium = 'x'.repeat(10000);
    expect(estimateMaxTokens(medium)).toBe(30_000);
  });

  it('caps at 131072', () => {
    const huge = 'x'.repeat(1_000_000);
    expect(estimateMaxTokens(huge)).toBe(131_072);
  });

  it('uses 6x headroom for Chinese text', () => {
    // 1000 个汉字，估算输入 tokens ≈ 500，输出余量 6x → 3000
    const text = '中'.repeat(1000);
    expect(estimateMaxTokens(text)).toBe(3000);

    // 10000 个汉字，估算输入 tokens ≈ 5000，输出余量 6x → 30000
    const medium = '中'.repeat(10000);
    expect(estimateMaxTokens(medium)).toBe(30_000);
  });
});
