/**
 * GET /api/translate/url 路由单测。
 *
 * 覆盖：
 *   - Auth: 无 token / 错 token → 401
 *   - 参数校验: 缺 url / 非 URL / 非 http(s) / 错 mode
 *   - 成功路径: 拿到 translateUrl 的 html 透传 + 元数据 header
 *   - translateUrl 抛错 → 500
 *   - mode 缺省 → bilingual；target 缺省 → zh
 *
 * 用 vi.mock 替换 lib/translate/pipeline 的 translateUrl，避免真调 DeepSeek。
 * 真调 LLM 的路径留给 smoke / e2e。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// mock 必须在被测模块 import 之前
vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(async (args: { url: string; mode: string }) => ({
    html: `<html><body><p>translated: ${args.url} (${args.mode})</p></body></html>`,
    blocks: 7,
    chunks: 3,
    duration_ms: 123,
  })),
}));

// Hono app.request 不需要真启服务，直接构造 request 喂给 app.fetch 即可
import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

const AUTH = 'test-auth-key-123456';

beforeAll(() => {
  process.env.AUTH_KEY = AUTH;
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:url-route-' + Math.random().toString(36).slice(2)));
  // 重置 mock 计数 + 默认成功实现（mock 在模块顶部声明一次即可，但 fn.calls 跨用例会累加）
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

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://test${path}`, { headers });
}

describe('GET /api/translate/url — auth', () => {
  it('returns 401 without Authorization header', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/translate/url?url=https://example.com'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 with wrong bearer token', async () => {
    const app = buildApp();
    const res = await app.request(
      req('/api/translate/url?url=https://example.com', {
        Authorization: 'Bearer wrong',
      })
    );
    expect(res.status).toBe(401);
  });

  it('passes with correct bearer token', async () => {
    const app = buildApp();
    const res = await app.request(
      req('/api/translate/url?url=https://example.com', {
        Authorization: `Bearer ${AUTH}`,
      })
    );
    expect(res.status).toBe(200);
  });
});

describe('GET /api/translate/url — query param validation', () => {
  it('400 when url is missing', async () => {
    const app = buildApp();
    const res = await app.request(
      req('/api/translate/url', { Authorization: `Bearer ${AUTH}` })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/url query param is required/);
  });

  it('400 when url is not a valid URL', async () => {
    const app = buildApp();
    const res = await app.request(
      req('/api/translate/url?url=not%20a%20url', { Authorization: `Bearer ${AUTH}` })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not a valid URL/);
  });

  it('400 when protocol is not http/https', async () => {
    const app = buildApp();
    const res = await app.request(
      req('/api/translate/url?url=ftp%3A%2F%2Fexample.com%2Fa', {
        Authorization: `Bearer ${AUTH}`,
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/http or https/);
  });

  it('400 when mode is neither bilingual nor target', async () => {
    const app = buildApp();
    const res = await app.request(
      req('/api/translate/url?url=https%3A%2F%2Fexample.com%2Fa&mode=wat', {
        Authorization: `Bearer ${AUTH}`,
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/bilingual or target/);
  });

  it('500 when DEEPSEEK_API_KEY is missing', async () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const app = buildApp();
      const res = await app.request(
        req('/api/translate/url?url=https%3A%2F%2Fexample.com%2Fa', {
          Authorization: `Bearer ${AUTH}`,
        })
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/DeepSeek not configured/);
    } finally {
      process.env.DEEPSEEK_API_KEY = saved;
    }
  });
});

describe('GET /api/translate/url — success path', () => {
  it('returns text/html and forwards pipeline metadata headers', async () => {
    const app = buildApp();
    const res = await app.request(
      req('/api/translate/url?url=https%3A%2F%2Fexample.com%2Fa&mode=bilingual&target=zh&source=en', {
        Authorization: `Bearer ${AUTH}`,
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('X-Translate-Blocks')).toBe('1');
    expect(res.headers.get('X-Translate-Chunks')).toBe('1');
    expect(res.headers.get('X-Translate-Duration-Ms')).toBe('10');
    const html = await res.text();
    expect(html).toBe('<html><body>ok</body></html>');
  });

  it('defaults target to zh and mode to bilingual', async () => {
    const app = buildApp();
    const res = await app.request(
      req('/api/translate/url?url=https%3A%2F%2Fexample.com%2Fa', {
        Authorization: `Bearer ${AUTH}`,
      })
    );
    expect(res.status).toBe(200);
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.target).toBe('zh');
    expect(call.mode).toBe('bilingual');
    expect(call.source).toBeUndefined();
    expect(call.url).toBe('https://example.com/a');
  });

  it('500 when translateUrl throws', async () => {
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockRejectedValueOnce(new Error('upstream boom'));
    const app = buildApp();
    const res = await app.request(
      req('/api/translate/url?url=https%3A%2F%2Fexample.com%2Fa', {
        Authorization: `Bearer ${AUTH}`,
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('upstream boom');
  });
});
