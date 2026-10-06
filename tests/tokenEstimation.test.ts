/**
 * chunkBuilder.estimateTokens 单测。
 *
 * 估算口径：CJK 字符 0.5 tokens/char，其余 0.25 tokens/char。
 * 原实现 `Math.ceil(text.length / 4)` 对中文严重低估 → chunk 过大 →
 * 上游 API 截断 → 触发重试。这里直接测**生产函数**。
 *
 * 注意：早期版本把 estimateTokens 的实现**复制**进本文件再测，
 * 等于测了一份拷贝，生产代码改了这里也不会红。已改为 import 真实实现。
 */
import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../lib/translate/chunkBuilder';

/** 旧口径，仅用于对比断言（"新方法对 CJK 不再低估"） */
const estimateTokensOld = (text: string): number => Math.ceil(text.length / 4);

describe('estimateTokens', () => {
  it('英文文本：新旧口径接近（0.25/char ≈ 1/4）', () => {
    const text = 'Hello world, this is a test paragraph with some words.';
    expect(estimateTokens(text)).toBeCloseTo(estimateTokensOld(text), 0);
  });

  it('中文文本：不再低估（0.5/char 而非 0.25/char）', () => {
    // 纯 CJK（不含拉丁字母），口径可直接用 0.5 * 长度验证
    const text = '这是一段中文测试文本，用来验证词元估算的准确性。';
    expect(estimateTokens(text)).toBe(Math.ceil(text.length * 0.5));
    expect(estimateTokens(text)).toBeGreaterThan(estimateTokensOld(text));
  });


  it('中英混排：按字符分别计权', () => {
    // 'Hello ' (6) + ' ' (1) + 'world ' (6) = 13 个非 CJK；'你好' + '世界' = 4 个 CJK
    // 13 * 0.25 + 4 * 0.5 = 5.25 → ceil = 6
    expect(estimateTokens('Hello 你好 world 世界')).toBe(6);
  });



  it('空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });



});
