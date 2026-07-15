/**
 * 共享 middleware：Hono `factory` + 鉴权。
 *
 * 鉴权逻辑：AUTH_KEY 由 createApp(env) 启动时注入 config 单例（统一入口），
 * requireAuth 从 config getter 读取，与请求的 Bearer token 严格相等校验。
 * 不再直接读 c.env / process.env，避免双路径不一致。
 *
 * 用 `hono/factory` 创建一个与默认 Hono 实例共享 Env / Var 类型的 factory，
 * 然后基于这个 factory 写 middleware / handler。这样：
 *   - 不需要每个路由都重复 `if (!checkAuth(c)) return c.json({...}, 401)`
 *   - 后续加 `requireAdmin` / `rateLimit` / `requireJson` 之类也是同一套写法
 *   - 路由 handler 里 `c.var.xxx` 能拿到 middleware 注入的上下文（类型安全）
 */
import { createFactory } from 'hono/factory';
import { getAuthKey as getConfigAuthKey } from './config';

export const factory = createFactory();

/** 从 config 读取期望的 AUTH_KEY，并校验长度（至少 6 字符）。 */
function getExpectedAuthKey(): string {
  const k = getConfigAuthKey();
  if (!k || k.length < 6) {
    throw new Error('AUTH_KEY is required and must be at least 6 characters');
  }
  return k;
}

/** 鉴权失败时直接以 401 响应；成功则放行（不修改 c）。 */
export const requireAuth = factory.createMiddleware(async (c, next) => {
  let expected: string;
  try {
    expected = getExpectedAuthKey();
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const bearer = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (bearer !== expected) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});
