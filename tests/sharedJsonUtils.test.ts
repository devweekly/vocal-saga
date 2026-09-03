/**
 * lib/translate/service/shared.ts 的 JSON 工具函数单测。
 *
 * 重点是 `extractJsonContainer` 的**截断不丢 block** 回归保护：
 * 早期实现用 `lastIndexOf(close)` 找闭合括号，对截断 JSON 会命中
 * 「最后一个完整 block 的 `}`」，切出一段合法但不完整的 JSON，
 * 导致下游 `JSON.parse` 直接成功、jsonrepair 被绕过，
 * 尾部不完整的 block 被静默丢弃。现改为配平扫描，本文件锁定该行为。
 */
import { describe, it, expect } from 'vitest';
import { extractJsonContainer, repairJson, cleanJsonString } from '../lib/translate/service/shared';

describe('extractJsonContainer', () => {
  describe('截断场景：必须保留到末尾，不得静默丢 block（回归）', () => {
    it('截断在未闭合字符串内时保留最后一个 block 的部分内容', () => {
      const raw = '{"translations":[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世';
      const out = extractJsonContainer(raw);
      // 关键：不得切到 b1 的 `}` 就停 —— b2 必须还在
      expect(out).toContain('b2');
      expect(out.endsWith('"世')).toBe(true);
      // 交给 jsonrepair 后两个 block 都能救回来
      expect(JSON.parse(repairJson(cleanJsonString(out)))).toEqual({
        translations: [
          { id: 'b1', translated_text: '你好' },
          { id: 'b2', translated_text: '世' },
        ],
      });
    });

    it('截断在对象/数组闭合缺失时保留最后一个 block', () => {
      const raw = '{"translations":[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世界"';
      const out = extractJsonContainer(raw);
      expect(out).toContain('b2');
      expect(JSON.parse(repairJson(cleanJsonString(out))).translations).toHaveLength(2);
    });

    it('完整 block 之后的截断不丢尾部 block（3 block 场景）', () => {
      const raw =
        '{"translations":[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世界"}, {"id":"b3","translated_text":"foo';
      const out = extractJsonContainer(raw);
      expect(out).toContain('b3');
      expect(JSON.parse(repairJson(cleanJsonString(out))).translations).toHaveLength(3);
    });

    it('裸数组截断同样保留尾部', () => {
      const raw = '[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世界"';
      const out = extractJsonContainer(raw);
      expect(out).toContain('b2');
      expect(JSON.parse(repairJson(cleanJsonString(out)))).toHaveLength(2);
    });

    it('截断后接 markdown 结尾标记也能保留内容', () => {
      const raw = '{"translations":[{"id":"b1","translated_text":"你好"},{"id":"b2","translated_text":"世界"\n```';
      const out = extractJsonContainer(raw);
      expect(out).toContain('b2');
    });
  });

  describe('前后散文剥离', () => {
    it('剥掉前缀说明文字', () => {
      const raw = 'Here is the translation:\n{"translations":[{"id":"b1","translated_text":"你好"}]}';
      expect(extractJsonContainer(raw)).toBe('{"translations":[{"id":"b1","translated_text":"你好"}]}');
    });

    it('剥掉后缀总结文字', () => {
      const raw = '{"translations":[{"id":"b1","translated_text":"你好"}]}\n\nHope this helps!';
      expect(extractJsonContainer(raw)).toBe('{"translations":[{"id":"b1","translated_text":"你好"}]}');
    });

    it('前后都有散文时只取 JSON 容器', () => {
      const raw = 'Sure!\n```json\n{"a":1}\n```\nLet me know.';
      expect(extractJsonContainer(raw)).toBe('{"a":1}');
    });

    it('纯 JSON 输入原样返回（无副作用）', () => {
      const raw = '{"translations":[{"id":"b1","translated_text":"你好"}]}';
      expect(extractJsonContainer(raw)).toBe(raw);
    });
  });

  describe('配平扫描正确性', () => {
    it('字符串内的花括号不参与配平', () => {
      const raw = '{"translations":[{"id":"b1","translated_text":"a}b}c"}]}';
      expect(extractJsonContainer(raw)).toBe(raw);
    });

    it('转义引号内的括号不破坏字符串状态', () => {
      const raw = '{"translations":[{"id":"b1","translated_text":"say \\"} hi"}]}';
      const out = extractJsonContainer(raw);
      expect(out).toBe(raw);
    });

    it('嵌套数组正确配对', () => {
      const raw = '{"a":[1,[2,[3]],4]}';
      expect(extractJsonContainer(raw)).toBe(raw);
    });

    it('顶层是数组时按数组配对', () => {
      const raw = '[{"id":"b1"},{"id":"b2"}] trailing text';
      expect(extractJsonContainer(raw)).toBe('[{"id":"b1"},{"id":"b2"}]');
    });

    it('数组中含对象时不会提前在第一个 } 处收尾', () => {
      const raw = '[{"a":1},{"b":2}]';
      expect(extractJsonContainer(raw)).toBe('[{"a":1},{"b":2}]');
    });
  });

  describe('回退行为', () => {
    it('无任何 JSON 括号时回退原串', () => {
      expect(extractJsonContainer('not json')).toBe('not json');
    });

    it('空串回退', () => {
      expect(extractJsonContainer('')).toBe('');
      expect(extractJsonContainer('   ')).toBe('   ');
    });

    it('只有开括号时保留到末尾（不回退、不丢内容）', () => {
      expect(extractJsonContainer('{"a":1')).toBe('{"a":1');
    });
  });
});
