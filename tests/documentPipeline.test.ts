import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/translate/pipeline', () => ({
  translateBlocks: vi.fn(),
}));

import { translateBlocks } from '../lib/translate/pipeline';
import { parseDocument } from '../lib/translate/document';
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

  it('未知扩展名抛错', async () => {
    await expect(parseDocument({ fileName: 'a.exe', text: 'x' })).rejects.toThrow(/不支持的文件类型/);
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

  it('exportAs 时附带导出内容', async () => {
    mocked.mockImplementation(async ({ blocks }: { blocks: Array<{ id: string }> }) =>
      new Map(blocks.map((b) => [b.id, '译文'])),
    );
    const result = await translateDocument({ doc: fakeDoc(), exportAs: 'txt' });
    expect(result.exported).toContain('译文');
  });

  it('空文档不发起任何翻译请求', async () => {
    const result = await translateDocument({
      doc: fakeDoc({ segments: [], meta: { charCount: 0, segmentCount: 0, warnings: [] } }),
    });
    expect(mocked).not.toHaveBeenCalled();
    expect(result.batchCount).toBe(0);
  });
});
