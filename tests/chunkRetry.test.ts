import { describe, it, expect } from 'vitest';
import {
  buildRetryChunk,
  diffMissingIds,
  pickMissingBlocks,
  shouldRetryMissing,
} from '../lib/translate/chunkRetry';
import type { TextBlock } from '../lib/translate/blockExtractor';
import type { Chunk } from '../lib/translate/chunkBuilder';

function makeBlock(id: string, tag: string, text: string): TextBlock {
  return { id, tag, text, xpath: `/${id}` };
}

function makeChunk(blocks: TextBlock[]): Chunk {
  return {
    id: 'chunk1',
    blocks,
    jsonContent: JSON.stringify(blocks.map((b) => ({ id: b.id, text: b.text }))),
    estimatedTokens: blocks.reduce((s, b) => s + Math.ceil(b.text.length / 4), 0),
  };
}

describe('shouldRetryMissing', () => {
  it('returns false when not missing anything', () => {
    expect(shouldRetryMissing({ missingCount: 0, totalCount: 10, isRetry: false })).toBe(false);
  });

  it('returns false when this is already a retry (cap recursion at 1)', () => {
    // 即便 missing 很多，第二轮重试也不允许：避免无限递归 + 限制 API 预算。
    expect(shouldRetryMissing({ missingCount: 3, totalCount: 10, isRetry: true })).toBe(false);
    expect(shouldRetryMissing({ missingCount: 12, totalCount: 12, isRetry: true })).toBe(false);
  });

  it('returns true for partial missing (any count > 0, not a retry)', () => {
    expect(shouldRetryMissing({ missingCount: 1, totalCount: 10, isRetry: false })).toBe(true);
    expect(shouldRetryMissing({ missingCount: 4, totalCount: 10, isRetry: false })).toBe(true);
    // 4/10 = 40% — 历史阈值下会重试
    expect(shouldRetryMissing({ missingCount: 14, totalCount: 30, isRetry: false })).toBe(true);
  });

  it('returns true for 50% missing (was previously rejected, now allowed)', () => {
    // 反例：以前 5/10 (50%) 拒绝重试。修正后任何 missing > 0 都重试。
    // 中等缺失往往意味着 API 偶发抖动，重试一轮可能挽回大部分。
    expect(shouldRetryMissing({ missingCount: 5, totalCount: 10, isRetry: false })).toBe(true);
    expect(shouldRetryMissing({ missingCount: 50, totalCount: 100, isRetry: false })).toBe(true);
  });

  it('returns true for 100% missing (the "API returns success with empty result" case)', () => {
    // 关键场景：API 业务成功但 model/parser 吐了空 result。
    // 历史 50% 阈值会把这种情况挡掉，导致整 chunk 全部 yellow。
    // 现在 12/12 missing 也允许重试一轮。
    expect(shouldRetryMissing({ missingCount: 10, totalCount: 10, isRetry: false })).toBe(true);
    expect(shouldRetryMissing({ missingCount: 12, totalCount: 12, isRetry: false })).toBe(true);
    expect(shouldRetryMissing({ missingCount: 30, totalCount: 30, isRetry: false })).toBe(true);
  });

  it('isRetry trumps missingCount: even small missing on a retry is rejected', () => {
    // 已重试过 → 不论缺多少都不再重试
    expect(shouldRetryMissing({ missingCount: 1, totalCount: 100, isRetry: true })).toBe(false);
  });
});

describe('diffMissingIds', () => {
  it('returns ids present in input but not output, preserving order', () => {
    const input = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const output = ['b1', 'b3', 'b5'];
    expect(diffMissingIds(input, output)).toEqual(['b2', 'b4']);
  });

  it('returns empty array when all input ids are in output', () => {
    const input = ['b1', 'b2', 'b3'];
    const output = ['b1', 'b2', 'b3'];
    expect(diffMissingIds(input, output)).toEqual([]);
  });

  it('returns all input ids when output is empty (full failure)', () => {
    const input = ['b1', 'b2', 'b3'];
    const output: string[] = [];
    expect(diffMissingIds(input, output)).toEqual(['b1', 'b2', 'b3']);
  });

  it('ignores output ids that are not in input (defensive against model extras)', () => {
    const input = ['b1', 'b2'];
    const output = ['b1', 'b2', 'b999'];
    expect(diffMissingIds(input, output)).toEqual([]);
  });
});

describe('pickMissingBlocks', () => {
  it('returns blocks whose ids are in missingIds, in original order', () => {
    const blocks = [
      makeBlock('b1', 'p', 'one'),
      makeBlock('b2', 'h2', 'two'),
      makeBlock('b3', 'p', 'three'),
      makeBlock('b4', 'p', 'four'),
    ];
    const result = pickMissingBlocks(blocks, ['b3', 'b1']);
    expect(result.map((b) => b.id)).toEqual(['b1', 'b3']);
  });

  it('returns empty array when no ids match', () => {
    const blocks = [makeBlock('b1', 'p', 'one')];
    expect(pickMissingBlocks(blocks, ['b99'])).toEqual([]);
  });

  it('handles missing ids pointing to non-existent blocks gracefully', () => {
    const blocks = [makeBlock('b1', 'p', 'one'), makeBlock('b2', 'p', 'two')];
    const result = pickMissingBlocks(blocks, ['b1', 'b99', 'b2']);
    expect(result.map((b) => b.id)).toEqual(['b1', 'b2']);
  });
});

describe('buildRetryChunk', () => {
  it('suffixed id makes retry distinguishable in logs', () => {
    const parent = makeChunk([
      makeBlock('b1', 'p', 'one'),
      makeBlock('b2', 'p', 'two'),
    ]);
    const retry = buildRetryChunk(parent, ['b1']);
    expect(retry.id).toBe('chunk1_retry');
  });

  it('contains exactly the missing blocks in original order', () => {
    const parent = makeChunk([
      makeBlock('b1', 'p', 'one'),
      makeBlock('b2', 'h2', 'two'),
      makeBlock('b3', 'p', 'three'),
    ]);
    const retry = buildRetryChunk(parent, ['b3', 'b1']);
    expect(retry.blocks.map((b) => b.id)).toEqual(['b1', 'b3']);
    expect(retry.blocks[0].text).toBe('one');
    expect(retry.blocks[1].text).toBe('three');
  });

  it('re-serializes jsonContent (cache key differs from parent)', () => {
    const parent = makeChunk([
      makeBlock('b1', 'p', 'one'),
      makeBlock('b2', 'p', 'two'),
    ]);
    const retry = buildRetryChunk(parent, ['b1']);
    expect(retry.jsonContent).not.toBe(parent.jsonContent);
    // Even though both contain b1, retry's payload only includes b1
    expect(retry.jsonContent).toBe(JSON.stringify([{ id: 'b1', text: 'one' }]));
  });

  it('recomputes estimatedTokens for the subset', () => {
    const parent = makeChunk([
      makeBlock('b1', 'p', 'a'.repeat(100)), // 25 tokens
      makeBlock('b2', 'p', 'b'.repeat(200)), // 50 tokens
      makeBlock('b3', 'p', 'c'.repeat(400)), // 100 tokens
    ]);
    expect(parent.estimatedTokens).toBe(175);
    const retry = buildRetryChunk(parent, ['b1', 'b3']);
    // b1 (25) + b3 (100) = 125
    expect(retry.estimatedTokens).toBe(125);
  });

  it('handles empty missing list (degenerate but valid)', () => {
    const parent = makeChunk([makeBlock('b1', 'p', 'one')]);
    const retry = buildRetryChunk(parent, []);
    expect(retry.blocks).toEqual([]);
    expect(retry.id).toBe('chunk1_retry');
    expect(retry.jsonContent).toBe('[]');
  });
});
