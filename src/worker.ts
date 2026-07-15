/**
 * Cloudflare Workers 入口。
 *
 * 路由策略：所有请求先经 Hono，Hono 返回 404 时再交给 ASSETS 兜底（静态文件）。
 * 和 Pages Functions (`functions/api/[[path]].ts`) 的差别：
 *   - Pages 用 `export const onRequest`，Workers 用 `export default { fetch }`
 *   - 静态文件通过 env.ASSETS.fetch 获取，而非 Cloudflare edge 直接返回
 *     （因为 Hono 需要处理 /, /:id, /s/*, /translate/* 等动态路由）
 *
 * 路由分配（由 Hono 内部处理）：
 *   - /api/*                              → Hono（需 Authorization header）
 *   - /translate/<target-without-scheme>  → Hono（抓取 + 翻译，公开）
 *   - /s/<shorthand>                      → Hono（简写域名入口）
 *   - /                                   → Hono（最新翻译结果）
 *   - /<id> （纯数字）                    → Hono（从 D1 取第 N 次翻译结果）
 *   - 其他（含 /help, /translate.html）  → Hono 404 → ASSETS fetch
 *
 * 为什么不让 Cloudflare edge 直接返回静态文件：
 *   wrangler dev 的 [assets] 实现不能保证所有动态路由（/、/:id、/s/*）
 *   正确落到 Worker；统一走 Hono 后按 404 fallback 最可靠。
 *
 * 配置注入：env bindings 由 createApp(env) 在首次构造 app 时一次性写入 config
 * 单例，所有 service / modelResolver / auth 统一走 config getter。不再需要
 * injectEnv 把 env → process.env 同步（已删除）。
 */

/// <reference types="@cloudflare/workers-types" />

import { createApp, CloudflareKVStorage, setDefaultStorage } from '../lib/dist/index.js';
import type { Hono } from 'hono';

interface Env {
  VOCAL_SAGA_KV: KVNamespace;
  ASSETS: Fetcher;
  [key: string]: unknown;
}

// ── 单例：app 复用（同一 isolate 共享模块作用域） ──
// env 在 isolate 生命周期内不变，首次 createApp(env) 注入 config 后续请求复用。
let _app: Hono | null = null;

function getApp(env: Env): Hono {
  if (_app) return _app;
  setDefaultStorage(new CloudflareKVStorage(env.VOCAL_SAGA_KV));
  _app = createApp(env);
  return _app;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const app = getApp(env);
    const res = await app.fetch(request, env);
    // Hono 返回 404 时回退到 ASSETS 静态文件
    if (res.status === 404 && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return res;
  },
};
