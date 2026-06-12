/**
 * Cloudflare Workers 入口。
 *
 * 和 Pages Functions (`functions/api/[[path]].ts`) 的差别：
 *   - Pages 用 `export const onRequest`，Workers 用 `export default { fetch }`
 *   - 静态文件走 [assets] binding，路径匹配的（如 /index.html, /translate.html）
 *     由 Cloudflare edge 直接返回，不进 Worker。
 *     默认会自动去掉 .html 扩展名：访问 /translate 和 /translate.html 等价。
 *
 * 路由分配：
 *   - /api/*                              → Hono
 *   - /translate/<target-without-scheme>  → Hono（抓取 + 翻译，公开）
 *   - 其他（含 /, /translate, /translate.html）→ env.ASSETS.fetch
 *
 * 静态文件匹配不到的路径才会进入 Worker。
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
function injectEnv(env: Env): void {
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && !process.env[k]) {
      process.env[k] = v;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 动态路由：API + URL 翻译入口都进 Hono
    const isApi = url.pathname.startsWith('/api/');
    // /translate/<anything-non-empty> 走 Hono（抓取 + 翻译）
    const isTranslateDyn = url.pathname.startsWith('/translate/');
    if (isApi || isTranslateDyn) {
      injectEnv(env);
      return getApp(env).fetch(request, env);
    }

    // 其他路径（含 /, /translate, /translate.html, 任何不存在的路径）
    // 交给 Assets binding：命中文件就发，命中不了就 404。
    // 裸 /translate / /translate/ 走 public/translate.html
    return env.ASSETS.fetch(request);
  },
};
