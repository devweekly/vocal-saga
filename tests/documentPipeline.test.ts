import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/translate/pipeline', () => ({
  translateBlocks: vi.fn(),
}));

import { translateBlocks } from '../lib/translate/pipeline';
import { parseDocument } from '../lib/translate/document';
import { buildSegmentBatches } from '../lib/translate/document/batcher';
import { translateDocument } from '../lib/translate/documentPipeline';

const mocked = translateBlocks as unknown as ReturnType<typeof vi.fn>;

function fakeDoc(overrides: Record<string, unknown> = {}) {
  return {
    format: 'txt',
    title: 'demo',
    segments: [
      { id: 's0', index: 0, text: 'Hello', kind: 'paragraph' },
      { id: 's1', index: 1, text: 'World', kind: 'paragraph' },
    ],
    meta: { charCount: 10, segmentCount: 2, warnings: [] },
    ...overrides,
  } as never;
}

beforeEach(() => {
  mocked.mockReset();
});

describe('parseDocument（服务端）', () => {
  it('解析 TXT', async () => {
    const doc = await parseDocument({ fileName: 'a.txt', text: 'Hello\n\nWorld' });
    expect(doc.segments).toHaveLength(2);
  });

  it('二进制格式给出明确错误，而不是静默返回空', async () => {
    await expect(parseDocument({ fileName: 'a.pdf', text: 'x' })).rejects.toThrow(/服务端不支持解析/);
    await expect(parseDocument({ fileName: 'a.docx', text: 'x' })).rejects.toThrow(/服务端不支持解析/);
    await expect(parseDocument({ fileName: 'a.epub', text: 'x' })).rejects.toThrow(/服务端不支持解析/);
  });

});

describe('buildSegmentBatches', () => {
  it('书籍模式按章节与 PDF 页码边界拆批', () => {
    const segments = [
      { id: 'a', index: 0, text: 'one', kind: 'paragraph' as const, contextPath: 'Chapter One', page: 1 },
      { id: 'b', index: 1, text: 'two', kind: 'paragraph' as const, contextPath: 'Chapter One', page: 1 },
      { id: 'c', index: 2, text: 'three', kind: 'paragraph' as const, contextPath: 'Chapter Two', page: 1 },
      { id: 'd', index: 3, text: 'four', kind: 'paragraph' as const, contextPath: 'Chapter Two', page: 2 },
    ];
    expect(buildSegmentBatches(segments, { maxChars: 1000, maxSegments: 10 })).toHaveLength(1);
    expect(buildSegmentBatches(segments, {
      maxChars: 1000,
      maxSegments: 10,
      splitOnContextChange: true,
    }).map((batch) => batch.map((segment) => segment.id))).toEqual([['a', 'b'], ['c'], ['d']]);
  });
});

describe('translateDocument', () => {
  it('逐批提交，返回 id → 译文', async () => {
    mocked.mockImplementation(async ({ blocks }: { blocks: Array<{ id: string }> }) =>
      new Map(blocks.map((b) => [b.id, `译-${b.id}`])),
    );
    const result = await translateDocument({ doc: fakeDoc(), target: 'zh' });
    expect(result.translations).toEqual({ s0: '译-s0', s1: '译-s1' });
    expect(result.failedBatches).toEqual([]);
  });

  it('单批失败不影响其它批次（失败隔离）', async () => {
    mocked.mockImplementation(async ({ blocks }: { blocks: Array<{ id: string }> }) => {
      if (blocks[0]?.id === 's1') throw new Error('upstream 429');
      return new Map(blocks.map((b) => [b.id, `译-${b.id}`]));
    });
    // 强制每批 1 段，确保 s1 单独成批
    const result = await translateDocument({
      doc: fakeDoc(),
      budget: { maxChars: 100000, maxSegments: 1 },
    });
    expect(result.translations.s0).toBe('译-s0');
    expect(result.translations.s1).toBeUndefined();
    expect(result.failedBatches).toEqual([1]);
    expect(result.errors[0]).toContain('upstream 429');
  });


  it('对缺失片段只重试缺失 ID，并把章节语境传给翻译模型', async () => {
    mocked
      .mockImplementationOnce(async ({ blocks }: { blocks: Array<{ id: string }> }) =>
        new Map(blocks.filter((block) => block.id === 's0').map((block) => [block.id, '译-s0'])),
      )
      .mockImplementationOnce(async ({ blocks }: { blocks: Array<{ id: string; contextPath?: string; kind?: string; marker?: string }> }) => {
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.id).toBe('s1');
        expect(blocks[0]?.contextPath).toBe('Chapter 2');
        return new Map([['s1', '译-s1']]);
      });

    const doc = fakeDoc({
      segments: [
        { id: 's0', index: 0, text: 'Hello', kind: 'paragraph', contextPath: 'Chapter 1' },
        { id: 's1', index: 1, text: 'World', kind: 'paragraph', contextPath: 'Chapter 2', page: 4 },
      ],
    });
    const result = await translateDocument({ doc, target: 'zh' });

    expect(mocked).toHaveBeenCalledTimes(2);
    expect(result.translations).toEqual({ s0: '译-s0', s1: '译-s1' });
    expect(result.complete).toBe(true);
    expect(result.missingSegmentIds).toEqual([]);
  });

  it('重试后仍缺失片段时返回明确的不完整状态', async () => {
    mocked.mockImplementation(async ({ blocks }: { blocks: Array<{ id: string }> }) =>
      new Map(blocks.filter((block) => block.id === 's0').map((block) => [block.id, '译-s0'])),
    );
    const result = await translateDocument({ doc: fakeDoc(), target: 'zh' });

    expect(result.translations.s0).toBe('译-s0');
    expect(result.translations.s1).toBeUndefined();
    expect(result.complete).toBe(false);
    expect(result.missingSegmentIds).toEqual(['s1']);
    expect(result.failedBatches).toEqual([0]);
    expect(result.errors[0]).toContain('s1');
  });

  it('空文档不发起任何翻译请求', async () => {
    const result = await translateDocument({
      doc: fakeDoc({ segments: [], meta: { charCount: 0, segmentCount: 0, warnings: [] } }),
    });
    expect(mocked).not.toHaveBeenCalled();
    expect(result.batchCount).toBe(0);
  });
});


describe('文学翻译 profile', () => {
  it('非 EPUB/PDF 文档也使用文学 prompt 与独立文风审校，不传通用术语表', async () => {
    mocked.mockImplementation(async ({
      blocks,
      glossary,
      translationMode,
    }: {
      blocks: Array<{ id: string; text: string }>;
      glossary?: unknown;
      translationMode?: string;
    }) => {
      expect(translationMode).toBe('literary');
      expect(glossary).toBeUndefined();
      return new Map(blocks.map((block) => {
        let payload: { source?: string; draft?: string } | null = null;
        try {
          payload = JSON.parse(block.text) as { source?: string; draft?: string };
        } catch {
          // 初译使用普通 text；审校请求的 text 是 source/draft JSON。
        }
        if (payload?.source && payload.draft) {
          return [block.id, JSON.stringify({
            finalTranslation: '具有文学感的修订译文 ' + block.id,
            findings: [{
              category: 'style',
              priority: 'optional',
              sourceExcerpt: payload.source,
              draftExcerpt: payload.draft,
              reason: '初译存在生硬的直译搭配',
              suggestion: '调整为符合目标语言习惯的表达',
            }],
          })];
        }
        return [block.id, '初译 ' + block.id];
      }));
    });

    const result = await translateDocument({
      doc: fakeDoc(),
      target: 'zh',
      translationMode: 'literary',
    });

    expect(result.translations.s0).toBe('具有文学感的修订译文 s0');
    expect(result.translations.s1).toBe('具有文学感的修订译文 s1');
    expect(result.reviewedSegmentCount).toBe(2);
    expect(result.reviewFindings.every((finding) => finding.category === 'style')).toBe(true);
    expect(mocked).toHaveBeenCalledTimes(2);
  });
});
