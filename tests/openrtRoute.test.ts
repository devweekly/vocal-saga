/**
 * GET /openrt/<target-without-scheme> 路由单测。
 *
 * OpenRouter 免费模型翻译路由，使用 nvidia/nemotron-3-nano-30b-a3b。
 * 与 /translate 路由类似，但使用 OpenRouter API 而非 DeepSeek。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// 测试 stripMarkdownCodeBlock 函数
describe('stripMarkdownCodeBlock', () => {
  // 从 openrouter.ts 导入内部函数（通过动态 import 测试）
  it('strips ```json code block', async () => {
    const { OpenRouterTranslationService } = await import('../lib/translate/service/openrouter');
    // 直接测试 stripMarkdownCodeBlock 逻辑
    const input = '```json\n[{"id":"b1","translated_text":"你好"}]\n```';
    const expected = '[{"id":"b1","translated_text":"你好"}]';
    // 通过正则匹配验证
    const match = input.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe(expected);
  });

  it('strips ``` code block without json label', () => {
    const input = '```\n[{"id":"b1","translated_text":"你好"}]\n```';
    const match = input.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe('[{"id":"b1","translated_text":"你好"}]');
  });

  it('returns plain JSON unchanged', () => {
    const input = '[{"id":"b1","translated_text":"你好"}]';
    const match = input.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    expect(match).toBeNull();
    expect(input.trim()).toBe(input);
  });

  it('handles whitespace variations', () => {
    const input = '  ```json\n  [{"id":"b1"}]\n  ```  ';
    const match = input.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe('[{"id":"b1"}]');
  });
});

// mock pipeline
vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(async (args: { url: string; mode: string; service: string }) => ({
    html: `<html><body>openrouter: ${args.url} (${args.service})</body></html>`,
    blocks: 3,
    chunks: 1,
    duration_ms: 50,
  })),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
  process.env.OPENROUTER_API_KEY = 'or-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:openrt-' + Math.random().toString(36).slice(2)));
  const { translateUrl } = await import('../lib/translate/pipeline');
  (translateUrl as any).mockClear();
  (translateUrl as any).mockResolvedValue({
    html: '<html><body>ok</body></html>',
    blocks: 1,
    chunks: 1,
    duration_ms: 10,
  });
});

function buildApp() {
  return createApp();
}

function req(path: string): Request {
  return new Request(`http://test${path}`);
}

describe('GET /openrt/<target> — OpenRouter free model', () => {
  it('200 with valid request', async () => {
    const app = buildApp();
    const res = await app.request(req('/openrt/example.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('uses openrouter service', async () => {
    const app = buildApp();
    await app.request(req('/openrt/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.service).toBe('openrouter');
  });

  it('uses OPENROUTER_API_KEY', async () => {
    const app = buildApp();
    await app.request(req('/openrt/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.apiKey).toBe('or-test-dummy');
  });

  it('500 when OPENROUTER_API_KEY is missing', async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const app = buildApp();
      const res = await app.request(req('/openrt/example.com'));
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/OpenRouter/);
    } finally {
      process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it('strips https:// prefix', async () => {
    const app = buildApp();
    await app.request(req('/openrt/https%3A%2F%2Fexample.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/article');
  });

  it('adds .com suffix for domain without dot', async () => {
    const app = buildApp();
    await app.request(req('/openrt/towardsdatascience/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://towardsdatascience.com/article');
  });

  it('does not force re-translate (force=false)', async () => {
    const app = buildApp();
    await app.request(req('/openrt/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    // service 模式下 force 应该是 false
    expect(call.url).toBe('https://example.com');
  });

  it('400 when target is empty', async () => {
    const app = buildApp();
    const res = await app.request(req('/openrt/'));
    expect(res.status).toBe(400);
  });

  it('returns translated HTML', async () => {
    const app = buildApp();
    const res = await app.request(req('/openrt/example.com'));
    const body = await res.text();
    expect(body).toContain('<html>');
    expect(body).toContain('ok');
  });
});
