/**
 * GET /gemini/<target-without-scheme> 路由单测。
 *
 * Gemini 翻译路由，使用 Google Gemini 原生 API（gemini-3.1-flash-lite 默认模型）。
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
  setDefaultStorage(new MapStorage('test:gemini-' + Math.random().toString(36).slice(2)));
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

describe('GET /gemini/<target> — Gemini default model (gemini-3.1-flash-lite)', () => {
  it('200 with valid request', async () => {
    const app = buildApp();
    const res = await app.request(req('/gemini/example.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('uses gemini provider', async () => {
    const app = buildApp();
    await app.request(req('/gemini/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.provider).toBe('gemini');
  });

  it('uses gemini-3.1-flash-lite as default model', async () => {
    const app = buildApp();
    await app.request(req('/gemini/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.model).toBe('gemini-3.1-flash-lite');
  });

  it('returns translated HTML', async () => {
    const app = buildApp();
    const res = await app.request(req('/gemini/example.com'));
    const body = await res.text();
    expect(body).toContain('<html>');
    expect(body).toContain('ok');
  });

  it('strips https:// prefix', async () => {
    const app = buildApp();
    await app.request(req('/gemini/https%3A%2F%2Fexample.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/article');
  });

  it('adds .com suffix for domain without dot', async () => {
    const app = buildApp();
    await app.request(req('/gemini/towardsdatascience/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://towardsdatascience.com/article');
  });

  it('400 when target is empty', async () => {
    const app = buildApp();
    const res = await app.request(req('/gemini/'));
    expect(res.status).toBe(400);
  });

  it('does not force re-translate (force=false)', async () => {
    const app = buildApp();
    await app.request(req('/gemini/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com');
  });
});
