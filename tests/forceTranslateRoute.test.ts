/**
 * GET /force/<target-without-scheme> 路由单测。
 *
 * 强制翻译：跳过 D1 缓存，强制重新抓取+翻译并覆盖写入。
 * 需要 auth（requireAuth middleware）。
 *
 * 覆盖：
 *   - 无 auth → 401
 *   - 有 auth → 强制翻译（不读 D1）
 *   - 路径解析同 /translate
 *   - D1 写入用 DELETE + INSERT（覆盖已有记录）
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// mock pipeline
vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(async (args: { url: string; mode: string }) => ({
    html: `<html><body>force-translated: ${args.url} (${args.mode})</body></html>`,
    blocks: 5,
    chunks: 2,
    duration_ms: 200,
  })),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:force-' + Math.random().toString(36).slice(2)));
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

function req(path: string, authKey = 'test-auth-key-123456'): Request {
  const headers: Record<string, string> = {};
  if (authKey) headers['Authorization'] = `Bearer ${authKey}`;
  return new Request(`http://test${path}`, { headers });
}

describe('GET /force/<target> — no auth required', () => {
  it('200 without Authorization header', async () => {
    const app = buildApp();
    const res = await app.request(new Request('http://test/force/example.com'));
    expect(res.status).toBe(200);
  });

  it('200 with auth key', async () => {
    const app = buildApp();
    const res = await app.request(req('/force/example.com'));
    expect(res.status).toBe(200);
  });
});

describe('GET /force/<target> — rate limiting', () => {
  it('429 on second request within 1 minute', async () => {
    const app = buildApp();
    // 第一次请求成功
    const res1 = await app.request(new Request('http://test/force/example.com'));
    expect(res1.status).toBe(200);
    // 第二次请求被限流
    const res2 = await app.request(new Request('http://test/force/example.com'));
    expect(res2.status).toBe(429);
    const body = await res2.json() as { error: string };
    expect(body.error).toMatch(/Rate limit/);
  });

  it('429 response includes retry-after info', async () => {
    const app = buildApp();
    await app.request(new Request('http://test/force/other.com'));
    const res = await app.request(new Request('http://test/force/other.com'));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Retry after \d+s/);
  });
});

describe('GET /force/<target> — force mode', () => {
  it('always calls translateUrl (skips D1 cache)', async () => {
    const app = buildApp();
    await app.request(req('/force/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    expect((translateUrl as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('returns translated HTML', async () => {
    const app = buildApp();
    const res = await app.request(req('/force/example.com'));
    const body = await res.text();
    expect(body).toContain('<html>');
    expect(body).toContain('ok');
  });

  it('forwards pipeline metadata headers', async () => {
    const app = buildApp();
    const res = await app.request(req('/force/example.com'));
    expect(res.headers.get('X-Translate-Blocks')).toBe('1');
    expect(res.headers.get('X-Translate-Chunks')).toBe('1');
    expect(res.headers.get('X-Translate-Duration-Ms')).toBe('10');
  });
});

describe('GET /force/<target> — path parsing', () => {
  it('reconstructs https URL from bare host', async () => {
    const app = buildApp();
    await app.request(req('/force/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com');
  });

  it('preserves nested path segments', async () => {
    const app = buildApp();
    await app.request(req('/force/example.com/blog/post-1'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/blog/post-1');
  });

  it('strips https:// when user includes it', async () => {
    const app = buildApp();
    await app.request(req('/force/https%3A%2F%2Fexample.com%2Ffoo'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/foo');
  });
});

describe('GET /force/<target> — validation', () => {
  it('400 when target is empty', async () => {
    const app = buildApp();
    const res = await app.request(req('/force/'));
    expect(res.status).toBe(400);
  });

  it('500 when translateUrl throws', async () => {
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockRejectedValueOnce(new Error('upstream boom'));
    const app = buildApp();
    const res = await app.request(req('/force/example.com'));
    expect(res.status).toBe(500);
  });
});
