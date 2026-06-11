# AGENTS.md

## Project Architecture

An OpenAI-compatible LLM proxy + translation API, deployable on **Netlify Functions** or **Cloudflare Pages**. The Express app is platform-agnostic; each platform provides a thin shim entry that wires up a platform-specific storage backend.

```
/
├── lib/                            # Platform-agnostic source (compiled to lib/dist/)
│   ├── app.ts                      # createApp() factory — Express app + routes
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
│       └── api.mjs                 # Netlify shim → serverless-http(createApp(NetlifyBlobsStorage))
├── functions/                      # Cloudflare Pages Functions
│   └── api/
│       └── [[path]].ts             # CF Pages onRequest → Node bridge → createApp(CloudflareKVStorage)
├── public/                         # Static assets (publish dir for both platforms)
├── wrangler.toml                   # Cloudflare Pages + KV binding
├── netlify.toml                    # Netlify build config (esbuild bundler)
└── package.json
```

## Key Decisions

- **Platform-agnostic core** — `lib/app.ts` exports `createApp(storage?: StorageAdapter)`. The Express app knows nothing about Netlify or Cloudflare.
- **Storage abstraction** — `StorageAdapter` interface (`get/set/getJSON/setJSON/delete/list`). Three implementations: `NetlifyBlobsStorage`, `CloudflareKVStorage`, `MapStorage`. A single default storage is set at startup; `getDefaultStorage()` retrieves it. Module-level modules (glossary store, cache manager) call `getDefaultStorage()` — no platform binding.
- **Key namespacing** — multiple modules share one storage instance via prefixes (`glossary:user_terms`, `cache:analysis:`, etc.). No need to configure multiple KV bindings or Netlify stores.
- **Platform shims are tiny**:
  - Netlify: `import { createApp, NetlifyBlobsStorage } from '../../lib/dist/index.js'; export const handler = serverless(app)`
  - Cloudflare: a ~80-line Node req/res bridge inside `functions/api/[[path]].ts` adapts Fetch `Request`/`Response` to Express.
- **Netlify**: `serverless-http` wraps Express as a Lambda handler; `esbuild` bundles `lib/dist/` (via `included_files`); `express` is the only external module.
- **Cloudflare**: `wrangler pages dev ./public` serves static + Pages Functions. Requires a KV namespace `VOCAL_SAGA_KV` (binding defined in `wrangler.toml`).
- **`type: "module"`** in `package.json` — Netlify shim is `.mjs`; Cloudflare function is `.ts` (esbuild-compiled at deploy time by Wrangler).

## Coding Conventions

- Add new routes in `lib/app.ts` using standard Express syntax. Keep middleware registration before route definitions. Always respond with `res.json()` for API routes.
- For persistent state, use `getDefaultStorage().getJSON/setJSON(...)` with a module-specific key prefix — never call platform-specific SDKs from `lib/`.
- New platform? Add a new `lib/storage/<platform>.ts` adapter and a new shim in the platform's entry location. No changes needed in `lib/app.ts` or `lib/translate/`.
- Use `Netlify.env.get('VAR')` only inside the Netlify shim. The Express app reads `process.env` as usual — Netlify Functions populate it at cold start.
- For Cloudflare, the `Env` type in the shim is the source of truth for bindings (`KVNamespace` etc.). Pass them into storage adapters; the app stays binding-free.

## Test / Build

- `npm run build:lib` — compile `lib/` to `lib/dist/`.
- `npm run typecheck` — type-check `lib/`, `netlify/functions/`, and `functions/` (the latter is the CF shim).
- `npm test` — Vitest; `tests/setup.ts` injects a fresh `MapStorage` as the default per test file.
- `npm run dev` — Netlify dev (port 8888).
- `npm run dev:cf` — `wrangler pages dev ./public` (CF Pages Functions).
