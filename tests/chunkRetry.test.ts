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

});

describe('diffMissingIds', () => {
  it('returns ids present in input but not output, preserving order', () => {
    const input = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const output = ['b1', 'b3', 'b5'];
    expect(diffMissingIds(input, output)).toEqual(['b2', 'b4']);
  });

  it('returns all input ids when output is empty (full failure)', () => {
    const input = ['b1', 'b2', 'b3'];
    const output: string[] = [];
    expect(diffMissingIds(input, output)).toEqual(['b1', 'b2', 'b3']);
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



});
