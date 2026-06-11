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
- **Platform shims are tiny**:
  - Netlify: `import { handle } from 'hono/aws-lambda'; import { createApp, NetlifyBlobsStorage } from '../../lib/dist/index.js'; export const handler = handle(createApp(new NetlifyBlobsStorage('main')))`
  - Cloudflare: `export const onRequest: PagesFunction<Env> = ({ request, env }) => getApp(env).fetch(request, env)`
- **Netlify**: `esbuild` bundles `lib/dist/` (via `included_files`). No `external_node_modules` needed — Hono is pure ESM/JS, no Node built-ins.
- **Cloudflare**: `wrangler pages dev ./public` serves static + Pages Functions. Requires a KV namespace `VOCAL_SAGA_KV` (binding defined in `wrangler.toml`). Hono's `app.fetch(request, env)` is the standard CF pattern.
- **Streaming** — the chat completions endpoint passes the upstream `ReadableStream` directly to `new Response(body, headers)`. No buffering, no transformation.
- **`type: "module"`** in `package.json` — Netlify shim is `.mjs`; Cloudflare function is `.ts` (esbuild-compiled at deploy time by Wrangler).

## Coding Conventions

- Add new routes in `lib/app.ts` using Hono syntax (`app.get/post/put/delete`). Always respond with `c.json(...)` or `return new Response(...)` for streams. Use `c.req.json()` for body, `c.req.query()` for query, `c.req.param()` for path params, `c.req.header()` for headers.
- For persistent state, use `getDefaultStorage().getJSON/setJSON(...)` with a module-specific key prefix — never call platform-specific SDKs from `lib/`.
- New platform? Add a new `lib/storage/<platform>.ts` adapter and a new shim in the platform's entry location. No changes needed in `lib/app.ts` or `lib/translate/`.
- For Cloudflare, the `Env` type in the shim is the source of truth for bindings (`KVNamespace` etc.). Pass them into storage adapters; the app stays binding-free.

## Test / Build

- `npm run build:lib` — compile `lib/` to `lib/dist/`.
- `npm run typecheck` — type-check `lib/`, `netlify/functions/`, and `functions/` (the latter is the CF shim).
- `npm test` — Vitest; `tests/setup.ts` injects a fresh `MapStorage` as the default per test file.
- `npm run dev` — Netlify dev (port 8888).
- `npm run dev:cf` — `wrangler pages dev ./public` (CF Pages Functions).
