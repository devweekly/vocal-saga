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

  it('缺少 content → 400', async () => {
    const res = await post('/api/translate/document/parse', { fileName: 'a.txt' });
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

  it('空文档 → 400', async () => {
    const res = await post('/api/translate/document', {
      fileName: 'a.txt',
      content: '   ',
    });
    expect(res.status).toBe(400);
  });
});
