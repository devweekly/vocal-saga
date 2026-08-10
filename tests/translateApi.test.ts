import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock cacheManager
const mockCache = {
  get: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
};

vi.mock('../lib/translate/cacheManager', () => ({
  translationCache: {
    get: (...args: any[]) => mockCache.get(...args),
    set: (...args: any[]) => mockCache.set(...args),
    clear: () => mockCache.clear(),
  },
}));

import {
  processTranslationResult,
  logUnchangedBlocks,
  processTranslationWithCheck,
  getCachedTranslation,
  cacheTranslation,
  clearAllCache,
} from '../lib/translate/translateApi';
import { repairJson, cleanJsonString } from '../lib/translate/service/shared';

describe('processTranslationResult', () => {
  it('parses JSON with translations array', () => {
    const json = JSON.stringify({
      translations: [
        { id: 'b1', translated_text: '你好' },
        { id: 'b2', translated_text: '世界' },
      ],
    });
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('你好');
    expect(result.get('b2')).toBe('世界');
  });

  it('parses JSON with direct array (no translations wrapper)', () => {
    const json = JSON.stringify([
      { id: 'b1', translated_text: '你好' },
      { id: 'b2', translated_text: '世界' },
    ]);
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('你好');
    expect(result.get('b2')).toBe('世界');
  });

  it('returns empty Map for empty translations array', () => {
    const json = JSON.stringify({ translations: [] });
    const result = processTranslationResult(json);
    expect(result.size).toBe(0);
  });

  it('handles single translation item', () => {
    const json = JSON.stringify({
      translations: [{ id: 'b1', translated_text: '单个翻译' }],
    });
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('单个翻译');
  });

  it('preserves empty translated_text', () => {
    const json = JSON.stringify({
      translations: [{ id: 'b1', translated_text: '' }],
    });
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('');
  });

  it('handles items with extra fields', () => {
    const json = JSON.stringify({
      translations: [
        { id: 'b1', translated_text: '你好', confidence: 0.95, extra: 'data' },
      ],
    });
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('你好');
  });

  // 真实场景：prompt 要求 `translated_text` 字段，但模型经常自由发挥用 `text`。
  // 修复前的 hard bug：id 全在、map 全空、content 报 missing。回归测试。
  it('accepts `text` field as fallback (model flattens naming)', () => {
    const json = JSON.stringify({
      translations: [
        { id: 'b66', text: '这处房产位于诺埃街160号' },
        { id: 'b67', text: '另一段翻译' },
      ],
    });
    const result = processTranslationResult(json);
    expect(result.size).toBe(2);
    expect(result.get('b66')).toBe('这处房产位于诺埃街160号');
    expect(result.get('b67')).toBe('另一段翻译');
  });

  it('accepts `translation` field as fallback', () => {
    const json = JSON.stringify({
      translations: [{ id: 'b1', translation: '你好' }],
    });
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('你好');
  });

  it('prefers translated_text over text when both present', () => {
    const json = JSON.stringify({
      translations: [{ id: 'b1', translated_text: '正式译', text: 'fallback' }],
    });
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('正式译');
  });

  it('still rejects entries with neither id nor text', () => {
    const json = JSON.stringify({
      translations: [{ translated_text: 'no id' }, { id: 'b1' }], // 第二条没 text
    });
    const result = processTranslationResult(json);
    expect(result.size).toBe(0);
  });

  it('throws on invalid JSON', () => {
    expect(() => processTranslationResult('not json')).toThrow();
  });
});

describe('logUnchangedBlocks', () => {
  it('returns the original string untouched', () => {
    const raw = JSON.stringify({ translations: [{ id: 'b1', translated_text: '你好' }] });
    const out = logUnchangedBlocks(raw, [{ id: 'b1', text: 'hello' }]);
    expect(out).toBe(raw);
  });

  it('does not throw on invalid JSON', () => {
    expect(() => logUnchangedBlocks('not json', [{ id: 'b1', text: 'x' }])).not.toThrow();
    expect(logUnchangedBlocks('not json', [{ id: 'b1', text: 'x' }])).toBe('not json');
  });

  it('warns when a block came back unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = JSON.stringify({ translations: [{ id: 'b1', translated_text: 'hello' }] });
    logUnchangedBlocks(raw, [{ id: 'b1', text: 'hello' }]);
    expect(warn).toHaveBeenCalled();
    const allArgs = warn.mock.calls.flat().map(String).join(' | ');
    expect(allArgs).toContain('b1');
    warn.mockRestore();
  });

  it('errors when every block came back unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = JSON.stringify({
      translations: [
        { id: 'b1', translated_text: 'hello' },
        { id: 'b2', translated_text: 'world' },
      ],
    });
    logUnchangedBlocks(raw, [
      { id: 'b1', text: 'hello' },
      { id: 'b2', text: 'world' },
    ]);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/ALL/);
    warn.mockRestore();
    err.mockRestore();
  });

  it('warns when response is missing blocks from the input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = JSON.stringify({ translations: [{ id: 'b1', translated_text: '你好' }] });
    logUnchangedBlocks(raw, [
      { id: 'b1', text: 'hello' },
      { id: 'b2', text: 'world' },
    ]);
    const allArgs = warn.mock.calls.flat().map(String).join(' | ');
    expect(allArgs).toMatch(/missing/);
    warn.mockRestore();
  });

  it('is silent when all blocks were translated', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = JSON.stringify({
      translations: [
        { id: 'b1', translated_text: '你好' },
        { id: 'b2', translated_text: '世界' },
      ],
    });
    logUnchangedBlocks(raw, [
      { id: 'b1', text: 'hello' },
      { id: 'b2', text: 'world' },
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('accepts the bare-array form (no translations wrapper)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = JSON.stringify([{ id: 'b1', translated_text: 'hello' }]);
    logUnchangedBlocks(raw, [{ id: 'b1', text: 'hello' }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // 配套：logUnchangedBlocks 也得认 `text` 字段，否则 `unchanged` 统计会漏。
  it('detects unchanged blocks when model uses `text` field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = JSON.stringify({ translations: [{ id: 'b1', text: 'hello' }] });
    logUnchangedBlocks(raw, [{ id: 'b1', text: 'hello' }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });
});

describe('getCachedTranslation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when cache is empty', async () => {
    mockCache.get.mockResolvedValue(null);
    const result = await getCachedTranslation('test-key');
    expect(result).toBeNull();
  });

  it('returns Map from cached plain object', async () => {
    mockCache.get.mockResolvedValue({ b1: '你好', b2: '世界' });
    const result = await getCachedTranslation('test-key');
    expect(result).toBeInstanceOf(Map);
    expect(result?.get('b1')).toBe('你好');
    expect(result?.get('b2')).toBe('世界');
    expect(result?.size).toBe(2);
  });

  it('returns empty Map for empty object', async () => {
    mockCache.get.mockResolvedValue({});
    const result = await getCachedTranslation('test-key');
    expect(result).toBeInstanceOf(Map);
    expect(result?.size).toBe(0);
  });

  it('handles single entry', async () => {
    mockCache.get.mockResolvedValue({ b1: '单个翻译' });
    const result = await getCachedTranslation('test-key');
    expect(result?.get('b1')).toBe('单个翻译');
  });
});

describe('cacheTranslation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores Map as plain object with 7-day TTL', async () => {
    const data = new Map([
      ['b1', '你好'],
      ['b2', '世界'],
    ]);
    await cacheTranslation('test-key', data);

    expect(mockCache.set).toHaveBeenCalledTimes(1);
    const [key, storedObj, ttl] = mockCache.set.mock.calls[0];
    expect(key).toBe('test-key');
    expect(storedObj).toEqual({ b1: '你好', b2: '世界' });
    expect(ttl).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('stores empty Map', async () => {
    await cacheTranslation('test-key', new Map());
    expect(mockCache.set).toHaveBeenCalledWith('test-key', {}, 7 * 24 * 60 * 60 * 1000);
  });

  it('stores single entry', async () => {
    const data = new Map([['b1', '单个翻译']]);
    await cacheTranslation('test-key', data);
    const [, storedObj] = mockCache.set.mock.calls[0];
    expect(storedObj).toEqual({ b1: '单个翻译' });
  });
});

describe('clearAllCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the translation cache', async () => {
    await clearAllCache();
    expect(mockCache.clear).toHaveBeenCalledTimes(1);
  });

  it('throws if cache clear fails', async () => {
    mockCache.clear.mockRejectedValueOnce(new Error('Storage error'));
    await expect(clearAllCache()).rejects.toThrow('Storage error');
  });
});

describe('processTranslationWithCheck — JSON cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles trailing comma in object', () => {
    const json = '{"translations":[{"id":"b1","translated_text":"你好",}]}';
    const result = processTranslationWithCheck(json);
    expect(result.get('b1')).toBe('你好');
  });

  it('handles trailing comma in array', () => {
    const json = '{"translations":[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世界",}]}';
    const result = processTranslationWithCheck(json);
    expect(result.size).toBe(2);
  });

  it('handles multiple trailing commas', () => {
    const json = '{"translations":[{"id":"b1","translated_text":"你好",},]}';
    const result = processTranslationWithCheck(json);
    expect(result.get('b1')).toBe('你好');
  });

  it('handles valid JSON without cleanup', () => {
    const json = '{"translations":[{"id":"b1","translated_text":"你好"}]}';
    const result = processTranslationWithCheck(json);
    expect(result.get('b1')).toBe('你好');
  });

  it('repairs truncated JSON with unclosed last string', () => {
    // jsonrepair 比 repairTruncatedJson 更优：保留不完整字符串已写出的部分内容，
    // 用户能看到部分翻译而不是丢失整个块。
    const json = '{"translations":[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世';
    const result = processTranslationWithCheck(json);
    expect(result.get('b1')).toBe('你好');
    expect(result.get('b2')).toBe('世');
  });

  it('repairs truncated JSON with unclosed object and array', () => {
    const json = '{"translations":[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世界"';
    const result = processTranslationWithCheck(json);
    expect(result.get('b1')).toBe('你好');
    expect(result.get('b2')).toBe('世界');
  });

  it('repairs truncated JSON after a complete earlier item', () => {
    const json = '{"translations":[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世界"}, {"id":"b3","translated_text":"foo';
    const result = processTranslationWithCheck(json);
    expect(result.get('b1')).toBe('你好');
    expect(result.get('b2')).toBe('世界');
    expect(result.get('b3')).toBe('foo');
  });

  it('repairs bare array truncated JSON', () => {
    const json = '[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世界"';
    const result = processTranslationWithCheck(json);
    expect(result.get('b1')).toBe('你好');
    expect(result.get('b2')).toBe('世界');
  });
});

describe('repairJson', () => {
  it('returns valid JSON unchanged', () => {
    const json = '{"translations":[{"id":"b1","translated_text":"你好"}]}';
    expect(repairJson(json)).toBe(json);
  });

  it('repairs unclosed trailing string and preserves partial content', () => {
    // jsonrepair 比 repairTruncatedJson 更优：保留不完整字符串的内容
    // （原手写实现会丢弃整个 b2 块，jsonrepair 保留 b2 + 部分翻译）
    const raw = '{"translations":[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世';
    const repaired = repairJson(raw);
    expect(JSON.parse(repaired)).toEqual({
      translations: [
        { id: 'b1', translated_text: '你好' },
        { id: 'b2', translated_text: '世' },
      ],
    });
  });

  it('repairs unclosed object and outer array/object', () => {
    const raw = '{"translations":[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世界"';
    const repaired = repairJson(raw);
    expect(JSON.parse(repaired)).toEqual({
      translations: [
        { id: 'b1', translated_text: '你好' },
        { id: 'b2', translated_text: '世界' },
      ],
    });
  });

  it('repairs trailing comma before truncation', () => {
    const raw = '{"translations":[{"id":"b1","translated_text":"你好"},';
    const repaired = repairJson(raw);
    expect(JSON.parse(repaired)).toEqual({ translations: [{ id: 'b1', translated_text: '你好' }] });
  });

  it('repairs single quotes to double quotes', () => {
    // jsonrepair 覆盖的额外场景：单引号 → 双引号（手写 repairTruncatedJson 不支持）
    const raw = "{'translations':[{'id':'b1','translated_text':'你好'}]}";
    const repaired = repairJson(raw);
    expect(JSON.parse(repaired)).toEqual({ translations: [{ id: 'b1', translated_text: '你好' }] });
  });

  it('repairs missing comma between properties', () => {
    // jsonrepair 覆盖的额外场景：缺逗号（手写 repairTruncatedJson 不支持）
    const raw = '{"translations":[{"id":"b1" "translated_text":"你好"}]}';
    const repaired = repairJson(raw);
    expect(JSON.parse(repaired)).toEqual({ translations: [{ id: 'b1', translated_text: '你好' }] });
  });

  it('throws when input is non-JSON text (defensive guard)', () => {
    // 防御：jsonrepair 对纯文本会包装成字符串 '"not json at all"'，
    // 包装函数校验修复结果必须是 object/array，否则抛错让上层走错误处理路径。
    expect(() => repairJson('not json at all')).toThrow();
  });
});

describe('cleanJsonString', () => {
  it('removes trailing comma before } and ]', () => {
    expect(cleanJsonString('{"a":1,}')).toBe('{"a":1}');
    expect(cleanJsonString('{"a":[1,2,]}')).toBe('{"a":[1,2]}');
  });

  it('returns valid JSON unchanged', () => {
    const json = '{"translations":[{"id":"b1","translated_text":"你好"}]}';
    expect(cleanJsonString(json)).toBe(json);
  });

  it('fixes duplicated leading quote in property name (DeepSeek 偶发输出错误)', () => {
    // 真实生产 bug：DeepSeek 在 "id": "b1", 后输出 " "text": （前导多了一个引号），
    // JSON.parse 报 "Expected ':' after property name at position 55"。
    // 修复后应能正常解析。
    const raw = '{\n  "translations": [\n    {\n      "id": "b1",\n      " "text": "InfoQ 首页"\n    }\n  ]\n}';
    const cleaned = cleanJsonString(raw);
    expect(cleaned).not.toContain('" "text"');
    expect(cleaned).toContain('"text":');
    const parsed = JSON.parse(cleaned);
    expect(parsed.translations[0].text).toBe('InfoQ 首页');
  });

  it('fixes duplicated leading quote for multiple properties', () => {
    // 多个 property 同时出现重复引号时一次性修复
    const raw = '{\n  " "text": "a",\n  " "translated_text": "b"\n}';
    const cleaned = cleanJsonString(raw);
    expect(JSON.parse(cleaned)).toEqual({ text: 'a', translated_text: 'b' });
  });

  it('does not break合法 " " property name (空字符串 name with spaces)', () => {
    // 限定上下文修复，不应误伤合法的空字符串 property name（虽然极少见）
    // 此处验证包含空格但前后没有逗号/花括号的情况
    const json = '{"a": " " , "b": 1}';
    // 修复后 `:` 后的空字符串值仍应保留
    expect(cleanJsonString(json)).toBe('{"a": " " , "b": 1}');
  });

  it('fixes duplicated quote after comma with newlines and spaces', () => {
    // 模拟真实生产场景：逗号 + 换行 + 多空格 + " + 空格 + " + 标识符
    const raw = '{"id":"b1",\n      " "text":"hello"}';
    const cleaned = cleanJsonString(raw);
    expect(JSON.parse(cleaned)).toEqual({ id: 'b1', text: 'hello' });
  });
});

describe('processTranslationWithCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses JSON and returns Map without originalBlocks', () => {
    const json = JSON.stringify({
      translations: [
        { id: 'b1', translated_text: '你好' },
        { id: 'b2', translated_text: '世界' },
      ],
    });
    const result = processTranslationWithCheck(json);
    expect(result.get('b1')).toBe('你好');
    expect(result.get('b2')).toBe('世界');
  });

  it('parses JSON and returns Map with originalBlocks', () => {
    const json = JSON.stringify({
      translations: [
        { id: 'b1', translated_text: '你好' },
        { id: 'b2', translated_text: '世界' },
      ],
    });
    const original = [
      { id: 'b1', text: 'hello' },
      { id: 'b2', text: 'world' },
    ];
    const result = processTranslationWithCheck(json, original);
    expect(result.get('b1')).toBe('你好');
    expect(result.get('b2')).toBe('世界');
  });

  it('warns when a block came back unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const json = JSON.stringify({ translations: [{ id: 'b1', translated_text: 'hello' }] });
    const original = [{ id: 'b1', text: 'hello' }];
    processTranslationWithCheck(json, original);
    expect(warn).toHaveBeenCalled();
    const allArgs = warn.mock.calls.flat().map(String).join(' | ');
    expect(allArgs).toContain('b1');
    warn.mockRestore();
  });

  it('errors when every block came back unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const json = JSON.stringify({
      translations: [
        { id: 'b1', translated_text: 'hello' },
        { id: 'b2', translated_text: 'world' },
      ],
    });
    const original = [
      { id: 'b1', text: 'hello' },
      { id: 'b2', text: 'world' },
    ];
    processTranslationWithCheck(json, original);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/ALL/);
    warn.mockRestore();
    err.mockRestore();
  });

  it('warns when response is missing blocks from the input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const json = JSON.stringify({ translations: [{ id: 'b1', translated_text: '你好' }] });
    const original = [
      { id: 'b1', text: 'hello' },
      { id: 'b2', text: 'world' },
    ];
    processTranslationWithCheck(json, original);
    const allArgs = warn.mock.calls.flat().map(String).join(' | ');
    expect(allArgs).toMatch(/missing/);
    warn.mockRestore();
  });

  it('warns on suspect mapping (short title got long paragraph — block-id misalignment)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 模拟 mitsloan 故障：标题（短）拿到了正文段落（长）的译文
    const json = JSON.stringify({
      translations: [
        {
          id: 'b3',
          translated_text:
            '人们越来越多地转向人工智能寻求财务建议。最近的一项研究发现，当被正确引导时，人工智能给出的建议质量出奇地高。研究还表明，提问的方式会显著影响回答的质量。',
        },
      ],
    });
    const original = [
      {
        id: 'b3',
        text: 'AI financial advice is surprisingly good especially if you ask the right questions',
      },
    ];
    processTranslationWithCheck(json, original);
    const allArgs = warn.mock.calls.flat().map(String).join(' | ');
    expect(allArgs).toMatch(/suspect mapping/);
    expect(allArgs).toContain('b3');
    warn.mockRestore();
  });

  it('does NOT flag a normal short title → short translation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const json = JSON.stringify({
      translations: [{ id: 'b3', translated_text: '人工智能理财建议出奇地好' }],
    });
    const original = [
      { id: 'b3', text: 'AI financial advice is surprisingly good' },
    ];
    processTranslationWithCheck(json, original);
    const allArgs = warn.mock.calls.flat().map(String).join(' | ');
    expect(allArgs).not.toMatch(/suspect mapping/);
    warn.mockRestore();
  });

  it('does NOT flag a normal body paragraph → body translation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const json = JSON.stringify({
      translations: [
        {
          id: 'b10',
          translated_text:
            '人们越来越多地转向人工智能寻求财务建议。研究发现提问方式会显著影响回答质量。',
        },
      ],
    });
    const original = [
      {
        id: 'b10',
        text: 'People are increasingly turning to AI for financial advice. A study found that the way questions are asked significantly affects answer quality.',
      },
    ];
    processTranslationWithCheck(json, original);
    const allArgs = warn.mock.calls.flat().map(String).join(' | ');
    expect(allArgs).not.toMatch(/suspect mapping/);
    warn.mockRestore();
  });

  it('accepts text field as fallback', () => {
    const json = JSON.stringify({
      translations: [
        { id: 'b1', text: '你好' },
        { id: 'b2', text: '世界' },
      ],
    });
    const result = processTranslationWithCheck(json);
    expect(result.size).toBe(2);
    expect(result.get('b1')).toBe('你好');
    expect(result.get('b2')).toBe('世界');
  });

  it('throws on invalid JSON', () => {
    expect(() => processTranslationWithCheck('not json')).toThrow();
  });
});
