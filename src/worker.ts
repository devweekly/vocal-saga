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
let _app: Hono | null = null;

function getApp(env: Env): Hono {
  if (_app) return _app;
  setDefaultStorage(new CloudflareKVStorage(env.VOCAL_SAGA_KV));
  _app = createApp();
  return _app;
}

/**
 * 把 Workers env bindings 同步到 process.env。
 * lib/ 里有些代码会读 process.env（AUTH_KEY / 上游 API key），直接同步一次避免双源。
 *   - 只复制字符串值（KV / ASSETS binding 这种对象不复制）
 *   - 只在缺失时设置，避免覆盖 CI 注入
 */
let _envInjected = false;

function injectEnv(env: Env): void {
  if (_envInjected) return;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && !process.env[k]) {
      process.env[k] = v;
    }
  }
  _envInjected = true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    injectEnv(env);
    const app = getApp(env);
    const res = await app.fetch(request, env);
    // Hono 返回 404 时回退到 ASSETS 静态文件
    if (res.status === 404 && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return res;
  },
};
