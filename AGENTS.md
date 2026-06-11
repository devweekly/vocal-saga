# AGENTS.md

## Project Architecture

An OpenAI-compatible LLM proxy + translation API, deployable on **Netlify Functions** or **Cloudflare Pages**. Built on **Hono** (edge-first, no Node-only deps). The Hono app is platform-agnostic; each platform provides a thin shim entry that wires up a platform-specific storage backend.

```
/
├── lib/                            # Platform-agnostic source (compiled to lib/dist/)
│   ├── app.ts                      # createApp() factory — Hono app + routes
│   ├── index.ts                    # Public entry: createApp + storage adapters
│   ├── storage/                    # StorageAdapter abstraction
│   │   ├── types.ts                #   interface StorageAdapter
│   │   ├── netlify.ts              #   Netlify Blobs adapter
│   │   ├── cloudflare.ts           #   Cloudflare KV adapter
│   │   ├── memory.ts               #   MapStorage (tests / local dev)
│   │   └── index.ts                #   setDefaultStorage / getDefaultStorage registry
│   └── translate/                  # LLM + translation business logic
├── netlify/
│   └── functions/
│       └── api.mjs                 # Netlify shim → handle(app) from hono/aws-lambda
├── functions/                      # Cloudflare Pages Functions
│   └── api/
│       └── [[path]].ts             # CF Pages onRequest → app.fetch(request, env)
├── public/                         # Static assets (publish dir for both platforms)
├── wrangler.toml                   # Cloudflare Pages + KV binding
├── netlify.toml                    # Netlify build config (esbuild bundler)
└── package.json
```

## Key Decisions

- **Hono instead of Express** — runs natively on Cloudflare Workers (no Node-only deps), and `hono/aws-lambda` adapts it to Netlify's Lambda runtime. The same `lib/app.ts` is bundled into both platforms.
- **Platform-agnostic core** — `lib/app.ts` exports `createApp(storage?: StorageAdapter)`. The Hono app knows nothing about Netlify or Cloudflare.
- **Storage abstraction** — `StorageAdapter` interface (`get/set/getJSON/setJSON/delete/list`). Three implementations: `NetlifyBlobsStorage`, `CloudflareKVStorage`, `MapStorage`. A single default storage is set at startup; `getDefaultStorage()` retrieves it. Module-level modules (glossary store, cache manager) call `getDefaultStorage()` — no platform binding.
- **Key namespacing** — multiple modules share one storage instance via prefixes (`glossary:user_terms`, `cache:analysis:`, etc.). No need to configure multiple KV bindings or Netlify stores.
- **Cross-platform env reads** — `lib/app.ts` uses `env(c, key)` helper that checks `c.env` (CF bindings) first, falls back to `process.env` (Netlify Lambda / Node). The CF shim also has `injectEnv()` to sync bindings into `process.env` for any module-level reads. No AUTH_KEY validation at module load — it happens per-request.
- **Lazy `getDefaultStorage()`** — `CacheManager` uses a getter that resolves the default storage on first access. Required because CF Workers modules are evaluated eagerly at isolate start, before any platform shim can call `setDefaultStorage()`.
- **Lazy `import('jsdom')`** — `urlFetcher.ts` uses dynamic import because jsdom pulls in an old `undici` that references `MessagePort` (not defined in Workers). With dynamic import, only the URL translation path pays this cost; the rest of the API (chat, models, glossary) works on CF. Trade-off: **URL translation is Netlify-only by design** — CF callers get a 500 with a clear upstream error. Migrating to `linkedom` (Workers-friendly DOM) would close the gap; not done here.
- **Platform shims are tiny**:
  - Netlify: `import { handle } from 'hono/aws-lambda'; import { createApp, NetlifyBlobsStorage } from '../../lib/dist/index.js'; export const handler = handle(createApp(new NetlifyBlobsStorage('main')))`
  - Cloudflare Workers: `src/worker.ts` exports `default { fetch(request, env) { if (url.pathname.startsWith('/api/')) return getApp(env).fetch(request, env); return env.ASSETS.fetch(request) } }`
- **Netlify**: `esbuild` bundles `lib/dist/` (via `included_files`). No `external_node_modules` needed — Hono is pure ESM/JS, no Node built-ins.
- **Cloudflare**: `wrangler dev` / `wrangler deploy` for Workers. KV binding via `[[kv_namespaces]]`; static assets via `[assets] directory = "./public" binding = "ASSETS"`. Path-matched files (`/index.html`, `/translate.html`) are served by Cloudflare edge without invoking the Worker; unmatched paths fall through to `env.ASSETS.fetch(request)`. Cloudflare auto-strips the `.html` extension: `/translate` and `/translate.html` are equivalent (the latter 307-redirects to the former). `nodejs_compat` flag required for `process.env` mutation in the shim and undici compat.
- **Streaming** — the chat completions endpoint passes the upstream `ReadableStream` directly to `new Response(body, headers)`. No buffering, no transformation.
- **`type: "module"`** in `package.json` — Netlify shim is `.mjs`; Cloudflare function is `.ts` (esbuild-compiled at deploy time by Wrangler).

## Coding Conventions

- Add new routes in `lib/app.ts` using Hono syntax (`app.get/post/put/delete`). Always respond with `c.json(...)` or `return new Response(...)` for streams. Use `c.req.json()` for body, `c.req.query()` for query, `c.req.param()` for path params, `c.req.header()` for headers.
- For persistent state, use `getDefaultStorage().getJSON/setJSON(...)` with a module-specific key prefix — never call platform-specific SDKs from `lib/`.
- New platform? Add a new `lib/storage/<platform>.ts` adapter and a new shim in the platform's entry location. No changes needed in `lib/app.ts` or `lib/translate/`.
- For Cloudflare, the `Env` type in the shim is the source of truth for bindings (`KVNamespace` etc.). Pass them into storage adapters; the app stays binding-free.

## Test / Build

- `npm run build:lib` — compile `lib/` to `lib/dist/`.
- `npm run typecheck` — type-check `lib/`, `netlify/functions/`, and `src/worker.ts`.
- `npm test` — Vitest; `tests/setup.ts` injects a fresh `MapStorage` as the default per test file.
- `npm run dev` — Netlify dev (port 8888).
- `npm run dev:cf` — `wrangler dev` (CF Workers + [assets] binding).
- `npm run deploy:cf` — `wrangler deploy` (builds lib first, then deploys the Worker + assets bundle).

## Cloudflare Deployment

CF Workers deployment uses `wrangler.toml` for config + `src/worker.ts` as the Worker entry. Static files in `public/` are served by Cloudflare's [assets binding](https://developers.cloudflare.com/workers/static-assets/).

### One-time setup

```bash
# 1. 创建生产 KV
npx wrangler kv namespace create VOCAL_SAGA_KV
# 2. 创建预览 KV（本地 dev 用）
npx wrangler kv namespace create VOCAL_SAGA_KV --preview
# 3. 把两个 id 写进 .dev.vars
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入 id 和本地所需 secret
# 4. 本地跑：npm run dev:cf
# 5. 首次部署：npm run deploy:cf
```

### CI / 持续部署

GitHub Actions 之类的 CI 上，把以下变量写到 secret（与 `.dev.vars` 字段一致）：

- `CLOUDFLARE_API_TOKEN`（Account → Workers Scripts:Edit 权限）
- `CLOUDFLARE_ACCOUNT_ID`
- `VOCAL_SAGA_KV_ID`（生产 KV id）
- `VOCAL_SAGA_KV_PREVIEW_ID`（预览 KV id）
- `DEEPSEEK_API_KEY`、`NVIDIA_API_KEY`、`OPENROUTER_API_KEY`、`AUTH_KEY`

CF Dashboard 也要为生产环境配同样 secret（`wrangler secret put NAME` 一次性设）：

```bash
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put AUTH_KEY
# ...
```

KV id 是 config 不是 secret，可以走 env-var 注入（`wrangler.toml` 里写 `$VOCAL_SAGA_KV_ID`，CI 设置同名 env var）。

### URL 路由规则

| Path                 | 流向                                                                |
|----------------------|---------------------------------------------------------------------|
| `/api/*`             | `src/worker.ts` → Hono                                              |
| `/`, `/translate`    | `[assets] binding` → `public/index.html` / `public/translate.html`  |
| `/translate.html`    | `[assets]` 自动 307 → `/translate`（CF 默认剥 `.html` 扩展名）       |
| `/*`（其他）         | `[assets]`，命中文件就发，否则 404                                  |
