/**
 * Worker 结构化文档翻译路由测试。
 *
 * Worker 只校验已解析的片段并执行单次 translateBlocks；文档解析、持久化项目、
 * 书籍记忆与独立审校由扩展和 local-agent-service 负责。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(),
  translateText: vi.fn(),
  translateHtml: vi.fn(),
  translateBlocks: vi.fn(),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:doc-routes-' + Math.random().toString(36).slice(2)));
  const { translateBlocks } = await import('../lib/translate/pipeline');
  (translateBlocks as any).mockReset?.();
  (translateBlocks as any).mockImplementation(async ({ blocks }: any) =>
    new Map(blocks.map((block: any) => [block.id, '译-' + block.id])),
  );
});

function post(path: string, body: unknown) {
  return createApp().fetch(
    new Request('http://test' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const baseDocument = {
  fileName: 'research.pdf',
  title: 'Research',
  format: 'pdf',
  source: 'en',
  target: 'zh',
  segments: [
    {
      id: 'pdf-p2-s0',
      text: 'Introduction',
      kind: 'heading',
      level: 1,
      page: 2,
      contextPath: '1 Introduction',
    },
    {
      id: 'pdf-p2-s1',
      text: 'The model improves translation quality.',
      kind: 'paragraph',
      page: 2,
      contextPath: '1 Introduction',
    },
  ],
};

describe('POST /api/translate/document/segments', () => {
  it('只调用一次无状态翻译，并保留结构化 ID 与语境', async () => {
    const response = await post('/api/translate/document/segments', baseDocument);
    expect(response.status).toBe(200);
    const payload: any = await response.json();
    expect(payload.translations).toEqual({
      'pdf-p2-s0': '译-pdf-p2-s0',
      'pdf-p2-s1': '译-pdf-p2-s1',
    });
    expect(payload.complete).toBe(true);
    expect(payload.completedSegmentCount).toBe(2);
    expect(payload.missingSegmentIds).toEqual([]);

    const { translateBlocks } = await import('../lib/translate/pipeline');
    expect(translateBlocks).toHaveBeenCalledTimes(1);
    const input = (translateBlocks as any).mock.calls[0][0];
    expect(input.blocks[0]).toMatchObject({
      id: 'pdf-p2-s0',
      text: 'Introduction',
      kind: 'heading',
      level: 1,
      contextPath: '1 Introduction',
    });
    expect(input.concurrency).toBe(4);
  });

  it('允许单次文学风格翻译，但不触发记忆分析或第二次审校', async () => {
    const response = await post('/api/translate/document/segments', {
      ...baseDocument,
      translationMode: 'literary',
      literaryContext: { entities: [{ source: 'Alice', target: '艾丽丝' }] },
      literaryReview: true,
    });
    expect(response.status).toBe(200);
    const { translateBlocks } = await import('../lib/translate/pipeline');
    expect(translateBlocks).toHaveBeenCalledTimes(1);
    expect((translateBlocks as any).mock.calls[0][0].translationMode).toBe('literary');
    const result: any = await response.json();
    expect(result.reviewFindings).toBeUndefined();
    expect(result.reviewedSegmentCount).toBeUndefined();
  });

  it('translate=false 只返回已解析片段，不调用模型', async () => {
    const response = await post('/api/translate/document/segments', {
      ...baseDocument,
      translate: false,
    });
    expect(response.status).toBe(200);
    const payload: any = await response.json();
    expect(payload.translated).toBe(false);
    expect(payload.segments).toHaveLength(2);
    const { translateBlocks } = await import('../lib/translate/pipeline');
    expect(translateBlocks).not.toHaveBeenCalled();
  });

  it('不完整模型结果会明确列出缺失 ID', async () => {
    const { translateBlocks } = await import('../lib/translate/pipeline');
    (translateBlocks as any).mockResolvedValueOnce(new Map([['pdf-p2-s0', '引言']]));
    const response = await post('/api/translate/document/segments', baseDocument);
    expect(response.status).toBe(200);
    const payload: any = await response.json();
    expect(payload.complete).toBe(false);
    expect(payload.completedSegmentCount).toBe(1);
    expect(payload.missingSegmentIds).toEqual(['pdf-p2-s1']);
    expect(payload.errors[0]).toContain('pdf-p2-s1');
  });

  it('拒绝重复片段 ID，避免译文回填错位', async () => {
    const response = await post('/api/translate/document/segments', {
      ...baseDocument,
      segments: [
        { id: 'dup', text: 'First paragraph' },
        { id: 'dup', text: 'Second paragraph' },
      ],
    });
    expect(response.status).toBe(400);
    const payload: any = await response.json();
    expect(payload.error).toContain('重复片段 ID');
  });

  it('拒绝超出 5 MiB 上限的结构化请求', async () => {
    const response = await post('/api/translate/document/segments', {
      fileName: 'large.pdf',
      format: 'pdf',
      segments: [{ id: 'large', text: 'x'.repeat(5 * 1024 * 1024) }],
    });
    expect(response.status).toBe(413);
  });

  it('模型提供方未知时拒绝请求', async () => {
    const response = await post('/api/translate/document/segments', {
      ...baseDocument,
      provider: 'not-a-provider',
    });
    expect(response.status).toBe(400);
  });
});

describe('removed cloud document orchestration routes', () => {
  it.each([
    '/api/translate/document/parse',
    '/api/translate/document',
    '/api/translate/document/literary/analyze',
    '/api/translate/document/literary/review',
  ])('does not expose %s', async (path) => {
    const response = await post(path, { fileName: 'book.epub', segments: [] });
    expect(response.status).toBe(404);
  });
});
