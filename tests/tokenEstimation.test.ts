import { describe, it, expect } from 'vitest';

/**
 * 测试 token 估算优化。
 *
 * 原实现：Math.ceil(text.length / 4) — 对中文严重低估。
 * 优化后：CJK 字符按 0.5 tokens/char，拉丁文按 0.25 tokens/char。
 */

// 从 chunkBuilder 导出 estimateTokens（需要先 export）
// 这里测试新的估算逻辑

function estimateTokensOld(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateTokensNew(text: string): number {
  let cjkChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified
      (code >= 0x3040 && code <= 0x309f) ||   // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) ||   // Katakana
      (code >= 0xac00 && code <= 0xd7af)      // Hangul
    ) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(cjkChars * 0.5 + otherChars * 0.25);
}

describe('token estimation', () => {
  it('English text: both methods similar', () => {
    const text = 'Hello world, this is a test paragraph with some words.';
    const old = estimateTokensOld(text);
    const new_ = estimateTokensNew(text);
    // 英文：旧方法 ceil(55/4)=14，新方法 ceil(55*0.25)=14
    expect(new_).toBeCloseTo(old, 0);
  });

  it('CJK text: new method estimates more tokens', () => {
    const text = '这是一段中文测试文本，用来验证token估算的准确性。';
    const old = estimateTokensOld(text);
    const new_ = estimateTokensNew(text);
    // 中文：旧方法严重低估
    // 旧：ceil(23/4)=6
    // 新：ceil(23*0.5)=12
    expect(new_).toBeGreaterThan(old);
  });

  it('mixed text: reasonable estimation', () => {
    const text = 'Hello 你好 world 世界';
    const old = estimateTokensOld(text);
    const new_ = estimateTokensNew(text);
    // 混合文本：新方法应该更准确
    expect(new_).toBeGreaterThanOrEqual(old);
  });

  it('Japanese hiragana: counted as CJK', () => {
    const text = 'こんにちは';
    const old = estimateTokensOld(text);
    const new_ = estimateTokensNew(text);
    // 日文：旧 ceil(5/4)=2，新 ceil(5*0.5)=3
    expect(new_).toBeGreaterThan(old);
  });

  it('Korean hangul: counted as CJK', () => {
    const text = '안녕하세요';
    const old = estimateTokensOld(text);
    const new_ = estimateTokensNew(text);
    // 韩文：旧 ceil(5/4)=2，新 ceil(5*0.5)=3
    expect(new_).toBeGreaterThan(old);
  });

  it('empty string: returns 0', () => {
    expect(estimateTokensNew('')).toBe(0);
  });

  it('numbers and symbols: treated as non-CJK', () => {
    const text = '1234567890!@#$%^&*()';
    const old = estimateTokensOld(text);
    const new_ = estimateTokensNew(text);
    // 纯数字/符号：新旧方法相同
    expect(new_).toBe(old);
  });
});
