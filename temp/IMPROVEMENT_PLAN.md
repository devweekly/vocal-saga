# vocal-saga 架构改进计划

> 基于对当前代码库的架构审视，整理出值得改进的方向。按优先级分级，每项给出问题定位、改进方案与影响面。

## 优先级说明

- **P0 安全与正确性**：必须修复，涉及线上风险或数据正确性
- **P1 架构改进**：显著提升可维护性 / 可扩展性，建议中期落地
- **P2 代码质量**：消除技术债，降低后续改动成本
- **P3 性能与可观测性**：提升运行效率与排障能力

---

## P0 安全与正确性

### P0-1 SSRF 防护缺失

**问题**：[lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts) 的 `handleTranslateRequest` 接受任意用户输入 URL 直接 `fetchPage`，无私网 IP / 元数据服务地址校验。

**风险**：攻击者可通过 `/translate/169.254.169.254/latest/meta-data/` 探测 CF Workers 内网或云元数据服务（虽 CF Workers 沙箱隔离，但 `fetch` 到内网域名仍可能泄露信息或被用作代理）。

**方案**：
- 在 [lib/urlUtils.ts](file:///Users/saga/code-repos/vocal-saga/lib/urlUtils.ts) 新增 `assertPublicUrl(url)` 校验：
  - 拒绝 RFC1918 私网段（10.0.0.0/8、172.16.0.0/12、192.168.0.0/16）
  - 拒绝链路本地（169.254.0.0/16，含 AWS metadata）
  - 拒绝 loopback（127.0.0.0/8）、`localhost`、`.internal` / `.local`
  - 拒绝非 http/https 端口（仅允许 80/443）
- `handleTranslateRequest` 与 `handleOriginalRequest` 入口调用
- 加单元测试覆盖各类私网地址

**影响面**：[lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts)、[lib/urlUtils.ts](file:///Users/saga/code-repos/vocal-saga/lib/urlUtils.ts)、新增测试

### P0-2 公开翻译端点无限流

**问题**：`GET /translate/*`、`/openrt/*`、`/nvd/*`、`/gemini/*`、`/oc/*`、`/cf/*`、`/s/*` 均无鉴权也无 IP 限流，只有 `/force/*` 有 45s/IP 限流。每个翻译请求触发一次 LLM 上游调用（成本高），可被刷量。

**方案**：
- 抽取 `/force/*` 的限流逻辑为通用 `createRateLimit(windowMs, max)` middleware
- 对所有 provider 翻译路由统一应用（如每 IP 每 30s 最多 3 次新翻译，D1 缓存命中不限流）
- 在 D1 cache hit 分支提前返回，不计入限流（避免误伤）

**影响面**：[lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts)（抽 middleware）、[lib/auth.ts](file:///Users/saga/code-repos/vocal-saga/lib/auth.ts)

### P0-3 配置双路径导致 Workers 环境不一致

**问题**：当前配置读取存在两条路径并存：
- [src/worker.ts](file:///Users/saga/code-repos/vocal-saga/src/worker.ts) 的 `injectEnv(env)` 把 CF bindings 注入模块级变量
- [lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts) 的 `createApp` 又从 `process.env` 读取注入 config 模块

在 Cloudflare Workers 中 `process.env` 可能为空或行为不一致，导致 API keys 实际取不到（靠 injectEnv 补救），逻辑分散且易漏。

**方案**：
- 统一为 `c.env` 注入路径：[lib/config.ts](file:///Users/saga/code-repos/vocal-saga/lib/config.ts) 改为接受 `Env` 对象的 getter（而非模块级可变全局）
- `createApp` 接收 `env` 参数，用 Hono 的 `Variables` 类型把 env 挂到 context
- 删除 `process.env` 读取分支，仅保留 Node 测试环境的兼容入口

**影响面**：[lib/config.ts](file:///Users/saga/code-repos/vocal-saga/lib/config.ts)、[lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts)、[src/worker.ts](file:///Users/saga/code-repos/vocal-saga/src/worker.ts)

---

## P1 架构改进

### P1-1 翻译服务工厂化（消除 if-else + as any）

**问题**：[lib/translate/pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/pipeline.ts) 第 296-317 行用 6 个 `else if` + 动态 `import` 选择 service，且全部 `as any` 转成 `DeepSeekTranslationService`：

```typescript
let service: DeepSeekTranslationService;
if (provider === 'openrouter') {
  service = new OpenRouterTranslationService(style) as any;
} else if (provider === 'nvidia') {
  service = new NvidiaTranslationService(model, style) as any;
} ...
```

违反依赖倒置：[_service.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/service/_service.ts) 定义了 `TranslationService` 接口，但 pipeline 依赖具体类型 `DeepSeekTranslationService`。

**方案**：
- 新建 `lib/translate/service/registry.ts`：
  ```typescript
  type ProviderFactory = (opts: { model?: string; apiKey?: string; style?: PromptStyle }) => TranslationService;
  const REGISTRY = new Map<string, ProviderFactory>();
  export function registerProvider(name, factory) { REGISTRY.set(name, factory); }
  export function getProvider(name, opts): TranslationService { ... }
  ```
- 每个 service 文件末尾 `registerProvider('deepseek', (o) => new DeepSeekTranslationService(o.apiKey, o.style))`
- pipeline 改为 `const service = getProvider(provider, { model, apiKey, style })`
- `translateChunk` 参数类型改为 `TranslationService`

**影响面**：新增 `registry.ts`、修改 7 个 service 文件、简化 pipeline.ts

### P1-2 D1 操作抽 Repository 层

**问题**：[lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts) 中 5 处直接写 SQL：
- `fetchListPage`（list + count）
- `/article/:id` 查询
- `/fanyi/page/check` 查询
- `/fanyi/page` 查询 + UPSERT
- `handleTranslateRequest` 查询 + UPSERT

SQL 散落在路由层，无法独立测试，且 `isHealthyCachedHtml` 健康检查逻辑也耦合在 app.ts。

**方案**：
- 新建 `lib/repository/translationRepo.ts`：
  ```typescript
  interface TranslationRecord { id; url; title; source_lang; target_lang; html; created_at }
  interface TranslationRepo {
    findCached(url, source, target): Promise<{ html: string } | null>;
    upsert(record: Omit<TranslationRecord, 'id'|'created_at'>): Promise<void>;
    findById(id: number): Promise<TranslationRecord | null>;
    listPage(page, pageSize): Promise<{ rows; total }>;
  }
  ```
- 健康检查 `isHealthyCachedHtml` 移到 `lib/repository/cacheHealth.ts`
- 路由层只调 repo 方法，SQL + UPSERT + 健康检查封装在 repo
- 路由层用 mock repo 即可单测缓存命中/未命中分支

**影响面**：新增 `lib/repository/`，重构 [lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts)

### P1-3 extraction 与 contentHelper 职责清理 [已完成 2026-07-16]

**落地说明**：
- body-fallback 整合进 `selectBestRoot`（无候选时返回 doc.body，strategy='body-fallback'）
- data-island 保留在 `contentHelper.prepareDocument`（属"从 JSON 提取"，非"选根"，明确分层）
- `ExtractionReport.confidence` → `extractionQuality`，与 `ArticleCandidate.confidence` 语义区分
- 删除 `findArticleRootL3` / `hasMeaningfulContent`
- 验证：1061 测试通过，typecheck / build:lib 通过

**问题**：[lib/translate/contentHelper.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/contentHelper.ts) 与 extraction 模块存在重叠：
- `findArticleRoot` 调 `selectBestRoot`，但下面又有 `findArticleRootL3` 作为兜底
- `buildReport` 的 confidence 计算（块数/文本长度/噪声比）与 [extraction/scoring.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/extraction/scoring.ts) 的 confidence 是两套独立逻辑
- `contentDetector.ts` 的 `detectArticleRoot` 被 `extraction/providers/density.ts` 调用，但 contentHelper 又单独实现 L3 兜底

**方案**：
- 统一 fallback 路径：把 `findArticleRootL3` 与 data-island fallback 整合进 `extraction/pipeline.ts` 的 `selectBestRoot`，返回 strategy 包含 `body-fallback` / `data-island`
- 统一 confidence 语义：`ExtractionReport.confidence` 与 `ArticleCandidate.confidence` 对齐，要么复用 scoring.ts，要么明确区分（一个是抽取置信度，一个是候选质量分）
- 明确分层：extraction 负责"选根"，contentHelper 负责"协调 prepareDocument 流程（选根 → extractBlocks → merge → buildChunks → report）"

**影响面**：[lib/translate/contentHelper.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/contentHelper.ts)、[lib/translate/extraction/pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/extraction/pipeline.ts)

### P1-4 Hono Env 类型化

**问题**：[lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts) 大量 `(c.env as any)?.DB999`、`handleTranslateRequest(c: any, ...)`。Hono 原生支持 `Env` 泛型，当前完全没用。

**方案**：
```typescript
interface Bindings {
  DB999: D1Database;
  VOCAL_SAGA_KV: KVNamespace;
  ASSETS: Fetcher;
  AUTH_KEY: string;
  DEEPSEEK_API_KEY: string;
  // ...
}
const app = new Hono<{ Bindings: Bindings }>();
// c.env.DB999 直接有类型
```

**影响面**：[lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts) 全文类型清理

### P1-5 翻译输入参数类型统一

**问题**：`TranslateUrlInput` 与 `TranslateHtmlInput`（[pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/pipeline.ts) 第 215-253 行）几乎完全重复（provider / model / source / target / mode / glossary / promptStyle），仅差 `apiKey`、`html` 字段。

**方案**：
```typescript
interface TranslateBaseOptions {
  source?: string;
  target?: string;
  mode?: 'bilingual';
  glossary?: Glossary;
  provider?: Provider;
  model?: string;
  promptStyle?: PromptStyle;
}
interface TranslateUrlInput extends TranslateBaseOptions { url: string; }
interface TranslateHtmlInput extends TranslateBaseOptions { html: string; url: string; apiKey?: string; }
```

**影响面**：[lib/translate/pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/pipeline.ts)

---

## P2 代码质量

### P2-1 删除冗余的 translateApi 函数

**问题**：[lib/translate/translateApi.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/translateApi.ts) 三个函数：
- `processTranslationResult`（旧，单独 parse）
- `logUnchangedBlocks`（旧，单独 parse，返回原 json）
- `processTranslationWithCheck`（新，一次 parse 完成两件事）

pipeline 实际只用 `processTranslationWithCheck`，前两个是历史遗留。

**方案**：删除 `processTranslationResult` 与 `logUnchangedBlocks`，调用方（如有）迁移到 `processTranslationWithCheck`。符合 AGENTS.md 原则2"没用的功能直接删掉"。

**影响面**：[lib/translate/translateApi.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/translateApi.ts)

### P2-2 并发度可配置化

**问题**：[pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/pipeline.ts) 第 320-323 行硬编码：
```typescript
let concurrency = (provider === 'opencode' || provider === 'openrouter') ? 1 : 2;
if (provider === 'deepseek') concurrency = 4;
```

调整并发需要改代码。

**方案**：在 service 注册时声明并发上限（registry 元数据），pipeline 从 registry 读取：
```typescript
registerProvider('deepseek', factory, { maxConcurrency: 4 });
```

**影响面**：`lib/translate/service/registry.ts`、[pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/pipeline.ts)

### P2-3 HTML 序列化 doctype 重复

**问题**：[pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/pipeline.ts) 第 436 行与 [app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts) 第 861 行：
```typescript
const html = '<!doctype html>\n' + doc.documentElement.outerHTML;
```
`documentElement.outerHTML` 通常已含 `<html>`，手动拼 doctype 在某些 linkedom 版本下可能与 `<!DOCTYPE>` 重复。建议用 `doc.documentElement.ownerDocument` 的序列化或显式判断。

**方案**：抽取 `serializeDocument(doc): string` 工具函数，统一处理 doctype + outerHTML，两边复用。

**影响面**：新增工具函数、[pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/pipeline.ts)、[app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts)

### P2-4 错误处理规范化

**问题**：多处 `catch (e) { console.error(...); return { rows: [], total: 0 }; }` 静默吞错（如 [app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts) 第 204-208 行）。D1 查询失败时翻译流程继续，但调用方无法区分"无记录"与"查询失败"。

**方案**：
- 区分"可恢复降级"与"应抛出"两类错误
- D1 查询失败时记录结构化错误，并让响应头带 `X-Storage-Error: d1-lookup-failed`，便于排障
- 不要在 catch 里用宽泛 `any`，尽量 `unknown` + 类型收窄

**影响面**：[lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts)、[lib/repository/](file:///Users/saga/code-repos/vocal-saga/lib/repository/)（配合 P1-2）

### P2-5 promptStyle 类型断言散落

**问题**：`c.req.query('style') as PromptStyle`、`body.promptStyle as PromptStyle` 散在多处，无运行时校验，传非法值会静默走 default。

**方案**：新增 `parsePromptStyle(input: unknown): PromptStyle` 校验函数，集中调用。

**影响面**：新增工具、[lib/app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts)

### P2-6 兼容导出清理

**问题**：[contentHelper.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/contentHelper.ts) 第 443-449 行从 `extraction/providers/selector` re-export `refineArticleRoot` / `expandWrappers` / `chooseBestRoot` 等"兼容导出"。需确认是否还有外部引用，否则删除（AGENTS.md 原则2）。

**方案**：全局 grep 引用，无外部引用则删除 re-export。

**影响面**：[lib/translate/contentHelper.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/contentHelper.ts)

---

## P3 性能与可观测性

### P3-1 结构化日志

**问题**：`console.log` / `console.warn` / `console.error` 散落 60+ 处，格式不统一（µs/ms 混用，字段顺序随意），难以在 Workers Logs / Logpush 中聚合查询。

**方案**：
- 新建 `lib/logger.ts`，提供 `logger.info(ctx, msg, fields)` 等方法，统一 JSON 结构：
  ```json
  { "level":"info", "msg":"chunk done", "chunkId":"c1", "tokens":1200, "latencyMs":340 }
  ```
- 关键字段标准化：`requestId`（用 `cfRequestId` 或自生成）、`provider`、`url`、`latencyMs`
- 时间单位统一为 ms（µs 精度对排障无价值）

**影响面**：新增 `lib/logger.ts`、逐步替换 console 调用

### P3-2 Metrics 采集

**问题**：无指标采集，无法量化翻译成功率、p99 延迟、缓存命中率、各 provider 错误率。

**方案**：
- 在 pipeline 关键节点埋点，写入 CF Analytics Engine（或 KV 聚合）
- 核心指标：`translation_total`、`translation_cached_hit`、`translation_blocks`、`translation_duration_ms`、`provider_error{type}`
- 配合 Grafana / CF Dashboard 观测

**影响面**：[pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/pipeline.ts)、[app.ts](file:///Users/saga/code-repos/vocal-saga/lib/app.ts)、新增 metrics 模块

### P3-3 缓存层职责澄清

**问题**：当前三层缓存职责不清：
- D1：翻译历史 HTML（持久，跨请求）
- KV（通过 StorageAdapter）：chunk 翻译结果（持久，跨请求）
- 内存 Map（CacheManager 内）：同请求内加速

[pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/pipeline.ts) 注释"Server 端 KV cache 不跨请求"有歧义——KV 本身跨请求，是内存 Map 不跨请求。

**方案**：
- 文档明确三层职责：内存 Map（单请求加速，避免同请求内重复 LLM 调用）→ KV（跨请求 chunk 翻译缓存）→ D1（跨请求整页 HTML 历史）
- 评估内存 Map 在 server 端的实际价值：CF Workers 单请求内 chunk 已并行，重复命中概率低，可能可移除
- KV 缓存的 TTL 策略统一（当前 7 天，是否合理？）

**影响面**：[lib/translate/cacheManager.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/cacheManager.ts)、文档更新

### P3-4 集成测试补强

**问题**：[tests/extraction.test.ts](file:///Users/saga/code-repos/vocal-saga/tests/extraction.test.ts) 覆盖了 extraction，但 pipeline 端到端集成测试缺失（prepareDocument → translateChunks → applyBlockTranslation 全链路）。当前依赖 1000+ 单元测试，但跨模块回归靠人工。

**方案**：
- 新增 `tests/pipeline.integration.test.ts`，用 mock TranslationService 跑全链路
- 覆盖场景：正常翻译、0 block、部分 missing 触发 retry、data-island fallback、bilingual 回填 DOM 完整性
- 真实站点回归：github.blog、Jane Street、arXiv 的 HTML 快照入 fixture

**影响面**：新增集成测试、fixture

### P3-5 动态 import 改静态注册

**问题**：[pipeline.ts](file:///Users/saga/code-repos/vocal-saga/lib/translate/pipeline.ts) 每次翻译都 `await import('./service/openrouter')`。虽然 V8 有模块缓存，但代码语义上是每次解析，且 tree-shaking 无法优化。

**方案**：配合 P1-1 registry，在模块加载时静态注册所有 provider，pipeline 直接查表。

**影响面**：配合 P1-1

---

## 迁移策略

### 阶段一：安全加固（P0）
1. 实现 `assertPublicUrl` + 单测
2. 抽取限流 middleware，应用到所有翻译路由
3. 统一配置注入路径（删除 process.env 分支）

这批改动低风险、高收益，优先合入。

### 阶段二：架构重构（P1）
1. D1 Repository 层（P1-2）—— 先抽接口，路由层逐步迁移
2. Service registry（P1-1）—— 与 P2-2 并发配置一起做
3. Env 类型化（P1-4）—— 全局类型清理
4. extraction 职责清理（P1-3）—— 需谨慎，保证现有测试不回归

每个子项独立 PR，配套测试。

### 阶段三：代码质量（P2）
逐项清理，每项小改动，可并行推进。

### 阶段四：可观测性（P3）
1. 结构化 logger 落地
2. Metrics 埋点
3. 集成测试补强

---

## 不建议改动项

以下设计当前合理，**不建议盲目重构**：

1. **linkedom 选型**：已在 project_memory 记录 jsdom 的 `MessagePort` 问题，linkedom 是当前最优解
2. **nodeType 判别**：跨 DOM 实现兼容性的必要手段
3. **双语对照 DOM 回填策略**：保留原 DOM 子节点的做法正确，避免破坏链接/格式
4. **多策略 extraction 架构**：按 chatgpt0714.md 设计，刚完成重构且有测试覆盖
5. **HTML 处理 pipeline 顺序**（strip → devirtualize → guard）：当前顺序合理
6. **翻译路由不鉴权**：浏览器直访场景的刻意设计，加限流即可，不要加鉴权

---

## 验收标准

每项改进落地时需满足：

1. **测试**：新增/修改逻辑必须有对应测试（AGENTS.md 原则1）
2. **类型**：`npm run typecheck` 通过，无新增 `as any`
3. **构建**：`npm run build:lib` 通过
4. **回归**：全量 `npm test` 通过（当前 1000+ 用例基线）
5. **注释**：新增模块有中文注释说明设计意图（AGENTS.md 原则3）
6. **无 fallback design**：删除的功能彻底删除，不留兼容层（AGENTS.md 原则2）
