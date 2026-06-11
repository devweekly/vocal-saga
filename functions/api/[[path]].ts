/**
 * Cloudflare Pages Function 入口。
 *
 * Hono 在 Workers 上零开销直接跑（`app.fetch(request, env)` 即可），
 * 所以这里只剩 KV 注入 + 单例。
 *
 * 部署：
 *   - wrangler.toml 里要 [[kv_namespaces]] binding = "VOCAL_SAGA_KV"
 *   - npm run build:lib   （构建 lib/dist）
 *   - wrangler pages dev ./public    本地开发
 *   - wrangler pages deploy ./public 部署
 */

/// <reference types="@cloudflare/workers-types" />

import type { PagesFunction, EventContext } from '@cloudflare/workers-types';
import { setDefaultStorage, CloudflareKVStorage, createApp } from '../../lib/index';
import type { Hono } from 'hono';

interface Env {
  VOCAL_SAGA_KV: KVNamespace;
  [key: string]: unknown;
}

// ── 单例：app 复用（Workers 上同一 isolate 共享模块作用域） ──
let _app: Hono | null = null;

function getApp(env: Env): Hono {
  if (_app) return _app;
  setDefaultStorage(new CloudflareKVStorage(env.VOCAL_SAGA_KV));
  _app = createApp();
  return _app;
}

export const onRequest: PagesFunction<Env> = ((context: EventContext<Env, string, unknown>) => {
  const app = getApp(context.env);
  return app.fetch(context.request as unknown as Request, context.env);
}) as unknown as PagesFunction<Env>;
