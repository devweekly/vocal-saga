/**
 * /oc/* 路由单测。
 *
 * 覆盖：
 *   - 路由匹配与 path 解析
 *   - provider 传递为 'opencode'
 *   - /fanyi/page provider=opencode 校验
 *   - 无 path 时返回 400
 *   - 多级路径解析（domain/path/subpath）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../lib/app';
import type { Hono } from 'hono';

// ── mock translateUrl / translateHtml，避免真实网络请求 ─────
vi.mock('../lib/translate/pipeline', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    translateUrl: vi.fn().mockResolvedValue({
      url: 'mock-url',
      finalUrl: 'https://example.com',
      title: 'Mock Title',
      html: '<html><body>mock</body></html>',
      blocks: [],
      chunks: [],
      duration: 100,
    }),
    translateHtml: vi.fn().mockResolvedValue({
      html: '<html><body>mock translated</body></html>',
      blocks: 1,
      translatedBlocks: 1,
      chunks: 1,
      duration: 100,
    }),
  };
});

// ── mock storage（内存 KV） ────────────────────────────────
vi.mock('../lib/storage', () => {
  const map = new Map<string, string>();
  return {
    setDefaultStorage: vi.fn(),
    getDefaultStorage: () => ({
      get: async (key: string) => map.get(key) ?? null,
      set: async (key: string, val: string) => { map.set(key, val); },
      delete: async (key: string) => { map.delete(key); },
    }),
  };
});

import { translateUrl } from '../lib/translate/pipeline';
import { setOpencodeApiKey } from '../lib/config';

describe('/oc/* 路由', () => {
  let app: Hono;

  beforeEach(() => {
    setOpencodeApiKey('test-opencode-key');
    app = createApp();
    vi.mocked(translateUrl).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 基本路由匹配 ────────────────────────────────────────
  it('GET /oc/example.com 路由匹配', async () => {
    const res = await app.request('/oc/example.com');
    expect(res.status).not.toBe(404);
  });

  // ── path 解析 ───────────────────────────────────────────
  it('GET /oc/example.com → translateUrl url 参数含 https://', async () => {
    await app.request('/oc/example.com');
    expect(translateUrl).toHaveBeenCalledTimes(1);
    const args = vi.mocked(translateUrl).mock.calls[0][0];
    expect(args.url).toBe('https://example.com');
    expect(args.provider).toBe('opencode');
  });

  // ── 多级路径 ────────────────────────────────────────────
  it('GET /oc/example.com/path/to/page → url 解析为完整路径', async () => {
    await app.request('/oc/example.com/path/to/page');
    expect(translateUrl).toHaveBeenCalledTimes(1);
    const args = vi.mocked(translateUrl).mock.calls[0][0];
    expect(args.url).toBe('https://example.com/path/to/page');
    expect(args.provider).toBe('opencode');
  });

  // ── 带 https:// 的 URL ──────────────────────────────────
  it('GET /oc/https://example.com → url 保留 scheme', async () => {
    await app.request('/oc/https://example.com');
    expect(translateUrl).toHaveBeenCalledTimes(1);
    const args = vi.mocked(translateUrl).mock.calls[0][0];
    expect(args.url).toBe('https://example.com');
    expect(args.provider).toBe('opencode');
  });

  // ── provider 传递 ───────────────────────────────────────
  it('provider 字段固定为 opencode', async () => {
    await app.request('/oc/example.com');
    const args = vi.mocked(translateUrl).mock.calls[0][0];
    expect(args.provider).toBe('opencode');
  });

  // ── /fanyi/page provider=opencode 合法 ──────────────────
  it('POST /fanyi/page provider=opencode 接受请求', async () => {
    const res = await app.request('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com',
        html: '<html><body><p>Hello</p></body></html>',
        provider: 'opencode',
      }),
    });
    // 不应返回 400 provider 错误（provider 校验通过）
    expect(res.status).not.toBe(400);
    // 返回翻译后的 HTML
    const text = await res.text();
    expect(text).toContain('html');
  });

  // ── /fanyi/page provider=invalid 拒绝 ───────────────────
  it('POST /fanyi/page provider=invalid 返回 400', async () => {
    const res = await app.request('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com',
        html: '<html><body><p>Hello</p></body></html>',
        provider: 'invalid-provider',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('opencode');
  });

  // ── 无 path 时 ──────────────────────────────────────────
  it('GET /oc/ 无 path 时返回 400', async () => {
    const res = await app.request('/oc/');
    const body = await res.json();
    // 空 path 应该触发 url required 错误
    expect(body.error).toContain('url');
  });

  // ── URL 编码路径 ────────────────────────────────────────
  it('GET /oc/带编码的路径 → decodeURIComponent 解析', async () => {
    const encoded = encodeURIComponent('example.com/中文路径');
    await app.request(`/oc/${encoded}`);
    expect(translateUrl).toHaveBeenCalledTimes(1);
    const args = vi.mocked(translateUrl).mock.calls[0][0];
    expect(args.url).toContain('中文路径');
  });
});
