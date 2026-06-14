/**
 * GET /translate/<target-without-scheme> 路由单测。
 *
 * 设计：浏览器直访入口，无 auth。路径里的 target 是去掉 `https://` 后的 URL
 * 剩余部分，server 补回 `https://` 后抓取 + 翻译 + 双语回填 HTML。
 *
 * 覆盖：
 *   - 路径缺失 / 剥 scheme 后为空 → 400
 *   - 模式非法 → 400
 *   - 成功后透传 pipeline 的 html + 元数据 header
 *   - 默认 target=zh, mode=bilingual
 *   - 兼容用户传含 scheme 的 URL（自动剥）
 *   - translateUrl 抛错 → 500
 *   - 旧 /api/translate/url（GET/POST）都 404（彻底废弃）
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// mock 必须在被测模块 import 之前
vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(async (args: { url: string; mode: string }) => ({
    html: `<html><body>translated: ${args.url} (${args.mode})</p></body></html>`,
    blocks: 7,
    chunks: 3,
    duration_ms: 123,
  })),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:translate-' + Math.random().toString(36).slice(2)));
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

describe('GET /translate/<target> — no auth (browser-direct)', () => {
  it('serves without Authorization header', async () => {
    const app = buildApp();
    const res = await app.request(req('/translate/example.com'));
    expect(res.status).toBe(200);
  });

  it('200 with no Authorization and no query params', async () => {
    const app = buildApp();
    const res = await app.request(req('/translate/example.com/foo'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('forwards pipeline metadata as response headers', async () => {
    const app = buildApp();
    const res = await app.request(req('/translate/example.com?mode=bilingual&target=zh&source=en'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Blocks')).toBe('1');
    expect(res.headers.get('X-Translate-Chunks')).toBe('1');
    expect(res.headers.get('X-Translate-Duration-Ms')).toBe('10');
  });
});

describe('GET /translate/<target> — path parsing', () => {
  it('reconstructs https URL from bare host', async () => {
    const app = buildApp();
    await app.request(req('/translate/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com');
  });

  it('preserves nested path segments', async () => {
    const app = buildApp();
    await app.request(req('/translate/example.com/blog/post-1'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/blog/post-1');
  });

  it('strips https:// when user includes it (URL-encoded)', async () => {
    // 用户在地址栏直接粘贴完整 URL 时的常见情况：含 https:// 被编码
    const app = buildApp();
    await app.request(req('/translate/https%3A%2F%2Fexample.com%2Ffoo'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/foo');
  });

  it('defaults target to zh and mode to bilingual', async () => {
    const app = buildApp();
    await app.request(req('/translate/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.target).toBe('zh');
    expect(call.mode).toBe('bilingual');
    expect(call.source).toBeUndefined();
  });

  it('respects explicit mode and target', async () => {
    const app = buildApp();
    await app.request(req('/translate/example.com?mode=target&target=en&source=zh'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.mode).toBe('target');
    expect(call.target).toBe('en');
    expect(call.source).toBe('zh');
  });
});

describe('GET /translate/<target> — validation', () => {
  it('400 when target is empty', async () => {
    const app = buildApp();
    const res = await app.request(req('/translate/'));
    expect(res.status).toBe(400);
  });

  it('400 when only the scheme is given (e.g. /translate/https://)', async () => {
    const app = buildApp();
    const res = await app.request(req('/translate/https%3A%2F%2F'));
    expect(res.status).toBe(400);
  });

  it('400 when mode is invalid', async () => {
    const app = buildApp();
    const res = await app.request(req('/translate/example.com?mode=wat'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/bilingual or target/);
  });

  it('500 when translateUrl throws', async () => {
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockRejectedValueOnce(new Error('upstream boom'));
    const app = buildApp();
    const res = await app.request(req('/translate/example.com'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('upstream boom');
  });
});

describe('GET /translate/<target> — URL normalization', () => {
  it('strips https:// prefix', async () => {
    const app = buildApp();
    await app.request(req('/translate/https%3A%2F%2Fexample.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/article');
  });

  it('strips http:// prefix and forces https', async () => {
    const app = buildApp();
    await app.request(req('/translate/http%3A%2F%2Fexample.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/article');
  });

  it('adds .com suffix for domain without dot (towardsdatascience)', async () => {
    const app = buildApp();
    await app.request(req('/translate/towardsdatascience/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://towardsdatascience.com/article');
  });

  it('adds .com suffix for bare domain without dot', async () => {
    const app = buildApp();
    await app.request(req('/translate/medium'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://medium.com');
  });

  it('does not add .com for domain with dot', async () => {
    const app = buildApp();
    await app.request(req('/translate/example.org/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.org/article');
  });

  it('preserves www. prefix (www and non-www treated as different)', async () => {
    const app = buildApp();
    await app.request(req('/translate/www.example.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://www.example.com/article');
  });
});

describe('legacy /api/translate/url — fully removed', () => {
  it('GET /api/translate/url returns 404', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/translate/url?url=https://example.com'));
    expect(res.status).toBe(404);
  });

  it('POST /api/translate/url returns 404', async () => {
    const app = buildApp();
    const res = await app.request(
      new Request('http://test/api/translate/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      })
    );
    expect(res.status).toBe(404);
  });
});
