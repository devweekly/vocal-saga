import { describe, it, expect } from 'vitest';
import {
  countSentences,
  validateBlockMapping,
} from '../lib/translate/mappingValidator';

describe('countSentences', () => {
  it('returns 0 for empty string', () => {
    expect(countSentences('')).toBe(0);
  });

  it('counts a single English sentence (no terminal punctuation)', () => {
    expect(countSentences('AI financial advice is surprisingly good')).toBe(1);
  });

  it('counts multiple English sentences', () => {
    expect(countSentences('First sentence. Second sentence. Third one.')).toBe(3);
  });

  it('counts Chinese sentences by 。！？', () => {
    expect(countSentences('人工智能。财务建议！很好？')).toBe(3);
  });

  it('ignores pure-symbol/no-letter fragments', () => {
    expect(countSentences('123. !@#。')).toBe(0);
  });

  it('treats newlines as sentence separators', () => {
    expect(countSentences('Line one\nLine two\nLine three')).toBe(3);
  });
});

describe('validateBlockMapping', () => {
  it('flags short original paired with very long translation (title got body)', () => {
    const verdict = validateBlockMapping(
      'AI financial advice is surprisingly good especially if you ask the right questions',
      '人们越来越多地转向人工智能寻求财务建议。最近的一项研究发现，当被正确引导时，人工智能给出的建议质量出奇地高。研究还表明，提问的方式会显著影响回答的质量。'
    );
    expect(verdict.suspect).toBe(true);
    expect(verdict.reasons.join('; ')).toMatch(/译文过长|句子数激增/);
  });

  it('flags long original paired with very short translation (body got title)', () => {
    const verdict = validateBlockMapping(
      'People are increasingly turning to AI for financial advice. A study found that the way questions are asked significantly affects answer quality. Researchers tested several prompting strategies across multiple models.',
      '人工智能理财建议。'
    );
    expect(verdict.suspect).toBe(true);
  });

  it('does NOT flag a normal short title → short translation', () => {
    const verdict = validateBlockMapping(
      'AI financial advice is surprisingly good',
      '人工智能理财建议出奇地好'
    );
    expect(verdict.suspect).toBe(false);
  });

  it('does NOT flag a normal body paragraph → body translation', () => {
    const verdict = validateBlockMapping(
      'People are increasingly turning to AI for financial advice. A study found that the way questions are asked significantly affects answer quality.',
      '人们越来越多地转向人工智能寻求财务建议。研究发现提问方式会显著影响回答质量。'
    );
    expect(verdict.suspect).toBe(false);
  });

  it('flags empty original with non-empty translation', () => {
    const verdict = validateBlockMapping('', '人工智能理财建议');
    expect(verdict.suspect).toBe(true);
    expect(verdict.reasons.join('; ')).toMatch(/原文为空/);
  });

  it('does NOT flag identical empty strings', () => {
    const verdict = validateBlockMapping('', '');
    expect(verdict.suspect).toBe(false);
  });

  it('respects custom options (stricter bounds)', () => {
    const verdict = validateBlockMapping(
      'short text here',
      '这是一段明显过长的译文用来测试自定义阈值的触发情况是否符合预期设定',
      { maxCharRatio: 2, minAbsoluteChars: 10 }
    );
    expect(verdict.suspect).toBe(true);
  });
});
