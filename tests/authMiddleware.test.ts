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

const AUTH = 'unit-test-auth-key-123456';

function buildApp(): Hono {
  return new Hono()
    .get('/protected', requireAuth, (c) => c.json({ ok: true }))
    .post('/protected', requireAuth, async (c) => {
      const body = await c.req.json();
      return c.json({ ok: true, body });
    });
}

beforeEach(() => {
  process.env.AUTH_KEY = AUTH;
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
    const saved = process.env.AUTH_KEY;
    delete process.env.AUTH_KEY;
    try {
      const res = await buildApp().request(req('/protected', { headers: { Authorization: `Bearer ${AUTH}` } }));
      expect(res.status).toBe(401);
    } finally {
      process.env.AUTH_KEY = saved;
    }
  });

  it('401 when AUTH_KEY is too short (<6 chars)', async () => {
    const saved = process.env.AUTH_KEY;
    process.env.AUTH_KEY = 'short';
    try {
      const res = await buildApp().request(req('/protected', { headers: { Authorization: 'Bearer short' } }));
      expect(res.status).toBe(401);
    } finally {
      process.env.AUTH_KEY = saved;
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

  it('tolerates multiple spaces after Bearer (\s+ is greedy)', async () => {
    // 旧 checkAuth 的语义：`replace(/^Bearer\s+/i, '')` 贪婪吃所有空白，剩 AUTH，匹配成功。
    // 保留这个 back-compat 行为；如果将来要严格 1 空格，需要改 lib/auth.ts + 同步更新这里。
    const res = await buildApp().request(req('/protected', { headers: { Authorization: `Bearer  ${AUTH}` } }));
    expect(res.status).toBe(200);
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
  it('factory.createMiddleware is reusable across many routes', async () => {
    // 显式走 factory（而不是直接 import）确保它确实是工厂方法
    const mw = factory.createMiddleware(async (_c, next) => {
      await next();
    });
    const app = new Hono()
      .get('/a', requireAuth, mw, (c) => c.json({ a: true }))
      .get('/b', requireAuth, (c) => c.json({ b: true }));

    const a = await app.request(req('/a', { headers: { Authorization: `Bearer ${AUTH}` } }));
    const b = await app.request(req('/b', { headers: { Authorization: `Bearer ${AUTH}` } }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual({ a: true });
    expect(await b.json()).toEqual({ b: true });
  });

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
