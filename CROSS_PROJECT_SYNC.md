# fanyi-extension 与 vocal-saga 逻辑同步参考

> **目的**：列出两个项目在翻译逻辑上**功能一致**的模块，作为后续更新相关功能时需要同步增改的参考。
>
> **范围**：仅覆盖翻译核心逻辑（DOM 提取、分块、缓存、翻译服务、站点规则、内容检测）。不覆盖项目特有的入口（background/content/popup、worker/routes）。
>
> **更新日期**：2026-06-25

## 项目定位

| 项目 | 定位 | DOM 环境 |
|------|------|----------|
| **fanyi-extension** | 浏览器扩展（WXT + Vue 3） | 真实浏览器 DOM（Chrome / Firefox） |
| **vocal-saga** | 服务端翻译（Cloudflare Workers / Netlify Functions） | linkedom / jsdom 解析的 HTML 字符串 |

## 文件路径对照

| 模块 | fanyi-extension | vocal-saga |
|------|-----------------|------------|
| blockExtractor | `src/entrypoints/utils/blockExtractor/` | `lib/translate/blockExtractor/` |
| cacheKey | `src/entrypoints/utils/cacheKey.ts` | `lib/translate/cacheKey.ts` |
| cacheManager | `src/entrypoints/utils/cacheManager.ts` | `lib/translate/cacheManager.ts` |
| chunkBuilder | `src/entrypoints/utils/chunkBuilder.ts` | `lib/translate/chunkBuilder.ts` |
| chunkRetry | `src/entrypoints/utils/chunkRetry.ts` | `lib/translate/chunkRetry.ts` |
| contentDetector | `src/entrypoints/utils/contentDetector.ts` | `lib/translate/contentDetector.ts` |
| contentHelper | `src/entrypoints/utils/contentHelper.ts` | `lib/translate/contentHelper.ts` |
| glossaryExtractor | `src/entrypoints/utils/glossaryExtractor.ts` | `lib/translate/glossaryExtractor.ts` |
| translateApi | `src/entrypoints/utils/translateApi.ts` | `lib/translate/translateApi.ts` |
| translationDisplay | `src/entrypoints/utils/translationDisplay.ts` | `lib/translate/translationDisplay.ts` |
| translationQueue | `src/entrypoints/utils/translationQueue.ts` | `lib/translate/translationQueue.ts` |
| tech-products.json | `src/entrypoints/utils/tech-products.json` | `lib/translate/tech-products.json` |
| service/_service | `src/entrypoints/service/_service.ts` | `lib/translate/service/_service.ts` |
| service/deepseek | `src/entrypoints/service/deepseek.ts` | `lib/translate/service/deepseek.ts` |
| service/streamParser | `src/entrypoints/service/streamParser.ts` | `lib/translate/service/streamParser.ts` |
| rules/ | `src/rules/` | `lib/translate/rules/` |
| 测试 | `src/__tests__/*.test.ts` | `tests/*.test.ts` |

---

## 一、完全一致（必须同步）

修改这些文件时，**必须**同步到另一个项目，保持逻辑完全一致。

### 1. `cacheKey.ts`
- `simpleHash(str)` — 字符串哈希函数
- `generateTranslationCacheKey(jsonContent, sourceLang, targetLang)` — 缓存 key 生成
- **完全一致**，无差异

### 2. `chunkRetry.ts`
- `shouldRetryChunk(chunk, missingCount, isRetry)` — chunk 翻译重试策略
- **完全一致**，无差异

### 3. `translationQueue.ts`
- `TranslationQueue` 类 — 并发控制 + 重试队列
- **完全一致**，无差异

### 4. `service/_service.ts`
- `Glossary`、`GlossaryEntry`、`TranslationService` 接口
- **完全一致**，无差异

### 5. `service/streamParser.ts`
- `parseSSELine`、`extractDeltaContent`、`parseSSEStream` — SSE 流解析
- **完全一致**，无差异

### 6. `glossaryExtractor.ts`
- `extractGlossaryLocal(blocks)` — 术语表提取
- 依赖 `tech-products.json`（也完全一致）
- **完全一致**，无差异

### 7. `tech-products.json`
- 已知技术产品 / 出版物列表
- **完全一致**，无差异

### 8. 站点规则（共用部分）
以下规则文件**完全一致**，修改时必须同步：
- `rules/github-rules.ts`
- `rules/fortune-rules.ts`
- `rules/hackernews-rules.ts`
- `rules/reddit-rules.ts`

### 9. `blockExtractor/constants.ts`（静态数据部分）
以下常量**完全一致**：
- `MIN_TEXT_LENGTH`、`MAX_TEXT_LENGTH`、`XHTML_NAMESPACE`
- `PATTERNS`（TUPLE、BASE64、UI_TEXT、DIGIT_SPACE、HEADING）
- `DIRECT_SET`、`SKIP_SET`、`SEMANTIC_SKIP_TAGS`、`INLINE_SET`
- `SKIP_CLASS_PATTERNS`
- `METADATA_TOKENS`
- `ARTICLE_CONTAINER_CLASS_PATTERNS`
- `WalkerCounters` 接口、`createCounters()`

### 10. `blockExtractor/types.ts`（核心字段）
`TextBlock` 接口的核心字段一致：
- `id`、`xpath`、`tag`、`text`、`context`

### 11. `contentDetector.ts`（核心排除逻辑）
以下逻辑**必须同步**：
- `CONSENT_SDK_ID_RE`、`CONSENT_SDK_CLASS_RE` 正则表达式
- `isConsentSdkContainer(el)` 函数
- `collectCandidates` 中的 consent SDK 排除
- `detectArticleRoot` 末尾的 consent SDK 防御性校验
- `POSITIVE_ID_RE`、`NEGATIVE_CONTAINER_ID_RE`、`META_ID_RE`

### 12. `contentHelper.ts`（文章根节点选择）
以下逻辑**必须同步**：
- `ARTICLE_SELECTORS` 列表
- `refineArticleRoot(candidate)` — 向上扩展到 `<article>` 以包含标题
- `expandIfFragmented(refined)` — 碎片内容自动扩展
- `hasValidHeadingOutside`、`hasMeaningfulContent`

### 13. `translateApi.ts`（公共 API）
- `getCachedTranslation(cacheKey)` — 读缓存
- `cacheTranslation(cacheKey, data)` — 写缓存（7 天 TTL）
- `processTranslationResult(jsonResult)` — 解析翻译结果（兼容 `text` / `translated_text` / `translation` 字段）

### 14. `translationDisplay.ts`
- `applyBlockTranslation(node, translatedText)` — 双语对照渲染
- `restoreBlock(node)` — 还原原文
- `TranslationMode` 类型

---

## 二、逻辑一致但实现有差异（同步时需注意适配）

修改这些模块时，**核心逻辑**需要同步，但**实现细节**需要根据运行环境适配。

### 1. `blockExtractor/walker.ts`
- **一致**：acceptNode 判定逻辑、grabNode 块提取、headingPath 维护、Shadow DOM 处理
- **差异**：
  - fanyi-extension 用 `document.createTreeWalker`（真实浏览器 API）
  - vocal-saga 用手写递归（linkedom 的 TreeWalker 不支持 acceptNode 回调）
- **同步建议**：谓词逻辑（shouldSkip*、is*）改动必须同步；遍历框架不需要同步

### 2. `blockExtractor/rules.ts`
- **一致**：`shouldSkipByClass`、`isMetadataClass`、`isElementHidden`、`isNonHTMLNamespace`、`isValidText`、`isInsideArticle`、`hasBlockLevelParent`、`classifyChildren`、`isContentEditable`、`hasTranslateBlockClass`
- **差异**：
  - fanyi-extension 多了 `isAdBySize`、`isAdIframe`、`isCookieBannerByText`、`isLowPriorityElement`（依赖 `getComputedStyle` / `getBoundingClientRect`，服务端不可用）
  - `isOverlayElement` 实现不同（见下）
- **同步建议**：纯 DOM 属性判定的谓词必须同步；依赖 layout 的谓词不需要同步

### 3. `isOverlayElement`（在 `blockExtractor/rules.ts`）
- **一致**：识别 cookie / consent / modal / popup / overlay / dialog / backdrop / lightbox / paywall
- **差异**：
  - fanyi-extension 用 `OVERLAY_PATTERNS` 数组 + `matchSelectorRule`，含 `styleCheck`（fixed/sticky 定位），且 `article/main` 内部的容器返回 false
  - vocal-saga 用 `OVERLAY_PATTERNS.classTokens` / `idTokens` / `roles`，含 `position:fixed` + `hasOverlayHint` 辅助判定
- **同步建议**：token 列表必须同步；定位检测逻辑根据环境适配

### 4. `blockExtractor/constants.ts`（动态噪声检测部分）
- **仅 fanyi-extension 有**：
  - `COOKIE_BANNER_TEXT_PATTERNS` — Cookie Banner 文本关键词
  - `AD_IFRAME_PATTERNS` — 广告 iframe src 域名
  - `AD_SIZE_PATTERNS` — 标准广告位尺寸
  - `POPUP_STYLE_DETECTION` — 弹窗 style 特征阈值
  - `DYNAMIC_NOISE_CONTAINER_TAGS` — 需要动态检测的容器标签
- **原因**：这些依赖 `getComputedStyle` / `getBoundingClientRect` / `contentWindow`，服务端不可用
- **同步建议**：不需要同步到 vocal-saga

### 5. `chunkBuilder.ts`
- **一致**：`Chunk` 接口、`buildJsonContent`、`isStructuralBoundary`、`buildChunks` 主流程
- **差异**：
  - `TARGET_TOKENS`：fanyi-extension=800，vocal-saga=10000
  - `WARMUP_TARGET_TOKENS`：仅 fanyi-extension 有（=400）
  - `estimateTokens`：fanyi-extension 用 `text.length / 4`，vocal-saga 用 CJK 感知算法
- **同步建议**：接口和分块边界逻辑必须同步；token 估算和目标值根据环境适配（扩展端 chunk 小以降低单次失败影响，服务端 chunk 大以提升吞吐）

### 6. `cacheManager.ts`
- **一致**：`CacheEntry<T>` 接口、`CacheManager` 类公共 API（`get` / `set` / `remove` / `clear` / `getStats`）、TTL 逻辑
- **差异**：
  - fanyi-extension 用 `@wxt-dev/storage`（所有 key 存在同一个大对象下，O(N) 序列化）
  - vocal-saga 用跨平台 storage（Netlify Blobs / Cloudflare KV / 内存，每个 key 独立存储，O(1) 读写）
- **同步建议**：公共 API 和 TTL 策略必须同步；存储层实现不需要同步

### 7. `service/deepseek.ts`
- **一致**：`API_URL`（`https://api.deepseek.com/v1/chat/completions`）、`MODEL`（`deepseek-v4-flash`）、`USER_ID`（`fanyi-extension`）、`TRANSLATION_TEMPERATURE`（0.1）
- **差异**：
  - fanyi-extension 直接构建 body，含 `estimateMaxTokens` 函数
  - vocal-saga 用 `shared.ts` 的 `buildTranslationBody`，body 含 `response_format` / `thinking` / `stream` 字段
- **同步建议**：模型 / URL / USER_ID / temperature 必须同步；body 构建和 token 估算根据服务能力适配

### 8. `contentDetector.ts`（评分算法）
- **一致**：consent SDK 排除、候选收集、防御性校验
- **差异**：
  - fanyi-extension 是 v2 评分模型（绝对分数排名 + structure boost + container penalty + sibling normalization + depth normalization）
  - vocal-saga 是 Text Density 评分（`density = (bodyTextLength / (linkCount + 1)) * log(textLength + 1)`）
- **同步建议**：排除逻辑必须同步；评分公式不需要同步（两边都在迭代）

### 9. `contentHelper.ts`（prepareDocument）
- **一致**：`findArticleRoot`、`refineArticleRoot`、`expandIfFragmented`
- **差异**：
  - fanyi-extension 的 `prepareDocument` 调用 `hideBodyOverlays`（隐藏文章根节点外的 body 层级弹窗）
  - vocal-saga 不需要 `hideBodyOverlays`（服务端不渲染页面，无遮挡问题）
  - L3 兜底：fanyi-extension 直接返回 `doc.body`，vocal-saga 有 `findArticleRootL3`
  - `extractBlocks` 签名：fanyi-extension 不传 pageUrl，vocal-saga 传 pageUrl
- **同步建议**：文章根节点选择逻辑必须同步；`hideBodyOverlays` 不需要同步到 vocal-saga

### 10. `rules/types.ts`
- **一致**：`SiteRule` 接口字段完全一致（含 `documentTerms?: string[]`）
- **历史**：fanyi-extension 曾缺少 `documentTerms` 字段声明（实际代码已使用），已修复

### 11. `rules/index.ts`
- **一致**：`matchSiteRule(url)` 函数、`hostMatches` 函数
- **差异**：vocal-saga 多了 `arxivRule`
- **同步建议**：新增站点规则时考虑两边是否都需要

### 12. `blockExtractor/types.ts`（扩展字段）
- **差异**：vocal-saga 的 `TextBlock` 多了 `renderHint?: { inlineCandidate?: boolean }` 字段
- **同步建议**：如果 fanyi-extension 也需要 inline 翻译提示，可以同步此字段

---

## 三、项目特有（不需要同步）

### fanyi-extension 特有
- `src/entrypoints/background.ts` — 扩展后台
- `src/entrypoints/content.ts` — 内容脚本入口
- `src/entrypoints/content/` — chunkTranslation、configPanel、floatingButton、serverTranslation、statusOverlay、styles、translation、translationTypes、translationUtils
- `src/entrypoints/popup/` — Vue 3 配置 UI
- `src/entrypoints/utils/config.ts` — `@wxt-dev/storage` 配置
- `src/entrypoints/utils/domObserver.ts` — DOM 变化监听
- `src/entrypoints/utils/common.ts`、`constants.ts` — 扩展常量
- `hideBodyOverlays`（在 contentHelper.ts 中）— 浏览器端遮挡元素隐藏

### vocal-saga 特有
- `src/worker.ts` — Cloudflare Workers 入口
- `netlify/functions/api.mjs` — Netlify Functions 入口
- `lib/app.ts`、`auth.ts`、`config.ts`、`modelResolver.ts`、`redirectGuard.ts`、`urlUtils.ts` — 服务端路由 / 鉴权
- `lib/storage/` — 跨平台存储适配（cloudflare / netlify / memory）
- `lib/translate/service/cloudflare.ts`、`mimo.ts`、`nvidia.ts`、`openrouter.ts`、`shared.ts` — 其他翻译服务
- `lib/translate/service/shared.ts` — `buildTranslationBody`、`repairTruncatedJson`、`cleanJsonString`
- `lib/translate/glossaryStore.ts` — 术语表持久化
- `lib/translate/pipeline.ts` — 翻译流水线
- `lib/translate/urlFetcher.ts` — URL 抓取
- `lib/translate/rules/arxiv-rules.ts` — arxiv 站点规则
- `findArticleRootL3`（在 contentHelper.ts 中）— 服务端 L3 兜底

---

## 四、同步检查清单

修改以下内容时，**必须**检查另一个项目是否需要同步：

### 内容检测
- [ ] `CONSENT_SDK_ID_RE` / `CONSENT_SDK_CLASS_RE` 正则
- [ ] `isConsentSdkContainer` 逻辑
- [ ] `ARTICLE_SELECTORS` 列表
- [ ] `refineArticleRoot` / `expandIfFragmented` 逻辑
- [ ] `POSITIVE_ID_RE` / `NEGATIVE_CONTAINER_ID_RE` / `META_ID_RE`

### Block 提取
- [ ] `DIRECT_SET` / `SKIP_SET` / `SEMANTIC_SKIP_TAGS` / `INLINE_SET`
- [ ] `SKIP_CLASS_PATTERNS`
- [ ] `METADATA_TOKENS`
- [ ] `ARTICLE_CONTAINER_CLASS_PATTERNS`
- [ ] `MIN_TEXT_LENGTH` / `MAX_TEXT_LENGTH`
- [ ] `PATTERNS`（TUPLE、BASE64、UI_TEXT、DIGIT_SPACE、HEADING）
- [ ] `shouldSkipByClass` / `isMetadataClass` / `isElementHidden` 等谓词
- [ ] `classifyChildren` / `isValidText` / `isInsideArticle`

### 翻译服务
- [ ] DeepSeek `API_URL` / `MODEL` / `USER_ID` / `TRANSLATION_TEMPERATURE`
- [ ] `Glossary` / `TranslationService` 接口
- [ ] SSE 流解析逻辑

### 缓存
- [ ] `simpleHash` / `generateTranslationCacheKey`
- [ ] 缓存 TTL（7 天）
- [ ] `processTranslationResult` 字段兼容（`text` / `translated_text` / `translation`）

### 站点规则
- [ ] `github-rules.ts` / `fortune-rules.ts` / `hackernews-rules.ts` / `reddit-rules.ts`
- [ ] `SiteRule` 接口字段（特别是 `documentTerms`）
- [ ] `matchSiteRule` 函数

### 术语表
- [ ] `extractGlossaryLocal` 逻辑
- [ ] `tech-products.json`

### 渲染
- [ ] `applyBlockTranslation` / `restoreBlock`
- [ ] `TranslationMode` 类型

---

## 五、已知差异（设计性，无需统一）

1. **`chunkBuilder.ts` 的 `TARGET_TOKENS` 和 `estimateTokens` 差异**
   - fanyi-extension: `TARGET_TOKENS=800`，`estimateTokens=text.length/4`
   - vocal-saga: `TARGET_TOKENS=10000`，`estimateTokens` CJK 感知
   - 这是有意为之的设计差异：扩展端 chunk 小以降低单次失败影响，服务端 chunk 大以提升吞吐

2. **`contentDetector.ts` 的评分算法差异**
   - fanyi-extension: v2 评分模型（绝对分数排名 + structure boost + container penalty + sibling normalization + depth normalization）
   - vocal-saga: Text Density 评分（`density = (bodyTextLength / (linkCount + 1)) * log(textLength + 1)`）
   - 两边都在独立迭代，不需要统一

3. **`isOverlayElement` 实现差异**
   - fanyi-extension 用 `OVERLAY_PATTERNS` 数组 + `matchSelectorRule`，含 `styleCheck`（fixed/sticky 定位），且 `article/main` 内部的容器返回 false
   - vocal-saga 用 `OVERLAY_PATTERNS.classTokens` / `idTokens` / `roles`，含 `position:fixed` + `hasOverlayHint` 辅助判定
   - 两边 token 列表已对齐，实现方式根据环境适配
   - 如果发现新的 overlay 模式，需要两边同步 token
