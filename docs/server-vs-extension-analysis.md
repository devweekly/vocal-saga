# vocal-saga vs fanyi-extension 架构差异分析报告

> 分析日期：2026-06-14
> 目的：理解 Server Worker 与浏览器扩展在翻译流程上的本质差异

---

## 一、架构总览

| 维度 | fanyi-extension（浏览器扩展） | vocal-saga（Cloudflare Worker） |
|------|-----|------|
| 运行环境 | 浏览器（Chrome/Firefox） | Cloudflare Edge（V8 isolate） |
| DOM 访问 | 真实 live DOM | linkedom 模拟 DOM |
| 进程模型 | 3 层：content script → background → API | 单进程：Worker 直接调 API |
| 状态管理 | 有状态（content script 持有翻译状态） | 无状态（每次请求独立） |
| UI 交互 | 浮动按钮 + 配置面板 + 状态条 | 返回 HTML 字符串 |
| 实时性 | 实时（MutationObserver 监听 DOM 变化） | 静态（抓取那一刻的快照） |

---

## 二、核心流程对比

### 2.1 翻译流程

```
fanyi-extension:
  用户点击 → content script 提取 blocks → 通过 browser.runtime.sendMessage
  → background script 调 DeepSeek API → 返回译文 → content script 写回 DOM
  
vocal-saga:
  HTTP 请求 → Worker fetch 页面 HTML → linkedom 解析 → 提取 blocks
  → 直接调 DeepSeek API → 生成双语 HTML → 返回响应
```

**关键差异**：
- 扩展通过 **消息传递**（`sendMessage`）跨层通信，Worker 是 **单进程直接调用**
- 扩展可以 **增量翻译**（翻译一个 chunk 就写回一个），Worker 是 **全量生成后再返回**

### 2.2 DOM 操作方式

```typescript
// fanyi-extension：直接操作 live DOM
const node = nodeMap.get(blockId);
applyBlockTranslation(node, translatedText, mode);  // 立即生效

// vocal-saga：操作 linkedom 虚拟 DOM，最后序列化
const el = page.doc.querySelector(`[data-fanyi-block-id="${block.id}"]`);
applyBlockTranslation(el, translatedText, mode);  // 修改虚拟 DOM
const html = page.doc.documentElement.outerHTML;  // 最后序列化为字符串
```

**关键差异**：
- 扩展操作的 DOM 变更 **立即可见**（用户看到实时更新）
- Worker 操作的是 **内存中的虚拟 DOM**，最终只返回 HTML 字符串

### 2.3 动态内容处理

```typescript
// fanyi-extension：MutationObserver 监听 DOM 变化
const observer = new MutationObserver((mutations) => {
  // 检测新增的文本节点 → 单独翻译 → 写回 DOM
});
observer.observe(document.body, { childList: true, subtree: true });

// vocal-saga：无此功能（静态快照）
// 只处理抓取时的 HTML，不监听后续变化
```

**关键差异**：
- 扩展可以翻译 **SPA 动态加载的内容**（如 React/Vue 组件更新）
- Worker 只能翻译 **服务器返回的静态 HTML**

---

## 三、技术实现差异

### 3.1 消息传递 vs 直接调用

| 场景 | fanyi-extension | vocal-saga |
|------|-----|------|
| API 调用 | `browser.runtime.sendMessage({ action: 'translateChunk' })` | `service.translate(jsonContent, ...)` |
| 配置读取 | `getConfig()`（browser.storage） | `process.env.DEEPSEEK_API_KEY` |
| 缓存 | `getCachedTranslation()`（browser.storage） | `translationCache.get()`（KV） |

**影响**：
- 扩展的消息传递有 **序列化/反序列化开销**，但支持 **跨上下文通信**（content ↔ background）
- Worker 直接调用 **无序列化开销**，但 **无法跨进程**

### 3.2 翻译队列策略

```typescript
// fanyi-extension：warmup-then-parallel
// 前 2 个 chunk 串行（帮助 KV cache 构建），后续并行（桌面 4 / 移动 2）
const pool = new TranslationQueue(1, 0, 0);
await pool.addAllWithWarmup(tasks, 2, maxConcurrency);

// vocal-saga：固定并发 6（CF Workers 限制）
const translations = await translateChunksWithRetry(
  service, chunks, sourceLang, targetLang, glossary,
  /* concurrency */ 6
);
```

**关键差异**：
- 扩展的 warmup 策略 **优化了 DeepSeek KV cache 命中率**
- Worker 的固定并发 **利用了 CF Workers 的 6 连接上限**

### 3.3 结果应用策略

```typescript
// fanyi-extension：rAF 批量应用（避免阻塞主线程）
function applyTranslationsWithRAF(translationMap, nodeMap, mode) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      applyTranslations(translationMap, nodeMap, mode);
      resolve();
    });
  });
}

// vocal-saga：直接修改虚拟 DOM（无性能问题）
for (const block of blocks) {
  const el = blockMap.get(block.id);
  if (el) applyBlockTranslation(el, translated, mode);
}
```

**关键差异**：
- 扩展需要考虑 **主线程阻塞**（影响页面响应）
- Worker 操作虚拟 DOM **无此问题**

### 3.4 缓存策略

| 层级 | fanyi-extension | vocal-saga |
|------|-----|------|
| 内存 | 进程内 Map（每次冷启动清空） | 进程内 Map（isolate 复用） |
| 持久 | browser.storage.local | KV + D1 |
| 命名空间 | `translation:{hash}` | `translation:{source}_{target}_{hash}` |

**关键差异**：
- 扩展的缓存 **用户隔离**（每个浏览器实例独立）
- Worker 的缓存 **全局共享**（所有用户共享 KV）

### 3.5 术语表处理

```typescript
// fanyi-extension：本地 NLP 提取 + 用户手动添加
const glossary = await extractGlossary(fullText);
// + userTerms（browser.storage）
// + documentTerms（当前页面）

// vocal-saga：仅用户手动添加（无本地 NLP）
// glossaryStore 只存储 user_terms 和 document_terms
```

**关键差异**：
- 扩展使用 **compromise NLP 库** 本地提取术语（无需 API 调用）
- Worker **不支持本地术语提取**（避免在 Edge 环境引入重型依赖）

---

## 四、vocal-saga 缺失的功能

### 4.1 动态内容翻译

fanyi-extension 的 `DOMObserverManager` 支持：
- `MutationObserver`：监听 DOM 变化，自动翻译新增内容
- `IntersectionObserver`：懒加载优化（仅翻译可见区域）

vocal-saga 完全没有此功能（静态快照模式）。

### 4.2 翻译状态管理

fanyi-extension 维护：
- `originalTexts`：原文备份（支持恢复）
- `translatedBlocks`：已翻译 block 集合
- `isTranslated`：翻译状态标志

vocal-saga 是无状态的（每次请求独立，不维护翻译历史）。

### 4.3 用户交互

fanyi-extension 提供：
- 浮动按钮（一键翻译/恢复）
- 配置面板（API Key / 语言 / 模式）
- 状态条（进度/错误提示）
- 右键菜单 / 键盘快捷键

vocal-saga 只返回 HTML 字符串，无 UI 交互。

### 4.4 本地术语提取

fanyi-extension 使用 `compromise` NLP 库：
- 提取专有名词（人名/公司/产品）
- 识别技术术语
- 支持用户手动添加/删除

vocal-saga 的 `glossaryExtractor` 虽然存在，但 `glossaryStore` 只支持手动管理。

---

## 五、vocal-saga 独有的优势

### 5.1 无需安装

- 扩展需要用户手动安装（Chrome Web Store / Firefox Add-ons）
- Worker 直接通过 URL 访问（`/translate/example.com`）

### 5.2 跨平台

- 扩展只能在桌面浏览器运行（iOS 无扩展支持）
- Worker 可通过任何 HTTP 客户端访问（移动浏览器、curl、API）

### 5.3 服务端渲染

- 扩展：翻译结果留在客户端，无法分享
- Worker：返回完整 HTML，可被搜索引擎索引、可分享

### 5.4 D1 持久化

- 扩展：翻译结果仅存在本地（换设备丢失）
- Worker：翻译结果存入 D1（跨设备、跨会话可用）

### 5.5 强制刷新

- 扩展：无法强制重新翻译（只能恢复后重新翻译）
- Worker：`/force/*` 路由支持强制重新翻译并覆盖缓存

---

## 六、代码复用情况

两个项目 **共享的核心模块**：

| 模块 | fanyi-extension 路径 | vocal-saga 路径 | 差异 |
|------|-----|------|------|
| blockExtractor | `src/entrypoints/utils/blockExtractor/` | `lib/translate/blockExtractor/` | 基本一致 |
| chunkBuilder | `src/entrypoints/utils/chunkBuilder.ts` | `lib/translate/chunkBuilder.ts` | 基本一致 |
| contentHelper | `src/entrypoints/utils/contentHelper.ts` | `lib/translate/contentHelper.ts` | vocal-saga 多了 contentDetector |
| translationDisplay | `src/entrypoints/utils/translationDisplay.ts` | `lib/translate/translationDisplay.ts` | vocal-saga 多了 ownerDocument 兼容 |
| chunkRetry | `src/entrypoints/utils/chunkRetry.ts` | `lib/translate/chunkRetry.ts` | 基本一致 |
| cacheManager | `src/entrypoints/utils/cacheManager.ts` | `lib/translate/cacheManager.ts` | vocal-saga 多了 LRU |
| glossaryExtractor | `src/entrypoints/utils/glossaryExtractor.ts` | 未使用 | vocal-saga 不引入 compromise |

**结论**：核心翻译逻辑（提取 → 分块 → 翻译 → 重试）已完全复用，差异主要在 I/O 层（DOM 操作 vs HTML 序列化）。

---

## 七、优化建议

### 7.1 vocal-saga 可以从扩展借鉴

1. **warmup 翻译队列**：前 2 个 chunk 串行，后续并行（当前固定并发 6）
2. **术语提取**：考虑引入轻量级 NLP（或调用 API）支持本地术语提取
3. **翻译进度**：SSE/WebSocket 流式返回翻译进度（当前全量返回）

### 7.2 扩展可以从 vocal-saga 借鉴

1. **智能内容检测**：contentDetector 评分算法（扩展的 ARTICLE_SELECTORS 不够全面）
2. **LRU 缓存淘汰**：避免内存无限增长
3. **/force 路由**：支持强制重新翻译

### 7.3 共同优化

1. **统一术语提取**：将 glossaryExtractor 抽象为共享模块
2. **统一缓存策略**：KV 命名空间 + TTL 策略保持一致
3. **统一错误分类**：`categorizeError` 逻辑可复用

---

*分析完毕。两个项目的架构差异本质上是 **客户端 vs 服务端** 的差异：扩展运行在浏览器中，可以操作 live DOM；Worker 运行在 Edge，只能处理静态 HTML。核心翻译逻辑已完全复用。*
