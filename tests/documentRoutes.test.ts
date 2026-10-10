/**
 * 文档翻译路由冒烟测试。
 *
 * 只验证"协议层"：参数校验、格式不支持时的 415、translate=false 的预检分支。
 * 真正的翻译逻辑在 tests/documentPipeline.test.ts 里用 mock 覆盖 ——
 * 这里不重复测，避免每个断言都要 mock 一整套 LLM 调用。
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
    new Map(blocks.map((b: any) => [b.id, `译-${b.id}`])),
  );
});

function post(path: string, body: unknown) {
  return createApp().fetch(
    new Request(`http://test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/translate/document/parse', () => {
  it('解析 Markdown 并返回段落，不消耗 token', async () => {
    const res = await post('/api/translate/document/parse', {
      fileName: 'a.md',
      content: '# 标题\n\n正文',
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.format).toBe('md');
    expect(json.segmentCount).toBe(2);
    expect(json.segments[0].kind).toBe('heading');
  });

  it('缺少 fileName → 400', async () => {
    const res = await post('/api/translate/document/parse', { content: 'x' });
    expect(res.status).toBe(400);
  });


  it('二进制格式 → 415，并回传支持的格式列表', async () => {
    const res = await post('/api/translate/document/parse', {
      fileName: 'a.pdf',
      content: 'x',
    });
    expect(res.status).toBe(415);
    const json: any = await res.json();
    expect(json.error).toContain('服务端不支持解析');
    expect(json.supported).toContain('txt');
  });
});

describe('POST /api/translate/document/segments', () => {
  it('接受扩展端已解析的 PDF 片段，并在预检响应保留页码与章节语境', async () => {
    const res = await post('/api/translate/document/segments', {
      fileName: 'research.pdf',
      title: 'Research',
      format: 'pdf',
      translate: false,
      warnings: ['第 3 页文本较少，建议检查'],
      segments: [{
        id: 'pdf-p3-s0',
        index: 0,
        text: 'The model improves translation quality.',
        kind: 'paragraph',
        page: 3,
        contextPath: '2 Method > 2.1 Model',
      }],
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.format).toBe('pdf');
    expect(json.segments[0].id).toBe('pdf-p3-s0');
    expect(json.segments[0].page).toBe(3);
    expect(json.segments[0].contextPath).toBe('2 Method > 2.1 Model');
    expect(json.warnings).toContain('第 3 页文本较少，建议检查');
    expect(json.translations).toBeUndefined();
  });

  it('结构化 PDF 通过同一翻译 pipeline 返回逐段结果', async () => {
    const res = await post('/api/translate/document/segments', {
      fileName: 'research.pdf',
      format: 'pdf',
      target: 'zh',
      segments: [{
        id: 'pdf-p3-s0',
        index: 0,
        text: 'The model improves translation quality.',
        kind: 'paragraph',
        page: 3,
        contextPath: '2 Method > 2.1 Model',
      }],
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.translations).toEqual({ 'pdf-p3-s0': '译-pdf-p3-s0' });
    expect(json.complete).toBe(true);
    expect(json.missingSegmentIds).toEqual([]);
    expect(json.completedSegmentCount).toBe(1);
  });

  it('将当前 provider、model 和章节语境传入翻译层', async () => {
    const res = await post('/api/translate/document/segments', {
      fileName: 'research.pdf',
      format: 'pdf',
      target: 'zh',
      provider: 'openrouter',
      model: 'example-model',
      segments: [{
        id: 'pdf-p3-s0',
        text: 'The model improves translation quality.',
        kind: 'paragraph',
        page: 3,
        contextPath: '2 Method > 2.1 Model',
      }],
    });
    expect(res.status).toBe(200);
    const { translateBlocks } = await import('../lib/translate/pipeline');
    const input = (translateBlocks as any).mock.calls[0][0];
    expect(input.provider).toBe('openrouter');
    expect(input.model).toBe('example-model');
    expect(input.blocks[0].contextPath).toBe('2 Method > 2.1 Model');
  });

  it('拒绝重复片段 ID，避免译文回填错位', async () => {
    const res = await post('/api/translate/document/segments', {
      fileName: 'research.pdf',
      format: 'pdf',
      translate: false,
      segments: [
        { id: 'dup', text: 'First paragraph', kind: 'paragraph' },
        { id: 'dup', text: 'Second paragraph', kind: 'paragraph' },
      ],
    });
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.error).toContain('重复片段 ID');
  });
});

describe('POST /api/translate/document', () => {
  it('translate:false 时只解析不翻译', async () => {
    const res = await post('/api/translate/document', {
      fileName: 'a.txt',
      content: 'Hello\n\nWorld',
      translate: false,
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.segmentCount).toBe(2);
    expect(json.translations).toBeUndefined();
  });

  it('正常翻译返回逐段译文', async () => {
    const res = await post('/api/translate/document', {
      fileName: 'a.txt',
      content: 'Hello\n\nWorld',
      target: 'zh',
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.translations).toEqual({ s0: '译-s0', s1: '译-s1' });
    expect(json.failedBatches).toEqual([]);
  });

});
