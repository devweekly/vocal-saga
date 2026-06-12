/**
 * GET / 和 GET /s/* 路由单测。
 *
 * /  — 展示上一次翻译结果（瞬态），无翻译时 302 → /help
 * /s/ — 简写域名扩展：单单词无点号 → www.<word>.com
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:shortcut-' + Math.random().toString(36).slice(2)));
  const { translateUrl } = await import('../lib/translate/pipeline');
  (translateUrl as any).mockClear();
  (translateUrl as any).mockResolvedValue({
    html: '<html><body>translated content</body></html>',
    blocks: 5,
    chunks: 2,
    duration_ms: 42,
  });
});

function buildApp() {
  return createApp();
}

function req(path: string): Request {
  return new Request(`http://test${path}`);
}

describe('GET / — last translated page', () => {
  it('redirects to /help when no translation has been done', async () => {
    const app = buildApp();
    const res = await app.request(req('/'));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/help');
  });

  it('returns last translated HTML after a /translate/* call', async () => {
    const app = buildApp();
    // 先发起一次翻译请求
    await app.request(req('/translate/example.com'));
    // / 应该返回刚才的翻译结果
    const res = await app.request(req('/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('translated content');
  });

  it('returns last translated HTML after a /s/* call', async () => {
    const app = buildApp();
    await app.request(req('/s/medium/article'));
    const res = await app.request(req('/'));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('translated content');
  });

  it('returns the most recent translation (overwrites previous)', async () => {
    const app = buildApp();
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockResolvedValueOnce({
      html: '<html><body>first</body></html>',
      blocks: 1, chunks: 1, duration_ms: 10,
    });
    (translateUrl as any).mockResolvedValueOnce({
      html: '<html><body>second</body></html>',
      blocks: 1, chunks: 1, duration_ms: 10,
    });
    await app.request(req('/translate/site1.com'));
    await app.request(req('/translate/site2.com'));
    const res = await app.request(req('/'));
    const text = await res.text();
    expect(text).toContain('second');
    expect(text).not.toContain('first');
  });
});

describe('GET /s/<domain-or-shorthand> — shorthand URL expansion', () => {
  // ── 行为等价于 /translate：无 auth 检查 ──
  it('serves without Authorization header', async () => {
    const app = buildApp();
    const res = await app.request(req('/s/example.com'));
    expect(res.status).toBe(200);
  });

  // ── 单单词扩展 ──
  it('expands single-word to www.<word>.com', async () => {
    const app = buildApp();
    await app.request(req('/s/medium/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://www.medium.com/article');
  });

  it('preserves nested path with default www expansion', async () => {
    const app = buildApp();
    await app.request(req('/s/reddit/r/programming'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://www.reddit.com/r/programming');
  });

  it('handles single-word with no trailing path', async () => {
    const app = buildApp();
    await app.request(req('/s/example'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://www.example.com');
  });

  // ── 有点号的域名原样使用 ──
  it('uses domain as-is when it contains a dot', async () => {
    const app = buildApp();
    await app.request(req('/s/example.com/blog'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/blog');
  });

  it('preserves multi-level domain with trailing slashes', async () => {
    const app = buildApp();
    await app.request(req('/s/sub.example.co.uk/path/to/page'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://sub.example.co.uk/path/to/page');
  });

  // ── 空路径 ──
  it('400 when target is empty (just /s/)', async () => {
    const app = buildApp();
    const res = await app.request(req('/s/'));
    expect(res.status).toBe(400);
  });

  // ── query params 透传 ──
  it('defaults target to zh and mode to bilingual', async () => {
    const app = buildApp();
    await app.request(req('/s/medium/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.target).toBe('zh');
    expect(call.mode).toBe('bilingual');
    expect(call.source).toBeUndefined();
  });

  it('passes through source, target, mode query params', async () => {
    const app = buildApp();
    await app.request(req('/s/example.com/article?source=en&target=fr&mode=target'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.source).toBe('en');
    expect(call.target).toBe('fr');
    expect(call.mode).toBe('target');
  });

  // ── 元数据 header ──
  it('forwards pipeline metadata as response headers', async () => {
    const app = buildApp();
    const res = await app.request(req('/s/medium/article'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Blocks')).toBe('5');
    expect(res.headers.get('X-Translate-Chunks')).toBe('2');
    expect(res.headers.get('X-Translate-Duration-Ms')).toBe('42');
  });

  // ── 错误传播 ──
  it('500 when translateUrl throws', async () => {
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockRejectedValueOnce(new Error('upstream boom'));
    const app = buildApp();
    const res = await app.request(req('/s/medium/article'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('upstream boom');
  });

  it('500 when DEEPSEEK_API_KEY is missing', async () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const app = buildApp();
      const res = await app.request(req('/s/example.com'));
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/DeepSeek not configured/);
    } finally {
      process.env.DEEPSEEK_API_KEY = saved;
    }
  });
});
