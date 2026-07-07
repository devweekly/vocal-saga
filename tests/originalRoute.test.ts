/**
 * GET /original/<target> 和 GET /o/<target> 路由单测。
 *
 * 返回原始页面 HTML，不做翻译。支持 https:// 前缀。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../lib/translate/urlFetcher', () => ({
  fetchPage: vi.fn(async (url: string) => {
    const isX = url.includes('x.com') || url.includes('twitter.com');
    return {
      url,
      finalUrl: url,
      html: isX
        ? '<html><head><script src="https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload"></script></head><body>original content</body></html>'
        : '<html><body>original content</body></html>',
      status: 200,
      doc: { querySelector: () => null },
    };
  }),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(() => {
  setDefaultStorage(new MapStorage('test:original-' + Math.random().toString(36).slice(2)));
});

function buildApp() {
  return createApp();
}

describe('GET /original/<target>', () => {
  it('200 with valid request', async () => {
    const app = buildApp();
    const res = await app.request(new Request('http://test/original/example.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('returns original HTML', async () => {
    const app = buildApp();
    const res = await app.request(new Request('http://test/original/example.com'));
    const body = await res.text();
    expect(body).toContain('original content');
  });

  it('strips https:// prefix', async () => {
    const app = buildApp();
    const res = await app.request(new Request('http://test/original/https%3A%2F%2Fexample.com/article'));
    expect(res.status).toBe(200);
  });

  it('400 when target is empty', async () => {
    const app = buildApp();
    const res = await app.request(new Request('http://test/original/'));
    expect(res.status).toBe(400);
  });

  it('removes Cloudflare jsd challenge scripts for X/Twitter pages', async () => {
    const app = buildApp();
    const res = await app.request(new Request('http://test/original/x.com/i/status/123'));
    const body = await res.text();
    expect(body).toContain('original content');
    expect(body).not.toContain('cdn-cgi/challenge-platform');
    expect(body).not.toContain('jsdOnload');
  });
});

describe('GET /o/<target>', () => {
  it('200 with valid request', async () => {
    const app = buildApp();
    const res = await app.request(new Request('http://test/o/example.com'));
    expect(res.status).toBe(200);
  });

  it('returns original HTML (same as /original)', async () => {
    const app = buildApp();
    const res = await app.request(new Request('http://test/o/example.com'));
    const body = await res.text();
    expect(body).toContain('original content');
  });

  it('strips https:// prefix', async () => {
    const app = buildApp();
    const res = await app.request(new Request('http://test/o/https%3A%2F%2Fexample.com/article'));
    expect(res.status).toBe(200);
  });
});
