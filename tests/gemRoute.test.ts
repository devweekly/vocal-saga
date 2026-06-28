/**
 * GET /gem/<target-without-scheme> 路由单测。
 *
 * Gemini 翻译路由，使用 Google Gemini 原生 API（gemini-flash-latest 默认模型）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// mock pipeline
vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(async (args: { url: string; mode: string; provider: string; model?: string }) => ({
    html: `<html><body>gemini: ${args.url} (${args.provider}, model=${args.model || 'default'})</body></html>`,
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
  process.env.GEMINI_API_KEY = 'gem-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:gem-' + Math.random().toString(36).slice(2)));
  const { translateUrl } = await import('../lib/translate/pipeline');
  (translateUrl as any).mockClear();
  (translateUrl as any).mockResolvedValue({
    html: '<html><body>ok</body></html>',
    title: 'Test',
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

describe('GET /gem/<target> — Gemini default model (gemini-flash-latest)', () => {
  it('200 with valid request', async () => {
    const app = buildApp();
    const res = await app.request(req('/gem/example.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('uses gemini provider', async () => {
    const app = buildApp();
    await app.request(req('/gem/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.provider).toBe('gemini');
  });

  it('uses gemini-flash-latest as default model', async () => {
    const app = buildApp();
    await app.request(req('/gem/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.model).toBe('gemini-flash-latest');
  });

  it('returns translated HTML', async () => {
    const app = buildApp();
    const res = await app.request(req('/gem/example.com'));
    const body = await res.text();
    expect(body).toContain('<html>');
    expect(body).toContain('ok');
  });

  it('strips https:// prefix', async () => {
    const app = buildApp();
    await app.request(req('/gem/https%3A%2F%2Fexample.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/article');
  });

  it('adds .com suffix for domain without dot', async () => {
    const app = buildApp();
    await app.request(req('/gem/towardsdatascience/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://towardsdatascience.com/article');
  });

  it('400 when target is empty', async () => {
    const app = buildApp();
    const res = await app.request(req('/gem/'));
    expect(res.status).toBe(400);
  });

  it('does not force re-translate (force=false)', async () => {
    const app = buildApp();
    await app.request(req('/gem/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com');
  });
});

describe('GET /gem/pro/<target> — Gemini pro model', () => {
  it('200 with valid request', async () => {
    const app = buildApp();
    const res = await app.request(req('/gem/pro/example.com'));
    expect(res.status).toBe(200);
  });

  it('uses gemini provider with gemini-pro-latest model', async () => {
    const app = buildApp();
    await app.request(req('/gem/pro/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.provider).toBe('gemini');
    expect(call.model).toBe('gemini-pro-latest');
  });

  it('strips pro/ prefix from URL', async () => {
    const app = buildApp();
    await app.request(req('/gem/pro/example.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/article');
  });

  it('returns translated HTML', async () => {
    const app = buildApp();
    const res = await app.request(req('/gem/pro/example.com'));
    const body = await res.text();
    expect(body).toContain('<html>');
  });

  // 防回归：pro.example.com 不应被当成模型前缀（因为 startsWith('pro/') 匹配的是
  // 完整段 'pro'，而 'pro.example.com/' 第一个段包含 '.')
  it('does not strip pro/ when it is part of a domain (pro.example.com)', async () => {
    const app = buildApp();
    await app.request(req('/gem/pro.example.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    // pro.example.com 是完整域名，不触发 pro/ 前缀剥离
    expect(call.url).toBe('https://pro.example.com/article');
    // 仍是默认模型
    expect(call.model).toBe('gemini-flash-latest');
  });
});
