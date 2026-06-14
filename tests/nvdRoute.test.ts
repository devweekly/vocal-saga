/**
 * GET /nvd/<target-without-scheme> 路由单测。
 *
 * NVIDIA 翻译路由，使用 build.nvidia.com 的 moonshotai/kimi-k2.6 模型。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// mock pipeline
vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(async (args: { url: string; mode: string; service: string }) => ({
    html: `<html><body>nvidia: ${args.url} (${args.service})</body></html>`,
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
  process.env.NVIDIA_API_KEY = 'nvapi-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:nvd-' + Math.random().toString(36).slice(2)));
  const { translateUrl } = await import('../lib/translate/pipeline');
  (translateUrl as any).mockClear();
  (translateUrl as any).mockResolvedValue({
    html: '<html><body>ok</html></html>',
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

describe('GET /nvd/<target> — NVIDIA kimi-k2.6 (default)', () => {
  it('200 with valid request', async () => {
    const app = buildApp();
    const res = await app.request(req('/nvd/example.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('uses nvidia service', async () => {
    const app = buildApp();
    await app.request(req('/nvd/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.service).toBe('nvidia');
  });

  it('uses nvidia service', async () => {
    const app = buildApp();
    await app.request(req('/nvd/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.service).toBe('nvidia');
  });

  it('uses default model (kimi-k2.6) when no deepseek prefix', async () => {
    const app = buildApp();
    await app.request(req('/nvd/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.model).toBeUndefined();
  });

  it('returns translated HTML', async () => {
    const app = buildApp();
    const res = await app.request(req('/nvd/example.com'));
    const body = await res.text();
    expect(body).toContain('<html>');
    expect(body).toContain('ok');
  });

  it('strips https:// prefix', async () => {
    const app = buildApp();
    await app.request(req('/nvd/https%3A%2F%2Fexample.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/article');
  });

  it('adds .com suffix for domain without dot', async () => {
    const app = buildApp();
    await app.request(req('/nvd/towardsdatascience/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://towardsdatascience.com/article');
  });

  it('400 when target is empty', async () => {
    const app = buildApp();
    const res = await app.request(req('/nvd/'));
    expect(res.status).toBe(400);
  });

  it('returns translated HTML', async () => {
    const app = buildApp();
    const res = await app.request(req('/nvd/example.com'));
    const body = await res.text();
    expect(body).toContain('<html>');
    expect(body).toContain('ok');
  });
});

describe('GET /nvd/deepseek/<target> — NVIDIA deepseek-v4-pro', () => {
  it('200 with valid request', async () => {
    const app = buildApp();
    const res = await app.request(req('/nvd/deepseek/example.com'));
    expect(res.status).toBe(200);
  });

  it('uses nvidia service with deepseek model', async () => {
    const app = buildApp();
    await app.request(req('/nvd/deepseek/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.service).toBe('nvidia');
    expect(call.model).toBe('deepseek-ai/deepseek-v4-pro');
  });

  it('strips deepseek/ prefix from URL', async () => {
    const app = buildApp();
    await app.request(req('/nvd/deepseek/example.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/article');
  });

  it('returns translated HTML', async () => {
    const app = buildApp();
    const res = await app.request(req('/nvd/deepseek/example.com'));
    const body = await res.text();
    expect(body).toContain('<html>');
    expect(body).toContain('ok');
  });
});
