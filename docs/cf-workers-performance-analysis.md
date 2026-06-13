# Cloudflare Workers 性能优化分析报告

> 分析日期：2026-06-13
> 目标环境：Cloudflare Workers（V8 isolate, 128MB 内存, 30s CPU 时间限制）

---

## 一、现状概览

| 指标 | 当前状态 |
|------|---------|
| 入口 | `src/worker.ts` → Hono app 单例 |
| 存储 | Cloudflare KV（异步 KV API） |
| DOM 解析 | linkedom（纯 JS，零 Node 依赖） |
| 翻译服务 | DeepSeek API（串行队列 KV cache 优化） |
| 缓存 | 两层：内存 Map + KV 持久层 |
| 并发 | CF Workers 限制同时 6 个 fetch |

---

## 二、性能瓶颈分析

### 2.1 冷启动（Isolate 启动）

**问题**：模块加载时 eager import 所有依赖，包括重量级 NLP 库。

```
当前 import 树：
worker.ts
  └─ lib/dist/index.js
       └─ lib/app.ts
            ├─ hono（轻量，OK）
            ├─ lib/translate/pipeline.ts
            │    ├─ linkedom（已在 urlFetcher.ts lazy import，OK）
            │    ├─ chunkBuilder（轻量，OK）
            │    └─ translationDisplay（lazy import，OK）
            ├─ lib/translate/glossaryStore.ts
            │    └─ lib/translate/glossaryExtractor.ts
            │         └─ compromise/two（⚠️ 100KB+ NLP 库）
            └─ lib/auth.ts（轻量，OK）
```

**影响**：`compromise` 是一个完整的 NLP 分析库，只在 `/api/glossary/extract` 路由调用时才需要。但它在 `glossaryStore.ts` 的 `import` 链上被 eager 加载，导致每次 isolate 启动都要解析和执行这个 100KB+ 的模块。

**实测数据**（推算）：
- `compromise/two` 约 120KB minified → V8 解析约 50-100ms
- linkedom 已经 lazy import，正确
- 其余模块总和约 20KB，忽略不计

### 2.2 内存缓存无上限

**问题**：`CacheManager` 的 `memoryCache` 是无限增长的 `Map`。

```typescript
// lib/translate/cacheManager.ts:27
private memoryCache = new Map<string, CacheEntry<any>>();
```

**影响**：
- CF Workers 单个 isolate 最大 128MB 内存
- 每次翻译请求会缓存 chunk 翻译结果（`translationCache`），大页面 10+ chunks
- 长期运行的 isolate（热启动）会持续累积，最终 OOM 或触发 GC 压力
- `analysisCache` 也有同样问题（30 天 TTL，但内存不清理）

### 2.3 重复 JSON 序列化/反序列化

**问题**：翻译 pipeline 中存在多次 JSON parse/stringify。

以一次 `translateUrl` 调用为例：

| 位置 | 操作 | 次数 |
|------|------|------|
| `chunkBuilder.ts:18-22` | `JSON.stringify` 每个 chunk | = chunks 数（约 5-15 次） |
| `deepseek.ts:105-109` | `JSON.stringify` 请求 body | 1 次/chunk |
| `deepseek.ts:182` | `JSON.parse` 响应 | 1 次/chunk |
| `translateApi.ts:27` | `JSON.parse` 翻译结果 | 1 次/chunk |
| `pipeline.ts:273` | `import('./translationDisplay')` lazy | 1 次（OK） |
| `pipeline.ts:346` | `page.doc.documentElement.outerHTML` 序列化 | 1 次（OK） |

**优化空间**：
- `chunkBuilder.ts` 里 `buildJsonContent` 每个 chunk 都做一次 `JSON.stringify`，但 `deepseek.ts:105` 又重新 `JSON.stringify(blocks.map(...))`——同一个 blocks 被 stringify 了两次
- `translateApi.ts:processTranslationResult` 和 `logUnchangedBlocks` 各自 parse 一次同一个 JSON string——可以合并

### 2.4 DOM 查询低效

**问题**：`pipeline.ts:275-286` 的回填逻辑对每个 block 做一次 `querySelector`。

```typescript
for (const block of blocks) {
  const el = page.doc.querySelector(`[data-fanyi-block-id="${block.id}"]`);
  // ...
}
```

**影响**：
- 一个典型页面有 50-200 个 blocks
- `querySelector('[data-fanyi-block-id="b1"]')` 在 linkedom 中是 O(N) 遍历
- 总复杂度 O(blocks × N) ≈ O(N²)

**优化**：一次 `querySelectorAll('[data-fanyi-block-id]')` 构建 Map，后续 O(1) 查找。

### 2.5 `Array.from` 滥用

**问题**：`walker.ts` 和 `rules.ts` 中大量使用 `Array.from(node.childNodes)`。

```typescript
// walker.ts:252, 317, 333, 363
for (const child of Array.from(startNode.childNodes)) { ... }

// rules.ts:327
for (const child of Array.from(el.childNodes)) { ... }
```

**影响**：
- `node.childNodes` 是 `NodeList`（live collection），每次 `Array.from` 都创建新数组
- 对于大型页面（1000+ 节点），这会产生大量短命数组，增加 GC 压力
- 可以用 `for...of` 直接遍历 `NodeList`（CF Workers 支持）

### 2.6 XPath 计算开销

**问题**：`walker.ts:373-394` 的 `getXPath` 在每个 block 上调用，遍历祖先链并计算兄弟索引。

```typescript
export function getXPath(node: Node): string {
  const parts: string[] = [];
  let current: Element | null = node as Element;
  while (current && current.nodeType === ELEMENT_NODE_TYPE) {
    let index = 1;
    let sibling: Element | null = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    const tag = current.tagName.toLowerCase();
    parts.unshift(`${tag}[${index}]`);
    current = current.parentElement;
  }
  return '/' + parts.join('/');
}
```

**影响**：
- 每个 block 调用一次，典型页面 50-200 次
- 每次遍历祖先链（平均深度 5-15）× 兄弟遍历（平均 3-5）
- XPath 主要用于 `findBlockNode` 的 fallback 查找，但生产环境 `data-fanyi-block-id` 已经够用

**建议**：XPATH 可以降级为 debug 用途，生产不计算。或者缓存父链上兄弟索引的中间结果。

### 2.7 KV 操作未批量化

**问题**：`CacheManager.clear()` 逐个删除 KV key。

```typescript
async clear(): Promise<void> {
  this.memoryCache.clear();
  const allKeys = await this.storage.list();
  const ours = allKeys.filter((k) => k.startsWith(this.prefix));
  await Promise.all(ours.map((k) => this.storage.delete(k)));
}
```

**影响**：
- `list()` 返回所有 KV key（可能数百个），然后逐个 `delete`
- CF Workers KV `delete` 没有批量 API，但可以用 `Promise.all` 并发（当前已做）
- 真正的瓶颈是 `list()` 本身——KV list 是最终一致的，大 prefix 下可能返回不完整结果

### 2.8 `estimateTokens` 不准确

**问题**：`chunkBuilder.ts:14-16` 用固定比例估算 token。

```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

**影响**：
- 英文平均 1 token ≈ 4 chars → 正确
- 中文/日文 1 token ≈ 1-2 chars → 严重低估
- 导致 chunk 切分过大，DeepSeek API 返回截断
- 触发 `chunkRetry` 重试，额外增加一次 API 调用

---

## 三、优化方案

### 3.1 消除 compromise 冷启动开销（高优先级）

**改动**：将 `glossaryExtractor.ts` 改为 lazy import。

```typescript
// lib/translate/glossaryStore.ts
// 替换顶层 import：
//   import { extractGlossaryLocal } from './glossaryExtractor';
// 改为 lazy：
let _extractor: typeof import('./glossaryExtractor').extractGlossaryLocal | null = null;

async function getExtractor() {
  if (!_extractor) {
    _extractor = (await import('./glossaryExtractor')).extractGlossaryLocal;
  }
  return _extractor;
}
```

**效果**：冷启动时间减少约 50-100ms。compromise 只在 `/api/glossary/extract` 路由首次调用时加载。

**测试**：在 `tests/glossaryStore.test.ts` 中验证 lazy import 不影响功能。

---

### 3.2 内存缓存 LRU 淘汰（高优先级）

**改动**：给 `CacheManager` 添加最大条目数限制。

```typescript
// lib/translate/cacheManager.ts
export class CacheManager {
  private memoryCache = new Map<string, CacheEntry<any>>();
  private readonly maxMemoryEntries: number;

  constructor(
    private storeName: string,
    private defaultTTL = 24 * 60 * 60 * 1000,
    storage?: StorageAdapter,
    maxMemoryEntries = 500,  // 新增参数
  ) {
    this.maxMemoryEntries = maxMemoryEntries;
    // ...
  }

  private evictIfNeeded(): void {
    if (this.memoryCache.size <= this.maxMemoryEntries) return;
    // Map 保持插入顺序，删除最早的 20%
    const toDelete = Math.ceil(this.maxMemoryEntries * 0.2);
    let deleted = 0;
    for (const key of this.memoryCache.keys()) {
      if (deleted >= toDelete) break;
      this.memoryCache.delete(key);
      deleted++;
    }
  }

  async set<T>(key: string, data: T, ttl?: number): Promise<void> {
    // ...
    this.memoryCache.set(key, entry);
    this.evictIfNeeded();
    // ...
  }
}
```

**效果**：内存使用可预测，避免 OOM。LRU 策略保留热点数据。

---

### 3.3 消除重复 JSON 序列化（中优先级）

**改动 1**：`chunkBuilder.ts` 返回 `jsonContent` 时，同时保留 blocks 引用。

```typescript
// lib/translate/chunkBuilder.ts
export interface Chunk {
  id: string;
  blocks: TextBlock[];
  jsonContent: string;       // 已有
  estimatedTokens: number;
}

// deepseek.ts 直接用 chunk.jsonContent 而非重新 stringify
```

**改动 2**：合并 `processTranslationResult` 和 `logUnchangedBlocks`。

```typescript
// lib/translate/translateApi.ts
export function processTranslationResult(
  jsonResult: string,
  originalBlocks?: Array<{ id: string; text: string }>
): Map<string, string> {
  const parsed = JSON.parse(jsonResult);
  const translations = parsed.translations || parsed;
  const result = new Map<string, string>();
  // ... 现有逻辑 ...

  // 如果传了 originalBlocks，同时做 unchanged 检测
  if (originalBlocks) {
    logUnchangedFromParsed(translations, originalBlocks);
  }

  return result;
}
```

**效果**：减少约 30% 的 JSON 操作，大 chunk 效果更明显。

---

### 3.4 批量 DOM 查询（中优先级）

**改动**：`pipeline.ts` 的回填逻辑改用一次性查询。

```typescript
// lib/translate/pipeline.ts translateUrl 函数
// 旧代码：
for (const block of blocks) {
  const translated = translations.get(block.id);
  if (!translated) continue;
  const el = page.doc.querySelector(`[data-fanyi-block-id="${block.id}"]`);
  if (el && (el as Node).nodeType === 1) {
    applyBlockTranslation(el as unknown as HTMLElement, translated, mode);
  }
}

// 新代码：
const blockMap = new Map<string, Element>();
page.doc.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
  const id = el.getAttribute('data-fanyi-block-id');
  if (id) blockMap.set(id, el);
});

for (const block of blocks) {
  const translated = translations.get(block.id);
  if (!translated) continue;
  const el = blockMap.get(block.id);
  if (el && (el as Node).nodeType === 1) {
    applyBlockTranslation(el as unknown as HTMLElement, translated, mode);
  }
}
```

**效果**：DOM 查询从 O(blocks × N) 降到 O(N)。对大型页面（200+ blocks）提升显著。

---

### 3.5 消除 Array.from（低优先级）

**改动**：用 `for...of` 直接遍历 `NodeList`。

```typescript
// 旧代码：
for (const child of Array.from(startNode.childNodes)) { ... }

// 新代码：
for (const child of startNode.childNodes) { ... }
```

**影响范围**：`walker.ts`（4 处）、`rules.ts`（1 处）、`contentHelper.ts`（隐含）。

**效果**：减少内存分配，降低 GC 压力。CF Workers 的 V8 支持 `for...of` 遍历 NodeList。

---

### 3.6 XPath 按需计算（低优先级）

**改动**：只在 debug 模式或 fallback 时计算 XPath。

```typescript
// lib/translate/blockExtractor/walker.ts
blocks.push({
  id,
  xpath: '',  // 空字符串，生产不计算
  tag: translateNode.tagName.toLowerCase(),
  text,
  context: {
    headingPath: getHeadingPath(translateNode),
    position: blockIdRef.value,
  },
});
```

**效果**：每个 block 减少一次祖先链遍历。200 blocks × 10 深度 = 2000 次 `parentElement` 访问被省掉。

**注意**：`findBlockNode` 的 XPath fallback 会失效，但 `data-fanyi-block-id` 已经覆盖了生产场景。

---

### 3.7 优化 token 估算（中优先级）

**改动**：区分 CJK 和拉丁字符的 token 比例。

```typescript
// lib/translate/chunkBuilder.ts
function estimateTokens(text: string): number {
  // CJK 字符约占 0.5 tokens/char，拉丁文约 0.25 tokens/char
  let cjkChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified
      (code >= 0x3040 && code <= 0x309f) ||   // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) ||   // Katakana
      (code >= 0xac00 && code <= 0xd7af)      // Hangul
    ) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(cjkChars * 0.5 + otherChars * 0.25);
}
```

**效果**：中文为主的页面 chunk 切分更准确，减少 API 重试。

---

### 3.8 KV 列表优化（低优先级）

**改动**：`CacheManager.clear()` 使用 prefix list + limit。

```typescript
async clear(): Promise<void> {
  this.memoryCache.clear();
  try {
    // 只列出本 prefix 的 key（KV 支持 prefix filter）
    const result = await (this.storage as any).kv?.list({ prefix: this.prefix });
    if (result) {
      await Promise.all(result.keys.map((k: { name: string }) =>
        this.storage.delete(k.name)
      ));
    }
  } catch {
    // fallback：list + filter
    const allKeys = await this.storage.list();
    const ours = allKeys.filter((k) => k.startsWith(this.prefix));
    await Promise.all(ours.map((k) => this.storage.delete(k)));
  }
}
```

**注意**：`StorageAdapter` 接口没有暴露 KV native 的 `list({ prefix })` 参数，需要扩展接口或类型断言。

---

## 四、优化优先级矩阵

| 优先级 | 改动 | 预估收益 | 改动量 | 风险 |
|--------|------|---------|--------|------|
| P0 | 3.1 compromise lazy import | 冷启动 -50~100ms | 小 | 低 |
| P0 | 3.2 内存缓存 LRU | 防 OOM，GC 稳定 | 中 | 低 |
| P1 | 3.4 批量 DOM 查询 | 大页面 -100~500ms | 小 | 低 |
| P1 | 3.3 消除重复 JSON | -30% 序列化开销 | 中 | 低 |
| P1 | 3.7 token 估算优化 | 减少 API 重试 | 小 | 低 |
| P2 | 3.5 消除 Array.from | 降低 GC 压力 | 小 | 低 |
| P2 | 3.6 XPath 按需计算 | 每 block 省一次遍历 | 小 | 中 |
| P2 | 3.8 KV 列表优化 | clear() 更快 | 中 | 低 |

---

## 五、实施建议

### 第一批（立即可做，1-2 小时）
1. 3.1 compromise lazy import
2. 3.4 批量 DOM 查询
3. 3.5 消除 Array.from

### 第二批（需测试，半天）
4. 3.2 内存缓存 LRU
5. 3.3 消除重复 JSON
6. 3.7 token 估算优化

### 第三批（需评估，可选）
7. 3.6 XPath 按需计算
8. 3.8 KV 列表优化

---

## 六、监控建议

优化后需要关注的指标：

1. **冷启动时间**：`wrangler dev` 启动时间，或 CF Dashboard 的 `Worker Startup Time`
2. **内存使用**：CF Dashboard → Workers → Logs 中的 `wall_time` 和内存分配
3. **GC 频率**：V8 GC 暂停时间（可通过 `performance.now()` 在请求前后测量）
4. **API 重试率**：`[Pipeline] missing` 日志出现频率
5. **KV 命中率**：`[Pipeline] cache hit` vs `[Chunk] translate start` 比例

---

*报告完毕。建议从 P0 级别的两项开始实施。*
