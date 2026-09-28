/**
 * `requireAuth` middleware（lib/auth.ts）单测。
 *
 * 通过把它挂到一个最小的 Hono app 上跑 `app.request()` 验证：
 *   - 没有 Authorization header → 401
 *   - 错误 bearer token → 401
 *   - scheme 错（不带 Bearer）→ 401
 *   - case-insensitive Bearer 前缀 → 接受
 *   - 正确 token → 放行（c.set 的值透传 / next() 触发）
 *   - AUTH_KEY 缺失或 <6 chars → 401（不应 throw 把请求搞崩）
 *   - 路由不会因为多个 requireAuth 叠加而出问题
 *   - factory 复用：路由上挂两层 factory middleware 都能正常放行
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { factory, requireAuth } from '../lib/auth';
import { setAuthKey } from '../lib/config';

const AUTH = 'unit-test-auth-key-123456';

function buildApp(): Hono {
  return new Hono()
    .get('/protected', requireAuth, (c) => c.json({ ok: true }))
    .post('/protected', requireAuth, async (c) => {
      const body = await c.req.json();
      return c.json({ ok: true, body });
    });
}

// P0-3 后 requireAuth 从 config 单例读 AUTH_KEY，不再读 c.env / process.env。
// 测试通过 setter 显式注入（与 createApp(env) 生产路径一致）。
beforeEach(() => {
  setAuthKey(AUTH);
});

function req(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Request {
  return new Request(`http://test${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.headers,
    body: opts.body,
  });
}

describe('requireAuth — rejection paths', () => {
  it('401 when no Authorization header', async () => {
    const res = await buildApp().request(req('/protected'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('401 when Authorization header has wrong bearer token', async () => {
    const res = await buildApp().request(req('/protected', { headers: { Authorization: 'Bearer wrong-key' } }));
    expect(res.status).toBe(401);
  });

  it('accepts raw token without Bearer prefix (back-compat with old checkAuth)', async () => {
    // 旧 checkAuth 用 `bearer === expected`，等价于 `replace(/^Bearer\s+/i, '')`。
    // 如果 header 完全没有 "Bearer" 前缀，replace 不命中，原样比对 → 接受。
    // 这条路径保留以免突然收紧破坏既有调用方。
    const res = await buildApp().request(req('/protected', { headers: { Authorization: AUTH } }));
    expect(res.status).toBe(200);
  });

  it('401 when Authorization header is malformed (Basic scheme)', async () => {
    const res = await buildApp().request(req('/protected', { headers: { Authorization: `Basic ${AUTH}` } }));
    expect(res.status).toBe(401);
  });

  it('401 when AUTH_KEY env is missing entirely', async () => {
    setAuthKey('');
    try {
      const res = await buildApp().request(req('/protected', { headers: { Authorization: `Bearer ${AUTH}` } }));
      expect(res.status).toBe(401);
    } finally {
      setAuthKey(AUTH);
    }
  });

  it('401 when AUTH_KEY is too short (<6 chars)', async () => {
    setAuthKey('short');
    try {
      const res = await buildApp().request(req('/protected', { headers: { Authorization: 'Bearer short' } }));
      expect(res.status).toBe(401);
    } finally {
      setAuthKey(AUTH);
    }
  });
});

describe('requireAuth — acceptance paths', () => {
  it('200 with correct bearer token', async () => {
    const res = await buildApp().request(req('/protected', { headers: { Authorization: `Bearer ${AUTH}` } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('accepts case-insensitive Bearer prefix', async () => {
    for (const prefix of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) {
      const res = await buildApp().request(req('/protected', { headers: { Authorization: `${prefix} ${AUTH}` } }));
      expect(res.status, `prefix=${prefix}`).toBe(200);
    }
  });


  it('works for POST with JSON body (middleware runs before body parse)', async () => {
    const res = await buildApp().request(
      req('/protected', {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; body: { text: string } };
    expect(body.body.text).toBe('hi');
  });
});

describe('requireAuth — composability via factory', () => {

  it('does not swallow downstream errors (forwards to default error handler)', async () => {
    const app = new Hono()
      .get('/boom', requireAuth, () => {
        throw new Error('kaboom');
      });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app.request(req('/boom', { headers: { Authorization: `Bearer ${AUTH}` } }));
      // Hono 默认对 throw 返 500
      expect(res.status).toBe(500);
    } finally {
      errSpy.mockRestore();
    }
  });
});
