import { describe, it, expect } from 'vitest';
import {
  validateTranslationCompleteness,
  isHealthyTranslation,
} from '../lib/translate/translationValidator';

// 构造长度 > 100 的 HTML（满足 validateTranslationCompleteness 的最小长度阈值）
function wrap(body: string): string {
  return `<html><body>${body}</body></html>`;
}

// 一段够长的填充文本，避免测试 HTML 触发 "过短或为空" 检查
const FILLER = '这是一段足够长的填充文本用于绕过长度阈值校验，' + 'x'.repeat(60);

describe('validateTranslationCompleteness', () => {
  it('rejects empty html', () => {
    const result = validateTranslationCompleteness('');
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('过短');
  });

  it('rejects html shorter than 100 chars', () => {
    const result = validateTranslationCompleteness('<html><body>short</body></html>');
    expect(result.healthy).toBe(false);
  });

  it('rejects html without <html> tag', () => {
    // 长度 > 100 但没有 <html> 标签
    const html = '<div>' + 'x'.repeat(200) + '</div>';
    const result = validateTranslationCompleteness(html);
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('<html>');
  });

  it('rejects html without translation markers', () => {
    const html = wrap('<p>' + 'hello world '.repeat(20) + '</p>');
    const result = validateTranslationCompleteness(html);
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('翻译标记');
  });

  it('accepts html with translation markers', () => {
    const html = wrap(
      `<p>${FILLER}</p>` +
        '<p class="fanyi-original">hello</p>' +
        '<p class="fanyi-translation">你好</p>',
    );
    const result = validateTranslationCompleteness(html);
    expect(result.healthy).toBe(true);
    expect(result.translatedCount).toBeGreaterThan(0);
    expect(result.blockCount).toBeGreaterThan(0);
  });

  it('rejects when translation count below expected', () => {
    // 只有 1 个翻译标记，要求 100 个 → 远低于 90（10% 误差下限）
    const html = wrap(
      `<p>${FILLER}</p>` + '<p class="fanyi-translation">你好</p>',
    );
    const result = validateTranslationCompleteness(html, 100);
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('不完整');
  });

  it('accepts when translation count meets expected (within 10% tolerance)', () => {
    // 100 个 .fanyi-translation，要求 100 → 100 >= floor(100 * 0.9) = 90 ✓
    const blocks = Array.from({ length: 100 }, (_, i) =>
      `<p class="fanyi-translation">译文 ${i}</p>`,
    ).join('');
    const html = wrap(blocks);
    const result = validateTranslationCompleteness(html, 100);
    expect(result.healthy).toBe(true);
  });

  it('rejects when more than 50% translations are empty', () => {
    // 4 个空翻译 + 1 个非空 → 1/5 = 20% 非空，小于 50%
    const blocks =
      '<p class="fanyi-translation"></p>' +
      '<p class="fanyi-translation"></p>' +
      '<p class="fanyi-translation"></p>' +
      '<p class="fanyi-translation"></p>' +
      '<p class="fanyi-translation">仅有的非空译文</p>';
    const html = wrap(`<p>${FILLER}</p>${blocks}`);
    const result = validateTranslationCompleteness(html);
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('50%');
  });

  it('accepts when at least 50% translations are non-empty', () => {
    // 2 个非空 + 2 个空 → 2/4 = 50% 非空，恰好满足（>= 50%）
    const blocks =
      '<p class="fanyi-translation">非空 1</p>' +
      '<p class="fanyi-translation">非空 2</p>' +
      '<p class="fanyi-translation"></p>' +
      '<p class="fanyi-translation"></p>';
    const html = wrap(`<p>${FILLER}</p>${blocks}`);
    const result = validateTranslationCompleteness(html);
    expect(result.healthy).toBe(true);
    expect(result.translatedCount).toBe(2);
  });

  it('detects data-fanyi-translated attribute as a marker', () => {
    const html = wrap(
      `<p>${FILLER}</p>` +
        '<p data-fanyi-translated="true">译文内容</p>',
    );
    const result = validateTranslationCompleteness(html);
    expect(result.healthy).toBe(true);
  });

  it('returns blockCount as max of translation/original markers', () => {
    const html = wrap(
      '<p class="fanyi-original">原文 1</p><p class="fanyi-translation">译文 1</p>' +
        '<p class="fanyi-original">原文 2</p><p class="fanyi-translation">译文 2</p>' +
        '<p class="fanyi-original">原文 3</p>' +
        `<p>${FILLER}</p>`,
    );
    const result = validateTranslationCompleteness(html);
    expect(result.healthy).toBe(true);
    // 3 个 fanyi-original + 2 个 fanyi-translation → max = 3
    expect(result.blockCount).toBe(3);
  });
});

describe('isHealthyTranslation', () => {
  it('returns boolean matching validateTranslationCompleteness.healthy', () => {
    expect(isHealthyTranslation('')).toBe(false);
    const good = wrap(
      `<p>${FILLER}</p>` + '<p class="fanyi-translation">你好</p>',
    );
    expect(isHealthyTranslation(good)).toBe(true);
  });

  it('passes expectedBlockCount through', () => {
    const html = wrap(
      `<p>${FILLER}</p>` + '<p class="fanyi-translation">你好</p>',
    );
    expect(isHealthyTranslation(html, 100)).toBe(false);
  });
});
