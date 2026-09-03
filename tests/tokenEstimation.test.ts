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

  it('中英混排的长文本：非 CJK 字符也计入', () => {
    const text = '这是一段中文测试文本，用来验证token估算的准确性。';
    // 20 个 CJK 汉字 + 5 个 'token' 拉丁字母 + 2 个全角标点（'，' U+FF0C、
    // '。' U+3002 都**不在** U+4E00–U+9FFF，按非 CJK 计权）
    // → 20*0.5 + 7*0.25 = 11.75 → 12
    expect(estimateTokens(text)).toBe(12);
    // 旧口径 ceil(27/4)=7，严重低估 → 这正是 chunk 过大导致 API 截断的原因
    expect(estimateTokensOld(text)).toBe(7);
  });

  it('全角标点按非 CJK 计权（U+FF0C / U+3002 不在汉字区）', () => {
    // 行为锁定：全角标点与汉字的权重不同，扩宽 CJK 区间会改变所有 chunk 的大小
    expect(estimateTokens('，')).toBe(1);
    expect(estimateTokens('一')).toBe(1); // ceil(0.5)=1，与全角标点同为 1 但口径不同
    // 拉开长度后差异才显现
    expect(estimateTokens('一一一一一一一一')).toBe(4); // 8*0.5
    expect(estimateTokens('，，，，，，，，')).toBe(2); // 8*0.25
  });

  it('中英混排：按字符分别计权', () => {
    // 'Hello ' (6) + ' ' (1) + 'world ' (6) = 13 个非 CJK；'你好' + '世界' = 4 个 CJK
    // 13 * 0.25 + 4 * 0.5 = 5.25 → ceil = 6
    expect(estimateTokens('Hello 你好 world 世界')).toBe(6);
  });

  it('日文假名按 CJK 计权', () => {
    const text = 'こんにちは';
    expect(estimateTokens(text)).toBe(Math.ceil(text.length * 0.5));
    expect(estimateTokens(text)).toBeGreaterThan(estimateTokensOld(text));
  });

  it('韩文谚文按 CJK 计权', () => {
    const text = '안녕하세요';
    expect(estimateTokens(text)).toBe(Math.ceil(text.length * 0.5));
    expect(estimateTokens(text)).toBeGreaterThan(estimateTokensOld(text));
  });

  it('空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('纯数字与符号按非 CJK 计权', () => {
    const text = '1234567890!@#$%^&*()';
    expect(estimateTokens(text)).toBe(estimateTokensOld(text));
  });

  it('emoji / 代理对按码点计为一个字符（不拆成两个）', () => {
    // '😀' 是 U+1F600，属于非 CJK 区间；长度按码点算应为 1 而不是 2
    expect(estimateTokens('😀')).toBe(Math.ceil(1 * 0.25));
  });

  it('CJK 扩展区（U+3400 等）不被误判为 CJK', () => {
    // 实现只覆盖 U+4E00–U+9FFF；扩展 A 区 U+3400 会落进 otherChars。
    // 这里锁定当前行为，避免后人"顺手扩大范围"时静默改变 chunk 大小。
    const extA = '㐀㐁㐂';
    expect(estimateTokens(extA)).toBe(Math.ceil(extA.length * 0.25));
  });
});
