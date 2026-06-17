# AGENTS.md

原则1：重要的功能添加修改，必须要有相应的测试用例。

原则2：没有用的功能直接删掉，不要做fallback design。

原则3：添加足够的中文代码注释。

原则4：如果script调用无法联通，使用proxy.sh的proxy设置。

## Project Architecture

OpenAI-compatible LLM proxy + translation API，部署在 **Cloudflare Workers**。基于 **Hono**（edge-first，无 Node-only 依赖）。

```
/
├── lib/                            # 平台无关源码（编译到 lib/dist/）
│   ├── app.ts                      # createApp() 工厂 — Hono app + 路由
│   ├── index.ts                    # 公共入口：createApp + storage adapters
│   ├── urlUtils.ts                 # URL 标准化工具
│   ├── modelResolver.ts            # 模型解析 + 上游配置
│   ├── auth.ts                     # 鉴权中间件
│   ├── storage/                    # StorageAdapter 抽象
│   │   ├── types.ts                #   interface StorageAdapter
│   │   ├── cloudflare.ts           #   Cloudflare KV adapter
│   │   ├── memory.ts               #   MapStorage (tests / local dev)
│   │   └── index.ts                #   setDefaultStorage / getDefaultStorage
│   └── translate/                  # LLM + 翻译业务逻辑
│       ├── pipeline.ts             # 翻译主流程（全并行）
│       ├── contentHelper.ts        # 文章容器识别（Layer 1/2/3）
│       ├── contentDetector.ts      # 智能评分（Layer 2 兜底）
│       ├── blockExtractor/         # DOM 文本提取
│       ├── chunkBuilder.ts         # 分块（TARGET_TOKENS=1000）
│       ├── cacheManager.ts         # 缓存管理
│       ├── service/                # LLM API 调用
│       │   ├── deepseek.ts         #   DeepSeek
│       │   ├── openrouter.ts       #   OpenRouter
│       │   └── nvidia.ts           #   NVIDIA (kimi-k2.6 / deepseek-v4-flash / qwen3-next-80b-a3b-instruct)
│       └── rules/                  # 站点规则
├── src/
│   └── worker.ts                   # CF Workers 入口
├── tests/                          # Vitest 测试
├── wrangler.toml                   # CF Workers 配置
└── package.json
```

## Key Decisions

- **Hono** — CF Workers 原生运行，无 Node-only 依赖
- **Storage 抽象** — `StorageAdapter` 接口，CloudflareKV 实现
- **linkedom** — 纯 JS DOM，CF / Node 都能跑，替代 jsdom
- **nodeType 判别** — walker / rules 全部用 `nodeType === N` 而非 `instanceof`
- **全并行翻译** — Server 端 KV cache 不跨请求，chunk 直接 Promise.all
- **超时保护** — DeepSeek 45s / OpenRouter 60s / NVIDIA 60s
- **URL 标准化** — 无 `.` 域名补 `.com`，保留 www

## Routes

| Path | Auth | 说明 |
|------|------|------|
| `GET /api/hello` | ✗ | 健康检查 |
| `GET /api/v1/models` | ✗ | 模型列表 |
| `POST /api/v1/chat/completions` | ✓ | LLM 代理 |
| `GET /api/v1/translate/text` | ✗ | 文本翻译 |
| `POST /fanyi/page` | ✗ | 浏览器扩展：接收预标记 HTML，返回翻译后的双语 HTML |
| `GET /translate/<url>` | ✗ | 翻译页面（浏览器直访） |
| `GET /force/<url>` | ✗ | 强制重新翻译（跳过 D1 缓存） |
| `GET /openrt/<url>` | ✗ | OpenRouter 免费模型翻译 |
| `GET /nvd/<url>` | ✗ | NVIDIA kimi-k2.6 翻译 |
| `GET /nvd/deepseek/<url>` | ✗ | NVIDIA deepseek-v4-flash 翻译 |
| `GET /nvd/qwen/<url>` | ✗ | NVIDIA qwen3-next-80b-a3b-instruct 翻译 |
| `GET /original/<url>` | ✗ | 原始页面（不翻译） |
| `GET /o/<url>` | ✗ | /original 别名 |
| `GET /s/<domain>/<path>` | ✗ | 简写域名翻译 |
| `GET /` | ✗ | 最新翻译结果 |
| `GET /<id>` | ✗ | D1 历史翻译 |

## Translation Pipeline

```
fetchPage (linkedom)
  ↓
contentHelper (Layer 1: 选择器 → Layer 2: 评分 → Layer 3: body)
  ↓
blockExtractor (DFS 提取 TextBlock)
  ↓
chunkBuilder (TARGET_TOKENS=1000)
  ↓
Promise.all (全并行翻译)
  ↓
applyBlockTranslation (回填 HTML)
```

**性能数据**（生产日志）：
- parseHTML: 5~35ms
- prepareDoc: 11~86ms
- translateChunks: 99% 时间（LLM API 响应）
- CPU total: 26~59ms

## Services

| Service | API | 模型 | 超时 |
|---------|-----|------|------|
| DeepSeek | api.deepseek.com | deepseek-v4-flash | 45s |
| OpenRouter | openrouter.ai | openrouter/free | 60s |
| NVIDIA | integrate.api.nvidia.com | kimi-k2.6 / deepseek-v4-flash / qwen3-next-80b-a3b-instruct | 60s |

## Site Rules

`lib/translate/rules/` 包含站点特定规则：
- `github-rules.ts` — GitHub
- `reddit-rules.ts` — Reddit
- `hackernews-rules.ts` — Hacker News
- `fortune-rules.ts` — Fortune
- `arxiv-rules.ts` — arXiv（跳过 References/Authors）

## Testing

```bash
npm test              # Vitest
npm run build:lib     # 编译 lib/
npm run typecheck     # 类型检查
npm run dev:cf        # 本地开发（wrangler dev）
npm run deploy:cf     # 部署到 CF Workers
```

## Cloudflare Deployment

```bash
# Secrets
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put NVIDIA_API_KEY
wrangler secret put AUTH_KEY

# 部署
npm run deploy:cf
```

## URL 标准化

- 无 `.` 域名补 `.com`：`towardsdatascience` → `towardsdatascience.com`
- 保留 `www.`：`www.example.com` ≠ `example.com`（暂时视为不同）
- 剥离 scheme：`https://example.com` → `example.com`
