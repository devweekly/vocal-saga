/**
 * 共享 middleware：Hono `factory` + 鉴权。
 *
 * 用 `hono/factory` 创建一个与默认 Hono 实例共享 Env / Var 类型的 factory，
 * 然后基于这个 factory 写 middleware / handler。这样：
 *   - 不需要每个路由都重复 `if (!checkAuth(c)) return c.json({...}, 401)`
 *   - 后续加 `requireAdmin` / `rateLimit` / `requireJson` 之类也是同一套写法
 *   - 路由 handler 里 `c.var.xxx` 能拿到 middleware 注入的上下文（类型安全）
 *
 * 鉴权逻辑：拿 `c.env.AUTH_KEY`（CF bindings）或 `process.env.AUTH_KEY`
 * （Netlify / Node），与 `Authorization: Bearer <key>` 严格相等。
 */
import { createFactory } from 'hono/factory';
import type { Context } from 'hono';

export const factory = createFactory();

/** 与 checkAuth 保持完全一致的语义：先尝试 c.env，失败再 process.env；不等长直接拒。 */
function getAuthKey(c: Context): string {
  const fromBinding = (c.env as Record<string, string | undefined> | undefined)?.AUTH_KEY;
  const k = fromBinding || process.env.AUTH_KEY || '';
  if (!k || k.length < 6) {
    throw new Error('AUTH_KEY is required and must be at least 6 characters');
  }
  return k;
}

/** 鉴权失败时直接以 401 响应；成功则放行（不修改 c）。 */
export const requireAuth = factory.createMiddleware(async (c, next) => {
  let expected: string;
  try {
    expected = getAuthKey(c);
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const bearer = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (bearer !== expected) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});
