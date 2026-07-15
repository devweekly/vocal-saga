# vocal-saga 架构文档

OpenAI-compatible LLM proxy + 网页翻译 API，部署在 Cloudflare Workers，基于 Hono 框架（edge-first，无 Node-only 依赖）。

## 目录

- [项目概览](#项目概览)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [部署架构](#部署架构)
- [请求处理流程](#请求处理流程)
- [核心模块](#核心模块)
  - [Hono 应用工厂与路由](#hono-应用工厂与路由)
  - [翻译 Pipeline](#翻译-pipeline)
  - [内容抽取 Extraction](#内容抽取-extraction)
  - [Block 提取 blockExtractor](#block-提取-blockextractor)
  - [Chunk 构建](#chunk-构建)
  - [翻译服务 Services](#翻译服务-services)
  - [站点规则 Site Rules](#站点规则-site-rules)
  - [翻译显示](#翻译显示)
  - [缓存管理](#缓存管理)
  - [存储抽象](#存储抽象)
  - [鉴权](#鉴权)
  - [URL 标准化](#url-标准化)
  - [模型解析](#模型解析)
- [配置管理](#配置管理)
- [测试体系](#测试体系)
- [关键设计决策](#关键设计决策)

---

## 项目概览

vocal-saga 是一个运行在 Cloudflare Workers 上的翻译代理服务，提供两类核心能力：

1. **OpenAI 兼容的 LLM 代理**：将请求转发到 DeepSeek / NVIDIA / OpenRouter / Cloudflare AI 等后端，统一鉴权和模型路由。
2. **网页翻译**：抓取目标 URL → 抽取正文 → 分块翻译 → 双语对照回填 HTML，支持浏览器直访和浏览器扩展两种入口。

支持 6 种翻译服务提供方：DeepSeek、OpenRouter、NVIDIA、Cloudflare AI、Gemini、OpenCode、MiMo，并提供 4 种翻译文风（default / jinyong / acheng / wangxiaobo）。

## 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| HTTP 框架 | Hono | Cloudflare Workers 原生运行，零 Node 依赖 |
| DOM 解析 | linkedom | 纯 JS DOM，Workers / Node 都能跑，替代 jsdom |
| Readability | @mozilla/readability | 文章正文抽取兜底策略 |
| 存储 | Cloudflare KV / D1 / Netlify Blobs | 跨平台 StorageAdapter 抽象 |
| 部署 | Cloudflare Workers | wrangler.toml 配置 |
| 测试 | Vitest | 1000+ 测试用例 |
| LLM SDK | @google/genai | Gemini 原生 API |

## 目录结构

```
/
├── lib/                            # 平台无关源码（编译到 lib/dist/）
│   ├── app.ts                      # createApp() 工厂 — Hono app + 路由
│   ├── index.ts                    # 公共入口：createApp + storage adapters
│   ├── urlUtils.ts                 # URL 标准化工具
│   ├── modelResolver.ts            # 模型解析 + 上游配置
│   ├── auth.ts                     # 鉴权中间件（requireAuth）
│   ├── config.ts                   # API key 管理（getter/setter）
│   ├── redirectGuard.ts            # 重定向守卫（fetch/XHR + Navigation API）
│   ├── spaGuard.ts                 # SPA 脚本清理（导航 + hydration）
│   ├── devirtualize.ts             # 虚拟定位清理（X/Twitter 等 SPA）
│   ├── storage/                    # StorageAdapter 抽象
│   │   ├── types.ts                #   interface StorageAdapter
│   │   ├── cloudflare.ts           #   Cloudflare KV adapter
│   │   ├── memory.ts               #   MapStorage (tests / local dev)
│   │   └── index.ts                #   setDefaultStorage / getDefaultStorage
│   └── translate/                  # LLM + 翻译业务逻辑
│       ├── pipeline.ts             # 翻译主流程（全并行）
│       ├── contentHelper.ts        # 文章容器识别 + block 提取入口
│       ├── contentDetector.ts      # 智能评分（density provider 兜底）
│       ├── urlFetcher.ts           # linkedom 抓取 + Client Hints
│       ├── chunkBuilder.ts         # 分块（TARGET_TOKENS=10000）
│       ├── chunkRetry.ts           # 缺失 block 检测 + 重试
│       ├── cacheManager.ts         # 内存缓存 + 持久层
│       ├── cacheKey.ts             # 翻译缓存 key 生成
│       ├── translateApi.ts         # 翻译结果解析 + unchanged 检测
│       ├── translationDisplay.ts   # 双语对照 DOM 回填
│       ├── glossaryStore.ts        # 术语表存储
│       ├── glossaryExtractor.ts    # 术语提取
│       ├── blockExtractor/         # DOM 文本提取
│       │   ├── walker.ts           #   手写递归 walker
│       │   ├── rules.ts            #   acceptNode 规则
│       │   ├── constants.ts        #   DIRECT_SET / SKIP_SET / 阈值
│       │   └── types.ts            #   TextBlock / ArticleContext
│       ├── extraction/             # 多策略文章根选择
│       │   ├── pipeline.ts         #   selectBestRoot / findBestArticleRoot
│       │   ├── scoring.ts          #   统一质量评分器
│       │   ├── types.ts            #   ArticleCandidate / CandidateProvider
│       │   └── providers/          #   候选生成器
│       │       ├── selector.ts     #     CSS 选择器策略
│       │       ├── density.ts      #     密度评分策略
│       │       ├── readability.ts  #     Mozilla Readability 策略
│       │       └── siteRule.ts     #     站点规则策略
│       ├── service/                # LLM API 调用
│       │   ├── _service.ts         #   TranslationService 接口
│       │   ├── shared.ts           #   共享工具（prompt / JSON 修复）
│       │   ├── deepseek.ts         #   DeepSeek
│       │   ├── openrouter.ts       #   OpenRouter
│       │   ├── nvidia.ts           #   NVIDIA (kimi-k2.6 / deepseek-v4-flash / qwen3)
│       │   ├── cloudflare.ts       #   Cloudflare Workers AI
│       │   ├── gemini.ts           #   Google Gemini 原生 API
│       │   ├── opencode.ts         #   OpenCode.ai
│       │   ├── mimo.ts             #   MiMo Auto
│       │   ├── jinyong-prompt.ts   #   金庸武侠文风 prompt
│       │   ├── acheng-prompt.ts    #   阿城白描文风 prompt
│       │   └── wangxiaobo-prompt.ts #  王小波大白话文风 prompt
│       └── rules/                   # 站点规则
│           ├── types.ts             #   SiteRule 接口
│           ├── index.ts             #   规则入口
│           ├── github-rules.ts      #   GitHub
│           ├── reddit-rules.ts      #   Reddit
│           ├── hackernews-rules.ts  #   Hacker News
│           ├── fortune-rules.ts     #   Fortune
│           └── arxiv-rules.ts       #   arXiv
├── src/
│   └── worker.ts                   # CF Workers 入口（injectEnv + getApp）
├── tests/                          # Vitest 测试（1000+ 用例）
├── public/                         # 静态资源（CF Workers assets）
├── wrangler.toml                   # CF Workers 配置
├── package.json                    # name=translation-api, version=0.4.6
└── AGENTS.md                       # 项目原则与架构说明
```

## 部署架构

```
┌──────────────────────────────────────────────────────────┐
│                  Cloudflare Workers                      │
│                                                          │
│  ┌────────────┐    ┌────────────┐    ┌──────────────┐   │
│  │ Hono App   │───▶│ Translation │───▶│ LLM Upstream │   │
│  │ (lib/app)  │    │ Pipeline   │    │ (DeepSeek...)│   │
│  └────────────┘    └────────────┘    └──────────────┘   │
│         │                │                               │
│         │                ▼                               │
│         │         ┌────────────┐                         │
│         │         │ linkedom   │                         │
│         │         │ (DOM 解析) │                         │
│         │         └────────────┘                         │
│         │                                                │
│         ▼                                                │
│  ┌─────────────────────────────────────┐                 │
│  │ Bindings                            │                 │
│  │  • DB999 (D1 SQLite) — 翻译历史      │                 │
│  │  • VOCAL_SAGA_KV (KV) — 术语表缓存   │                 │
│  │  • ASSETS — 静态资源                  │                 │
│  │  • Secrets — API keys               │                 │
│  └─────────────────────────────────────┘                 │
└──────────────────────────────────────────────────────────┘
```

**Workers 入口** ([src/worker.ts](file:///Users/saga/code-repos/vocal-saga/src/worker.ts))：

```typescript
export default {
  async fetch(request, env): Promise<Response> {
    injectEnv(env);
    const app = getApp(env);
    const res = await app.fetch(request, env);
    if (res.status === 404 && env.ASSETS) return env.ASSETS.fetch(request);
    return res;
  }
}
```

- `injectEnv(env)` 把 CF bindings 注入模块级变量
- `getApp(env)` 懒加载 createApp 实例
- 404 时 fallback 到静态资源（`env.ASSETS`）

## 请求处理流程

### 翻译 URL 流程（`GET /translate/<url>`）

```
HTTP 请求
  ↓
Hono 路由匹配 → handleTranslateRequest
  ↓
URL 标准化 + 校验（必须 https）
  ↓
D1 缓存查询（url + source + target）
  ├─ 命中且健康 → 直接返回缓存 HTML
  └─ 未命中 → 继续翻译
  ↓
translateUrl()
  ├─ fetchPage (linkedom 解析 HTML)
  └─ runTranslationPipeline
      ├─ prepareDocument (extraction + block 提取)
      ├─ translateChunksWithRetry (全并行 LLM 调用)
      └─ applyBlockTranslation (双语回填 DOM)
  ↓
processTranslationHtml (导航清理 + 去虚拟化 + 注入守卫)
  ↓
D1 写入（UPSERT）
  ↓
HTTP 响应
```

### 浏览器扩展流程（`POST /fanyi/page`）

扩展在真实浏览器中拿到 HTML（绕过反爬），传给服务端：

```
扩展 → POST /fanyi/page { html, url, provider, apiKey }
  ↓
D1 缓存查询
  ├─ 命中 → 返回缓存
  └─ 未命中 → translateHtml()
      ├─ 检测 data-fanyi-block-id 标记
      ├─ 若已标记 → extractBlocksFromMarkedHtml (复用扩展端 walker 结果)
      └─ runTranslationPipeline
  ↓
D1 写入 + 响应
```

## 核心模块

### Hono 应用工厂与路由

入口 [lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts) 的 `createApp(storage?)` 工厂：

- 启动时从 `process.env` 读取所有 API key 注入 config 模块
- 全局启用 CORS
- 注册所有路由

**路由表**：

| Path | Auth | 说明 |
|------|------|------|
| `GET /` | ✗ | 翻译记录列表首页（第 1 页） |
| `GET /page/:page` | ✗ | 分页列表（必须在 `/:id` 前注册） |
| `GET /article/:id` | ✗ | D1 历史翻译展示 |
| `POST /api/v1/chat/completions` | ✓ | LLM 代理（透传到上游） |
| `GET /fanyi/page/check` | ✗ | 扩展端缓存查询（命中返回 HTML，未命中 204） |
| `POST /fanyi/page` | ✗ | 扩展端：接收预标记 HTML，返回双语 HTML |
| `GET /api/v1/models` | ✗ | 模型列表 |
| `GET /api/hello` | ✗ | 健康检查 |
| `POST /api/translate/text` | ✗ | 纯文本翻译 |
| `GET /s/<domain>/<path>` | ✗ | 简写域名翻译（单单词补 `www.<word>.com`） |
| `GET /translate/<url>` | ✗ | 浏览器直访翻译入口 |
| `GET /force/*` | ✗ | 强制重新翻译（每 IP 45s 限流 1 次） |
| `GET /openrt/*` | ✗ | OpenRouter 免费模型翻译 |
| `GET /nvd/*` | ✗ | NVIDIA 翻译（默认 step-3.7-flash，可选 deepseek/qwen） |
| `GET /mimo/*` | ✗ | MiMo 翻译 |
| `GET /gemini/*` | ✗ | Gemini 翻译（gemini-3.1-flash-lite） |
| `GET /oc/*` | ✗ | OpenCode 翻译 |
| `GET /cf/*` | ✗ | Cloudflare AI 翻译 |
| `GET /original/*` | ✗ | 原始页面（注入 `<base>` + 导航清理） |
| `GET /o/*` | ✗ | `/original` 别名 |
| `GET/POST/DELETE /api/glossary` | 部分 | 术语表管理 |
| `POST /api/glossary/extract` | ✗ | 术语提取 |
| `PUT/DELETE /api/glossary/document` | 部分 | 文档术语管理 |

**HTML 后处理 pipeline**：

- `processTranslationHtml`：`stripDangerousScripts` → `devirtualizeLayout` → `injectRedirectGuard`
- `processOriginalHtml`：`stripNavigationScripts` → `injectRedirectGuard`

**缓存健康检查 `isHealthyCachedHtml`**：
- 必须有 `<html>` 标签
- 必须有外联 stylesheet，或非 OneTrust/fanyi 的内联 style

### 翻译 Pipeline

[lib/translate/pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/pipeline.ts) 提供三个对外入口：

1. **`translateText`**：纯文本批量翻译（不抽 DOM），单 block + chunkBuilder 分块
2. **`translateUrl`**：URL → fetchPage → runTranslationPipeline
3. **`translateHtml`**：扩展端 HTML → 检测预标记 → runTranslationPipeline

**核心函数 `runTranslationPipeline`**：

```
prepareDocument (extraction + block 提取)
  ↓
根据 provider 动态 import 对应 Service
  ↓
translateChunksWithRetry (全并行 + 缺失重试)
  ↓
回填 DOM (applyBlockTranslation / applyInlineTranslation)
  ↓
注入 <base> + 双语 CSS
  ↓
序列化 outerHTML
```

**并发度策略**：
- `deepseek`：concurrency=4
- `opencode` / `openrouter`：concurrency=1（限流严格）
- 其他：concurrency=2

**chunk 内重试**：
- `diffMissingIds` 检测缺失 block
- `shouldRetryMissing` 判断是否需要重试（缺失比例 + 非重试 chunk）
- `buildRetryChunk` 构建只含缺失 block 的新 chunk

### 内容抽取 Extraction

[lib/translate/extraction/](file:///Users/saga/code-repos/vocal-saga/lib/translate/extraction/) 采用**多策略候选 + 统一评分**架构：

```
4 个 CandidateProvider 并行产生候选
  ├─ SiteRuleProvider (priority 100) — 站点规则 articleRootSelector
  ├─ SelectorProvider (priority 60) — CSS 选择器定位
  ├─ DensityProvider (priority 50) — contentDetector 评分
  └─ ReadabilityProvider (priority 70) — Mozilla Readability
  ↓
ArticleQualityScorer 统一评分
  ↓
rankCandidates 按 confidence 降序排序
  ↓
findBestArticleRoot 返回最高分候选
（confidence < 0.5 时仍返回，由上层根据 blocks 数量做 fallback）
```

**关键接口**（[extraction/types.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/extraction/types.ts)）：

```typescript
interface ArticleCandidate {
  provider: string;
  root: Element;
  title?: string;
  textLength: number;
  blockCount?: number;
  providerScore?: number;
  confidence: number;
  metadata?: ArticleMetadata;
}

interface CandidateProvider {
  readonly name: string;
  provide(doc: Document, context?: CandidateProviderContext): ArticleCandidate | null;
}

interface ArticleQualityScorer {
  score(candidate: ArticleCandidate, doc: Document): number;
}
```

**评分维度**（[scoring.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/extraction/scoring.ts)）：
- `textDensity`：文本密度
- `linkDensity`：链接密度（越低越好）
- `boilerplateRatio`：样板内容比例
- 结构信号：h1/h2/p 数量
- 输出 0-1 置信度

**SelectorProvider 关键点**（[providers/selector.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/extraction/providers/selector.ts)）：
- `SPECIFIC_SELECTORS` 包含 `.post__content` 等精确正文容器
- `expandWrappers` 对具体正文容器直接返回，不向上展开到外层 `<main>`

**ArticleContext 共享**：root detection 阶段的 `noiseSet`、`textCache`、`semanticHints` 通过 `contextOut` 传递给 block extraction，避免重复计算。

### Block 提取 blockExtractor

[lib/translate/blockExtractor/](file:///Users/saga/code-repos/vocal-saga/lib/translate/blockExtractor/) 手写递归 walker，替代 `TreeWalker`：

**核心常量**（[constants.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/blockExtractor/constants.ts)）：
- `MIN_TEXT_LENGTH = 3`
- `MAX_TEXT_LENGTH = 3072`
- `TARGET_TOKENS = 10000`（chunkBuilder）
- `DIRECT_SET`：h1-h6, p, li, dd, blockquote, figcaption（直接作为 block）
- `SKIP_SET`：script, style, noscript 等

**WalkCache**（[walker.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/blockExtractor/walker.ts)）字段：
- `rejected`：被拒绝的节点
- `directSetDescendant`：DIRECT_SET 后代
- `classify`：节点分类
- `validText`：有效文本
- `noiseMemo` / `knownNoise`：噪声记忆

**TextBlock 结构**：
```typescript
interface TextBlock {
  id: string;
  xpath: string;
  tag: string;
  text: string;
  renderHint?: { inlineCandidate?: boolean };
  context?: string;
}
```

**nodeType 判别**：walker / rules 全部用 `nodeType === N` 而非 `instanceof`，兼容 linkedom/jsdom/浏览器。

### Chunk 构建

[lib/translate/chunkBuilder.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/chunkBuilder.ts)：

**Token 估算**：
- CJK 字符：0.5 tokens/char
- Latin 字符：0.25 tokens/char
- `TARGET_TOKENS = 10000`

**切分策略**：支持 heading 边界切分（h1-h6 作为天然分块点）。

### 翻译服务 Services

[lib/translate/service/](file:///Users/saga/code-repos/vocal-saga/lib/translate/service/) 统一接口：

```typescript
interface TranslationService {
  translate(blocksJson, sourceLang, targetLang, glossary?): Promise<string>;
  translateStream?(...): AsyncGenerator<string>;
}
```

**服务列表**：

| Service | API | 默认模型 | 超时 | 并发 |
|---------|-----|---------|------|------|
| DeepSeek | api.deepseek.com | deepseek-v4-flash | 45s | 4 |
| OpenRouter | openrouter.ai | openrouter/free | 60s | 1 |
| NVIDIA | integrate.api.nvidia.com | step-3.7-flash / kimi-k2.6 / deepseek-v4-flash / qwen3 | 60s | 2 |
| Cloudflare AI | Workers AI REST | - | - | 2 |
| Gemini | Google 原生 API | gemini-3.1-flash-lite | - | 2 |
| OpenCode | opencode.ai/zen | big-pickle | - | 1 |
| MiMo | MiMo Auto | - | - | 2 |

**共享工具**（[shared.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/service/shared.ts)）：
- `estimateMaxTokens`：6x input token，上限 131072
- `repairJson`：包装 jsonrepair 库修复 LLM 偶发输出错误（截断/缺逗号/单引号等）
- `stripThinkingTags`：去除 `<think>...</think>` 标签
- `stripMarkdownCodeBlock`：去除 markdown 代码块包裹
- `cleanJsonString`：移除尾随逗号 + 修复 LLM 偶发"重复引号"模式（jsonrepair 修不对这个）
- `buildSystemContent`：根据 PromptStyle 选择 system prompt
- `buildTranslationBody`：构造请求体

**PromptStyle**：`'default' | 'jinyong' | 'acheng' | 'wangxiaobo'`

**Gemini 特殊处理**：
- 使用 `contents/parts` 结构 + `systemInstruction`
- SSE 解析处理 `candidates[0].content.parts[].text`
- `thinkingConfig: { thinkingBudget: 0 }` 禁用思考
- API key 随机选择 `getGeminiApiKey1()` / `getGeminiApiKey2()`

**OpenCode 特殊处理**：
- `User-Agent: vocal-saga/1.0` header
- 并发限制为 1

### 站点规则 Site Rules

[lib/translate/rules/](file:///Users/saga/code-repos/vocal-saga/lib/translate/rules/)：

```typescript
interface SiteRule {
  hostPattern: string;
  skipTerms?: string[];
  skipSelectors?: string[];
  skipTextPatterns?: string[];
  promptInstructions?: string;
  documentTerms?: string[];
  articleRootSelector?: string;
}
```

**已支持站点**：
- `github-rules.ts` — GitHub
- `reddit-rules.ts` — Reddit
- `hackernews-rules.ts` — Hacker News
- `fortune-rules.ts` — Fortune
- `arxiv-rules.ts` — arXiv（跳过 References/Authors）

`SiteRuleProvider` 优先级最高（priority 100），命中规则时直接返回。

### 翻译显示

[lib/translate/translationDisplay.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/translationDisplay.ts) 双语对照回填：

**Block 模式**（`applyBlockTranslation`）：
- 把原文子节点移入 `.fanyi-original` span（保留链接/格式）
- 追加 `.fanyi-translation` span
- 不破坏原 DOM 结构，可 restore

**Inline 模式**（`applyInlineTranslation`）：
- 短句列表项，译文 append 到最后一个文本承载元素
- 找 `findLastTextHost`：DFS 找包含直接 text node 的最深叶子
- 例如 `<li><a>text</a></li>` → 译文插入 `<a>` 内部

**Render 决策**（pipeline.ts）：
```
shouldInline = renderHint.inlineCandidate === true
  && translated.length <= 40
  && translated.split(/\s+/).length <= 12
```

**CSS 注入**（pipeline.ts）：
- `.fanyi-translation`：左侧边框 + margin
- `.fanyi-inline-translation`：opacity 0.75 + 缩小字号
- `[data-fanyi-low-priority="true"]`：弱化显示，hover 恢复
- `[data-fanyi-remove="true"]`：隐藏 Cookie Banner / Overlay

### 缓存管理

**两层缓存**：

1. **D1 持久缓存**（翻译历史）：
   - 表 `translations (id, url, title, source_lang, target_lang, html, created_at)`
   - UPSERT 写入：`ON CONFLICT(url, source_lang, target_lang) DO UPDATE`
   - `cacheKeyUrl` 标准化：www 和非 www 共享缓存
   - `isHealthyCachedHtml` 健康检查

2. **翻译 chunk 缓存**（[cacheManager.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/cacheManager.ts)）：
   - `CacheManager` 类：内存 Map + 持久层 StorageAdapter
   - `translationCache` 单例
   - 7 天 TTL
   - Server 端 KV cache 不跨请求

**翻译结果处理**（[translateApi.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/translateApi.ts)）：
- `processTranslationWithCheck`：一次 JSON.parse 完成结果提取 + unchanged 检测
- `logUnchangedBlocks`：检测 LLM 静默返回原文（拒译 / 命中过滤）
- 字段名宽松：`translated_text` / `text` / `translation` 都接受

### 存储抽象

[lib/storage/](file:///Users/saga/code-repos/vocal-saga/lib/storage/)：

```typescript
interface StorageAdapter {
  get(key: string): Promise<string | null>;
  getJSON<T>(key: string): Promise<T | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  setJSON<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}
```

**实现**：
- `CloudflareKVStorage` — Cloudflare KV
- `MapStorage` — 内存（tests / local dev）
- （Netlify Blobs 实现见 lib/index.ts）

`setDefaultStorage(storage)` 注入全局默认 adapter。

### 鉴权

[lib/auth.ts](file:///Users/saga/code-repos/vocal-saga/lib/auth.ts)：

```typescript
export const requireAuth = factory.createMiddleware(async (c, next) => {
  const expected = getAuthKey(c);  // c.env.AUTH_KEY || process.env.AUTH_KEY
  const bearer = c.req.header('authorization').replace(/^Bearer\s+/i, '');
  if (bearer !== expected) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});
```

- 使用 `hono/factory` 创建 middleware（类型安全）
- `AUTH_KEY` 必须至少 6 字符
- 仅 `/api/v1/chat/completions` 和 `DELETE /api/glossary/:term` / `DELETE /api/glossary/document` 要求鉴权
- 翻译路由故意不校验（浏览器直访场景，地址栏无法带 header）

### URL 标准化

[lib/urlUtils.ts](file:///Users/saga/code-repos/vocal-saga/lib/urlUtils.ts)：

- `normalizeUrl`：
  - 无 `.` 域名补 `.com`：`towardsdatascience` → `towardsdatascience.com`
  - 保留 `www.`：`www.example.com` ≠ `example.com`
  - 剥离 scheme：`https://example.com` → `example.com`
- `cacheKeyUrl`：用于 D1 缓存 key

### 模型解析

[lib/modelResolver.ts](file:///Users/saga/code-repos/vocal-saga/lib/modelResolver.ts)：

```typescript
resolveModel(model, backendHint) → { backend, model } | { error }
```

- 根据 model 名推断 backend（deepseek / cloudflare / nvidia / openrouter）
- 支持 `_backend` 字段强制指定
- `DS_MODELS`：DeepSeek 支持的模型列表

## 配置管理

### API Keys

通过 Cloudflare Secrets 配置：

```bash
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put NVIDIA_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put GEMINI_API_KEY_2
wrangler secret put OPENCODE_API_KEY
wrangler secret put AUTH_KEY
wrangler secret put CLOUDFLARE_API_TOKEN
```

[lib/config.ts](file:///Users/saga/code-repos/vocal-saga/lib/config.ts) 提供 getter/setter，模块级变量存储，`createApp` 启动时从 `process.env` 注入。

### wrangler.toml

```toml
name = "ss"
main = "src/worker.ts"

[[kv_namespaces]]
binding = "VOCAL_SAGA_KV"

[[d1_databases]]
binding = "DB999"
database_name = "vocal-saga"

[assets]
directory = "./public"

[vars]
CLOUDFLARE_ACCOUNT_ID = "..."
```

## 测试体系

```bash
npm test              # Vitest 全量测试
npm run build:lib     # 编译 lib/
npm run typecheck     # 类型检查
npm run dev:cf        # 本地开发（wrangler dev）
npm run deploy:cf     # 部署到 CF Workers
```

测试覆盖 1000+ 用例，关键测试文件：

- `tests/extraction.test.ts` — extraction pipeline（selectorProvider / readabilityProvider / densityProvider / scorer）
- 站点回归测试：github.blog、Jane Street 等

## 关键设计决策

### 1. Hono + linkedom

- **Hono**：CF Workers 原生运行，无 Node-only 依赖
- **linkedom**：纯 JS DOM，CF / Node 都能跑；jsdom 引入 undici 的 `MessagePort` 在 Workers 上 ReferenceError
- **cheerio**：无 `createTreeWalker`，改写成本高

### 2. 多策略 Extraction

按 `chatgpt0714.md` 架构，把 `findArticleRoot` 从"单一策略硬覆盖"改造成：
- 4 个 CandidateProvider 并行产生候选
- 统一 ArticleQualityScorer 评分
- 选择 confidence 最高的候选
- 低 confidence 时仍返回，由上层根据 blocks 数量做 fallback

### 3. 全并行翻译

Server 端 KV cache 不跨请求，chunk 直接 `Promise.all` 全并行。CF Workers 限制同时最多 6 个 fetch 等待 response headers。

### 4. nodeType 判别

walker / rules 全部用 `nodeType === N` 而非 `instanceof`，因为 linkedom 的节点 `instanceof jsdom.Element` 为 false。

### 5. Data Island fallback

SPA 站点从 `__NEXT_DATA__` / `__NUXT_DATA__` 提取正文（`extractFromDataIsland`）。

### 6. 双语对照 DOM 回填

- 原文移入 `.fanyi-original` span，保留链接/格式
- 不用 `node.textContent = ''` 破坏原 DOM
- 可 restore / toggle

### 7. JSON 修复链

LLM 输出处理顺序（必须按此顺序）：

1. `stripThinkingTags`：去除 `<think>...</think>` 标签（完整 + 截断两种情况）。必须在 `stripMarkdownCodeBlock` 之前调用，因为 thinking 标签可能出现在 ```json 块内部。
2. `stripMarkdownCodeBlock`：去除 ```json 包裹（处理完整包裹和只有开头无结尾两种情况）
3. `cleanJsonString`：移除尾随逗号 + 修复 LLM 偶发"重复引号"模式（jsonrepair 修不对这个特定 bug）
4. `repairJson`：调用 jsonrepair 库修复 LLM 偶发输出错误（截断/缺逗号/单引号/特殊空格等，比手写 repairTruncatedJson 覆盖更广，且会保留不完整字符串的部分内容而非丢弃）

`estimateMaxTokens` 使用 6x input token 倍数，上限 131072，留足余量应对中文扩词和 JSON 包装。

### 8. SPA 防御三层

针对 SPA-first 站点（X/Twitter 等）的三层处理：

1. **`stripNavigationScripts`**：移除 Cloudflare JSD challenge 脚本（只去挑战脚本，保留样式脚本如 abs.twimg.com）
2. **`stripHydrationScripts`**：移除 SPA chunk + bootstrap data（`__NEXT_DATA__` 等）
3. **`injectRedirectGuard`**：双重防御
   - fetch/XHR guard 拦截 `/cdn-cgi/` 请求，返回 fake 200
   - Navigation API 拦截 `navigate` 事件，阻止 reload（现代浏览器无法 patch `Location` 实例属性）
4. **`devirtualizeLayout`**：服务端 DOM 重写，移除 `position:absolute` / `transform:translateY()` 虚拟定位，防止 JS 被 strip 后内容重叠

### 9. 缓存健康检查

`isHealthyCachedHtml` 判定缓存 HTML 是否损坏（损坏则重新翻译）：

- 必须包含 `<html>` 标签
- 有外联 stylesheet → 健康
- 或有非 OneTrust / 非 fanyi 的内联 style → 健康
- 只有 OneTrust / fanyi 内联样式 → 损坏（重新翻译）

额外损坏判定（per project_memory）：
- 包含未标记的 `id="onetrust-banner-sdk"` 元素（无 `data-fanyi-remove="true"`）→ 损坏

### 10. OneTrust Cookie Banner 处理

`CONSENT_SDK_ID_RE` / `CONSENT_SDK_CLASS_RE`（contentDetector.ts）匹配 `onetrust` / `ot-sdk` / `ot-pc` / `ot-floating` / `otfloatingflat`，标记 `data-fanyi-remove="true"` 隐藏。

这些正则需在 vocal-saga 和 fanyi-extension 间保持同步（per CROSS_PROJECT_SYNC.md）。

### 11. 翻译文风 PromptStyle

四种翻译文风，通过 `buildSystemContent` 分发：

| Style | 文件 | 风格 |
|-------|------|------|
| default | shared.ts (内联) | 通用直译 |
| jinyong | jinyong-prompt.ts | 金庸武侠 |
| acheng | acheng-prompt.ts | 阿城白描 |
| wangxiaobo | wangxiaobo-prompt.ts | 王小波大白话 |

default prompt 要点：
- 自然中文表达，不机械镜像原文
- "你"/"我" 代词按上下文自然翻译
- 省略重复主语
- 保留 URL / code / 版本号

### 12. O'Reilly Client Hints

fetch 请求到 O'Reilly 必须包含 `Sec-Ch-Ua` / `Sec-Ch-Ua-Mobile` / `Sec-Ch-Ua-Platform` headers，否则 403。`urlFetcher.ts` 全局注入这些 Client Hints。

### 13. github.blog 嵌套 HTML

github.blog（WordPress CMS）在 `<section class="post__content">` 内注入完整 HTML 文档，导致嵌套 `<html>` 元素。linkedom 保留但浏览器忽略。HTML 解析需允许 parent 非 `#document`（嵌套 HTML）时继续遍历。

### 14. 429 错误处理

必须记录完整响应 body + rate limit headers：`retry-after` / `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset`。

CF Worker 共享 IP 易触发 429（多租户聚合使用），因此 OpenCode / OpenRouter 并发降到 1。

---

## 性能数据（生产日志）

| 阶段 | 耗时 |
|------|------|
| parseHTML | 5~35ms |
| prepareDoc | 11~86ms |
| translateChunks | 99% 时间（LLM API 响应） |
| CPU total | 26~59ms |

**Pipeline 性能日志**（pipeline.ts）：
```
[PERF] total Xµs prep=Xµs trans=Xµs apply=Xµs ser=Xµs
[Chunk N] start (M blocks, K tokens)
[Chunk N] api.call done (Xµs)
[Pipeline] translateChunks: N chunks, concurrency=C
```

---

## 项目原则

来自 [AGENTS.md](file:///Users/saga/code-repos/vocal-saga/AGENTS.md)：

1. 重要的功能添加修改，必须要有相应的测试用例
2. 没有用的功能直接删掉，不要做 fallback design
3. 添加足够的中文代码注释
4. 如果 script 调用无法联通，使用 proxy.sh 的 proxy 设置