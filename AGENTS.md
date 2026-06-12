# AGENTS.md

原则1：重要的功能添加修改，必须要有相应的测试用例。

原则2：没有用的功能直接删掉，不要做fallback design。

原则3：添加足够的中文代码注释。

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
- **lazy `import('linkedom')`** 静态导入 — `urlFetcher.ts` 用 linkedom 解析 HTML，**所有平台都用**。原本是 jsdom 动态导入，但 jsdom 拉进旧版 undici，里面引用 `MessagePort` 全局，Cloudflare Workers 没这个全局就 500。linkedom 是纯 JS DOM，CF / Netlify / Node 都能跑，零依赖成本。
- **跨平台 DOM 判别**：walker / rules / pipeline 里**全部用 `nodeType === N` 而非 `instanceof Text/Element`**。vitest 单测用 jsdom、CF 跑用 linkedom，两个 DOM 实现的 Text/Element 是不同 class，`instanceof` 判别会全错；`nodeType` 是 W3C 标准 int，跨实现一致。
- **Platform shims are tiny**:
  - Netlify: `import { handle } from 'hono/aws-lambda'; import { createApp, NetlifyBlobsStorage } from '../../lib/dist/index.js'; export const handler = handle(createApp(new NetlifyBlobsStorage('main')))`
  - Cloudflare Workers: `src/worker.ts` exports `default { fetch(request, env) { if (url.pathname.startsWith('/api/')) return getApp(env).fetch(request, env); return env.ASSETS.fetch(request) } }`
- **Netlify**: `esbuild` bundles `lib/dist/` (via `included_files`). No `external_node_modules` needed — Hono is pure ESM/JS, no Node built-ins.
- **Cloudflare**: `wrangler dev` / `wrangler deploy` for Workers. KV binding via `[[kv_namespaces]]`; static assets via `[assets] directory = "./public" binding = "ASSETS"`. Path-matched files (`/index.html`, `/translate.html`) are served by Cloudflare edge without invoking the Worker; unmatched paths fall through to `env.ASSETS.fetch(request)`. Cloudflare auto-strips the `.html` extension: `/translate` and `/translate.html` are equivalent (the latter 307-redirects to the former). `nodejs_compat` flag required for `process.env` mutation in the shim and undici compat.
- **Streaming** — the chat completions endpoint passes the upstream `ReadableStream` directly to `new Response(body, headers)`. No buffering, no transformation.
- **`type: "module"`** in `package.json` — Netlify shim is `.mjs`; Cloudflare function is `.ts` (esbuild-compiled at deploy time by Wrangler).

## Coding Conventions

- Add new routes in `lib/app.ts` using Hono syntax (`app.get/post/put/delete`). Always respond with `c.json(...)` or `return new Response(...)` for streams. Use `c.req.json()` for body, `c.req.query()` for query, `c.req.param()` for path params, `c.req.header()` for headers.
- **Auth via middleware**：需要鉴权的路由统一挂 `requireAuth`（来自 `lib/auth.ts`），不要在 handler 里再写 `if (!checkAuth(c))`。新加鉴权策略（admin / rate limit / IP allowlist）就在 `lib/auth.ts` 里再加 `factory.createMiddleware(...)`，路由挂上即可。
- For persistent state, use `getDefaultStorage().getJSON/setJSON(...)` with a module-specific key prefix — never call platform-specific SDKs from `lib/`.
- New platform? Add a new `lib/storage/<platform>.ts` adapter and a new shim in the platform's entry location. No changes needed in `lib/app.ts` or `lib/translate/`.
- For Cloudflare, the `Env` type in the shim is the source of truth for bindings (`KVNamespace` etc.). Pass them into storage adapters; the app stays binding-free.
- **Don't write "controllers"**：直接在 `app.get('/path', handler)` 里写 handler，不要先 `const handler = (c) => {...}` 再 `app.get('/path', handler)`。这样 path param 的类型才能被 Hono 推断。真的要拆函数，用 `factory.createHandlers(mw, handler)`。

## Testing Convention — **main functionality must ship with tests**

This is a hard rule. **No new feature / route / module merges without accompanying tests** in `tests/`. 任何对"主要功能"的代码改动（路由处理、storage 适配、cache / glossary 业务逻辑、URL / DOM 抓取、双语展示、prompt 构造等）都必须在同一个 PR 里带可跑的 vitest 用例。

适用范围（不完整清单）：
- 新增的 Hono 路由（`lib/app.ts`）：auth 失败、query / body 校验、错误分支、success path 都要测。外部依赖（DeepSeek / fetch）用 `vi.mock` 隔离。
- 新增的 storage 适配 / 默认注册表（`lib/storage/*`）：基本 CRUD、错误处理、跨实例共享 / 隔离。
- 新增的 util / pipeline 阶段：边界值、异常路径、cache 命中 / miss。
- 从 `fanyi-extension` 移植的核心逻辑（blockExtractor、chunkBuilder、cacheManager、glossaryExtractor、translationDisplay 等）：单测必须能直接复用参考 fanyi-extension 的 `__tests__` 用例。
- `urlFetcher.fetchPage` 这类 I/O 模块：用本地 `http` 服务器起一个 stub，验证超时 / 重定向 / 错误码。

不强制写单测的：
- 纯类型 / 声明文件（`.d.ts`）。
- 平台 shim 入口（`netlify/functions/api.mjs`、`src/worker.ts`）——部署路径靠集成测试。
- 真调外部 LLM 的整链路 —— 那是 smoke / e2e 范畴。

参考来源：
- 本仓库 `tests/`（vitest，环境 jsdom，`tests/setup.ts` 注入 `MapStorage`）。**walker / rules / pipeline 的 DOM 判别用 `nodeType`**，所以这些单测用 jsdom 跑也覆盖生产 linkedom 路径。
- `tests/translateUrlEndToEnd.test.ts` 是唯一一个真打通整条链路的 E2E：起本地 HTTP server → linkedom 解析 → walker 抽块 → mock DeepSeek → 序列化双语 HTML，专门覆盖 CF 实际生产路径。
- `/Users/saga/code-repos/fanyi-extension/src/__tests__/`：移植过来的代码对应的原始测试，可以直接抄结构（vi.mock 模式、`beforeEach` 清空 store、chunks 边界用例等）。

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
# 1. KV namespace id 已硬编码在 wrangler.toml，无需单独创建
#    （要换 namespace 时再跑 wrangler kv namespace create VOCAL_SAGA_KV）
# 2. 把本地 secret 写进 .dev.vars
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入上游 API key 和 AUTH_KEY
# 3. 本地跑：npm run dev:cf  （wrangler 自动用 miniflare 模拟 KV）
# 4. 首次部署：npm run deploy:cf
```

### Observability

`wrangler.toml` 顶部已开 `[observability]`：

- `logs.enabled = true` — 所有 `console.log` / `console.error` 走 **Workers Logs**
  （默认只走 tail，开启后才进 CF Dashboard 的 Logs 页）
- `logs.invocation_logs = true` — 每次 request 一行汇总（status / duration / region / event）
- `[observability.traces]` 留空 = 默认 head-based 采样（~10%）

查看位置：CF Dashboard → Workers & Pages → vocal-saga → **Logs** / **Traces** tab。
`wrangler dev` 本地不受影响（dev mode 总是 tail 到本地终端）。

### CI / 持续部署

GitHub Actions 之类的 CI 上，把以下 secret 注入：

- `CLOUDFLARE_API_TOKEN`（Account → Workers Scripts:Edit 权限）
- `CLOUDFLARE_ACCOUNT_ID`
- `DEEPSEEK_API_KEY`、`NVIDIA_API_KEY`、`OPENROUTER_API_KEY`、`AUTH_KEY`

CF Dashboard 也要为生产环境配同样 secret（`wrangler secret put NAME` 一次性设）：

```bash
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put AUTH_KEY
# ...
```

### URL 路由规则

| Path                          | 流向                                                                |
|-------------------------------|---------------------------------------------------------------------|
| `/api/*`                      | `src/worker.ts` → Hono（需 `Authorization: Bearer`）               |
| `/translate/<target-no-scheme>` | `src/worker.ts` → Hono（公开；抓取 + 翻译 + 双语 HTML）           |
| `/`, `/translate`             | `[assets] binding` → `public/index.html` / `public/translate.html`  |
| `/translate.html`             | `[assets]` 自动 307 → `/translate`（CF 默认剥 `.html` 扩展名）       |
| `/*`（其他）                  | `[assets]`，命中文件就发，否则 404                                  |

> `/translate/<target-no-scheme>`：target 是去掉 `https://` 后的 URL 剩余部分
> （如 `example.com/foo`）。浏览器地址栏直接拼就能用，不需要 auth header。
> server 剥 scheme（如果用户传了）后补回 `https://` 再抓取。
