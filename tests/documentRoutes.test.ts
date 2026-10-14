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
        marker: '2.',
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

describe('POST /api/translate/document/literary/analyze', () => {
  it('returns bounded chapter memory with canonical entities and relationships', async () => {
    const { translateBlocks } = await import('../lib/translate/pipeline');
    (translateBlocks as any).mockResolvedValueOnce(new Map([[
      'literary-analysis',
      JSON.stringify({
        entities: [{ source: 'Alice', target: '艾丽丝', kind: 'person', aliases: ['Miss Alice'], reviewStatus: 'confirmed' }],
        relationships: [{ subject: 'Alice', predicate: 'protects', object: 'Bob' }],
        styleGuide: { narrativeVoice: '克制的第三人称', rhythm: '短句与长句交替' },
        chapterSummary: 'Alice protects Bob.',
      }),
    ]]));

    const res = await post('/api/translate/document/literary/analyze', {
      chapterTitle: 'Chapter One',
      target: 'zh',
      segments: [{ id: 's0', text: 'Alice opened the old door.', kind: 'paragraph', contextPath: 'Chapter One' }],
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.analyzed).toBe(true);
    expect(json.memory.entities[0].target).toBe('艾丽丝');
    expect(json.memory.entities[0].reviewStatus).toBe('suggested');
    expect(json.memory.relationships[0].predicate).toBe('protects');
    expect(json.memory.styleGuide.narrativeVoice).toBe('克制的第三人称');
    expect(json.memory.chapterSummaries[0].chapter).toBe('Chapter One');
  });
});

describe('POST /api/translate/document/literary/review', () => {
  it('applies required corrections and drops style findings entirely', async () => {
    const { translateBlocks } = await import('../lib/translate/pipeline');
    (translateBlocks as any).mockResolvedValueOnce(new Map([['s0', JSON.stringify({
      finalTranslation: '她推开了那扇旧门。',
      findings: [
        { category: 'accuracy', sourceExcerpt: 'opened', draftExcerpt: '打开', reason: '时态和动作含义错误。', suggestion: '推开' },
        { category: 'style', priority: 'must_fix', sourceExcerpt: 'She opened', draftExcerpt: '她打开了', reason: '个人风格偏好。', suggestion: '她轻轻推开' },
      ],
    })]]));

    const res = await post('/api/translate/document/literary/review', {
      chapterTitle: 'Chapter One',
      source: 'en',
      target: 'zh',
      memory: {
        version: 1,
        entities: [{ source: 'Alice', target: '艾丽丝', kind: 'person' }],
        relationships: [],
        styleGuide: { narrativeVoice: '克制的第三人称' },
        chapterSummaries: [],
        recentExamples: [],
      },
      segments: [{ id: 's0', source: 'She opened the old door.', draft: '她打开了老旧的门。', kind: 'paragraph' }],
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.translations.s0).toBe('她推开了那扇旧门。');
    expect(json.reviewedIds).toEqual(['s0']);
    expect(json.missingIds).toEqual([]);
    // style 不在审校范围：即便模型自称 must_fix 也不采纳、不展示。
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0].priority).toBe('must_fix');
    expect(json.findings[0].category).toBe('accuracy');
  });
});


describe('POST /api/translate/document/literary/review — style is out of scope', () => {
  it('keeps the exact draft when findings are style-only, even if model asks for a rewrite', async () => {
    const { translateBlocks } = await import('../lib/translate/pipeline');
    (translateBlocks as any).mockResolvedValueOnce(new Map([['s0', JSON.stringify({
      finalTranslation: '她轻轻地推开那扇古老的门。',
      findings: [{
        category: 'style', priority: 'must_fix',
        sourceExcerpt: 'opened the door', draftExcerpt: '推开旧门',
        reason: '更有文学感', suggestion: '她轻轻地推开那扇古老的门。',
      }],
    })]]));

    const draft = '她推开了旧门。';
    const res = await post('/api/translate/document/literary/review', {
      chapterTitle: 'Chapter One',
      source: 'en',
      target: 'zh',
      segments: [{ id: 's0', source: 'She opened the old door.', draft, kind: 'paragraph' }],
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.translations.s0).toBe(draft);
    // 全部是 style 时视同没有可报告问题：既不改译文，也不产出任何建议。
    expect(json.findings).toEqual([]);
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
