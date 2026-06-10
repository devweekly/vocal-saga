# 翻译代理服务 — 架构设计

> 个人用，目标是：粘贴 URL 或粘贴文本，一键得到忠实、保留结构的双语结果。
> 本文为第二版（2026-06），参考 `fanyi-extension` 的浏览器扩展实现做了重构。

## 0. 项目现状

| 模块 | 路径 | 状态 |
|---|---|---|
| LLM 代理 | `netlify/functions/api.mjs` | 已支持 DeepSeek / Cloudflare / NVIDIA / OpenRouter，`Bearer AUTH_KEY` 认证 |
| 翻译核心（lib） | `lib/translate/` | 从 fanyi-extension 移植并适配 Netlify |
| 翻译路由 | `netlify/functions/api.mjs` | `/api/translate/*` |
| 前端 | `public/translate.html` `public/paste.html` | 极简表单 |
| 参考实现 | `_ref_only/deepseek.ts` `fanyi-extension` | 不再是参考，就是源码 |

---

## 1. 核心设计原则

源自 `fanyi-extension` 在真实页面上踩过的坑，逐条对照：

1. **不让 LLM 输出 HTML** — 必然丢标签 / 错位 / markdown 乱。
   改为：DOM 抽取文本块 → LLM 翻译（只返 JSON）→ 回填 DOM。
2. **批量翻译** — 一个 chunk 一次请求。绝不开 1000 次 LLM。
3. **必须缓存** — URL 整页缓存 + block 精细缓存。**这是省钱的关键**。
4. **保留结构** — 抽 `<h1>/h2/h3/p/li/blockquote/code/pre>` 各自成块，按 DOM 顺序回填。
5. **glossary 整表注入 system prompt 头部** — 不要 per-chunk 过滤 glossary，会破坏 KV cache。
6. **串行请求（concurrency=1）** — DeepSeek KV cache 在第二个起飞的请求上才能命中；并行 4 个请求同 prefix 同时打过去会全 miss。
7. **chunk size 故意小** — TARGET_TOKENS=800，前 2 块 WARMUP_TARGET_TOKENS=400。钱不是问题，**命中率才是问题**。
8. **block ID 稳定** — `<tag>-<n>` 格式，LLM 容易回传对。
9. **三种字段名都接受** — LLM 可能返 `text` / `translated_text` / `translation`，硬编码 `translated_text` 会让 result 是空。
10. **missing 自动重试** — 模型偶尔少返几个 block，单挑出来再翻译一次（`_retry` chunk，bypass 缓存）。

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────┐ │
│  │ 粘贴文本翻译    │  │ URL 翻译表单     │  │ 术语表 UI  │ │
│  └────────┬────────┘  └────────┬─────────┘  └─────┬──────┘ │
└───────────┼─────────────────────┼──────────────────┼───────┘
            │                     │                  │
            ▼                     ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│              Netlify Functions (Express, api.mjs)            │
│                                                              │
│   /api/translate/text      纯文本批量翻译                    │
│   /api/translate/blocks    接收 block 数组                  │
│   /api/translate/url       URL 抓取 + 翻译 + 返回 HTML       │
│   /api/glossary            术语表 CRUD                       │
│                                                              │
│   ┌──────────── lib/translate/ ──────────────────────────┐  │
│   │                                                        │  │
│   │  blockExtractor/   ← fanyi-extension 移植（jsdom）    │  │
│   │     constants.js       SKIP_CLASS_PATTERNS / DIRECT   │  │
│   │                         SET / 块抽取规则              │  │
│   │     walker.js          TreeWalker 抽块（带规则过滤）  │  │
│   │     rules.js           谓词：isMetadataClass 等       │  │
│   │     index.js           collectBlocks 入口             │  │
│   │                                                        │  │
│   │  chunkBuilder.js   ← TARGET=800 / WARMUP=400 / 边界切  │  │
│   │  chunkRetry.js     ← 缺失 block 单挑重试              │  │
│   │  translationQueue  ← concurrency=1 串行保 KV cache   │  │
│   │  cacheKey.js       ← simpleHash 缓存键                │  │
│   │  cacheManager.js   ← Netlify Blobs 适配（替换 WXT）   │  │
│   │  translateApi.js   ← 调翻译服务（经现有 LLM 代理）    │  │
│   │  prompt.js         ← batch 翻译 prompt 模板          │  │
│   │  urlFetcher.js     ← 服务端 fetch + jsdom 抽块        │  │
│   │  applyTranslation.js ← cheerio 回填 DOM + 双语 CSS   │  │
│   │  pipeline.js       ← 串联以上模块                     │  │
│   └────────────────────────────────────────────────────────┘  │
│                                                              │
│   已有 LLM 代理 (api.mjs) ← translateApi 调本机自环         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
               DeepSeek / Cloudflare / NVIDIA / OpenRouter
```

**关键决策**：
- 翻译服务**不直接**调 DeepSeek，而是**调现有 `/api/v1/chat/completions` 代理** — 复用多后端路由 + 认证
- DOM 解析**不**用 Readability（只适合单篇文章），改用 TreeWalker 全页抽块 — 同一个 pipeline 既能翻单篇文章，也能翻工具页 / 文档
- 浏览器相关代码用 `jsdom` 在 Node 端重放；DOM 写回用 `cheerio`（比 jsdom 快 10×）

---

## 3. 端点设计

### 3.1 `POST /api/translate/text`

**请求：**
```json
{
  "text": "Hello world. This is a test.",
  "source": "en",
  "target": "zh",
  "glossary_id": "tech-blog"
}
```

**响应：**
```json
{
  "translated": "你好世界。这是一段测试。",
  "model": "deepseek-v4-flash",
  "tokens_in": 12,
  "tokens_out": 8,
  "cache_hit": false,
  "duration_ms": 842
}
```

### 3.2 `POST /api/translate/blocks`

**请求：**
```json
{
  "blocks": [
    { "id": "h1-0", "tag": "h1", "text": "The Future of AI" },
    { "id": "p-1",  "tag": "p",  "text": "Large language models..." }
  ],
  "source": "en",
  "target": "zh",
  "glossary_id": "tech-blog"
}
```

**响应：**
```json
{
  "translations": [
    { "id": "h1-0", "translated_text": "AI 的未来" },
    { "id": "p-1",  "translated_text": "大语言模型..." }
  ],
  "model": "deepseek-v4-flash",
  "usage": { "prompt_tokens": 350, "completion_tokens": 120, "cached_tokens": 320 },
  "cache_hit": false
}
```

### 3.3 `POST /api/translate/url`

**请求：**
```json
{
  "url": "https://example.com/article",
  "source": "auto",
  "target": "zh",
  "glossary_id": "tech-blog"
}
```

**响应：** `Content-Type: text/html`，直接是双语对照页面（见 §6）。

**流程：**
```
fetch(url)
  → jsdom 解析（保留 <script> 关闭、<link> 保留，cheerio 操作）
  → blockExtractor.collectBlocks() 抽块（走 SKIP/DIRECT/METADATA 规则）
  → chunkBuilder.buildChunks() 切 chunk（≤ 800 token / 块，h1-h6 必切边界）
  → for each chunk:
       cacheKey → Netlify Blobs 命中？
         yes: 直接用
         no:  translationQueue.add(() => translateService.translate(chunk))
              翻译完 → 写回 Blobs
              diffMissing → 有缺失就 buildRetryChunk → 再翻译一次
  → applyTranslation(html, blocks, translations) 用 cheerio 回填
  → 注入双语 CSS
  → 返回 HTML
```

### 3.4 `/api/glossary`（CRUD）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/glossary` | 列表 |
| `GET` | `/api/glossary/:id` | 单条 |
| `PUT` | `/api/glossary/:id` | 整体覆盖 |
| `DELETE` | `/api/glossary/:id` | 删除 |

存 Netlify Blobs，单 key 一段 JSON：
```json
{
  "id": "tech-blog",
  "entries": [
    { "term": "transformer", "translation": "Transformer" },
    { "term": "fine-tuning", "translation": "微调" }
  ]
}
```

---

## 4. 块抽取（最关键的部分）

直接从 `fanyi-extension/src/entrypoints/utils/blockExtractor/` 移植。**这是整个项目的核心** — 抽不好，后面全废。

### 4.1 抽块规则

`constants.js` 定义四个集合：

```js
// 直接抽为翻译块的标签
const DIRECT_SET = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'li', 'blockquote', 'figcaption', 'td', 'th', 'caption',
])

// 跳过整棵子树（脚本、样式、嵌入内容）
const SKIP_SET = new Set([
  'script', 'style', 'noscript', 'svg', 'canvas', 'video', 'audio',
  'iframe', 'object', 'embed', 'map', 'area',
])

// 内联标签 — 自身不抽，向上找祖先 block
const INLINE_SET = new Set([
  'a', 'span', 'em', 'strong', 'b', 'i', 'u', 'small', 'sub', 'sup',
  'code', 'kbd', 'mark', 'abbr', 'cite', 'q', 'time',
])

// 语义容器 — 整棵子树拒绝（header/footer/nav/aside）
const SEMANTIC_SKIP = new Set(['header', 'footer', 'nav', 'aside', 'dialog', 'menu'])
```

### 4.2 跨站通用 skip class 列表

fanyi-extension 维护的 ~200 条规则（`SKIP_CLASS_PATTERNS`），覆盖：
- 弹窗 / cookie 横幅 / GDPR / 隐私声明
- 广告（ad-*, sponsored, dfp-ad, taboola, outbrain …）
- 分享按钮 / 社交图标
- 相关推荐 / 热门 / inline carousel
- 评论 / 搜索框 / 分页 / 目录 / 语言切换
- 文章底部挂件
- 评分 / 调查 / 验证码

**整棵子树命中 → 拒绝**（不只是这个 class 元素）。例：`.advertisement` 包整段广告，**整段不翻**。

### 4.3 元数据 token（author / date / category）

```js
const METADATA_TOKENS = new Set(['meta', 'author', 'byline', 'category', 'categories', 'dateline'])
```

**整词分割匹配**（split on `[_\-\s]`），不是子串：
- `post-meta-info` → `['post','meta','info']` → 命中 `meta` → 跳过 ✓
- `authorship` → `['authorship']` → 不命中 → 保留 ✓

### 4.4 TreeWalker 抽块主流程

```js
const walker = document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
  acceptNode: (node) => acceptWalkerNode(node, rejectedCache),
})

while (node = walker.nextNode()) {
  const translateNode = grabNode(node)   // inline 向上找 DIRECT 祖先
  if (!translateNode) continue
  const text = translateNode.textContent.trim()
  if (!text) continue
  if (seenTexts.has(text)) continue       // 跨 callout 去重（HBR summary box + body 同段）
  blocks.push({
    id: `b${++counter}`,
    xpath: getXPath(translateNode),       // data attr 丢了回退用
    tag: translateNode.tagName.toLowerCase(),
    text,
    context: { headingPath: getHeadingPath(translateNode) }
  })
}
```

`grabNode(node)` 关键逻辑：
- `DIRECT_SET` 命中 → 返回自身
- `INLINE_SET` 命中 → 向上找 DIRECT 祖先（保留链接/格式语义）
- 其他元素 → 跳过，让 walker 继续

### 4.5 Shadow DOM 跨边界

`TreeWalker` 不跨 shadow root。手动遍历 host：

```js
function collectFromShadowHosts(root, blocks, ...) {
  const treeWalker = document.createTreeWalker(root, SHOW_ELEMENT, { acceptNode: () => ACCEPT })
  let node
  while (node = treeWalker.nextNode()) {
    if (node.shadowRoot?.mode === 'open') {
      collectBlocks(node.shadowRoot, blocks, ...)
    }
  }
}
```

`Reddit <shreddit-post>` 等场景必须。

### 4.6 DOM 回填（服务端，cheerio）

```js
$('h1, h2, h3, p, li, blockquote, figcaption, td, th, caption').each((i, el) => {
  const $el = $(el)
  const id = $el.attr('data-fanyi-block-id')
  if (!id) return
  const translated = translationMap.get(id)
  if (!translated) return

  // 保留原 children（链接 / 强调 / 行内格式）→ 移入 .fanyi-original
  const $orig = $('<span class="fanyi-original"></span>')
  while ($el[0].firstChild) $orig[0].appendChild($el[0].firstChild)

  const $trans = $('<span class="fanyi-translation"></span>').text(translated)
  $el.empty().append($orig).append($trans)
})
```

**关键：保留原始 DOM 子节点**，不要 `$el.text(translated)` — 那会清掉 `<a>`、`<em>` 等。

---

## 5. Chunk 切分

```js
const TARGET_TOKENS = 800            // 主流 chunk 大小
const WARMUP_TARGET_TOKENS = 400     // 前 2 块（小一点，让 KV cache 渐入）
const MAX_INPUT_TOKENS = 500000      // 安全阀

function isBoundary(block) { return /^h[1-6]$/.test(block.tag) }

for (block of blocks) {
  const tokens = estimate(block.text) + 20    // 20 = JSON 包装开销

  if (currentTokens + tokens > MAX) flush()
  else if (currentTokens + tokens > TARGET) {
    if (isBoundary(block)) flush()         // 标题必切边界
    else {
      const next = findNextBoundary(blocks, i)
      if (next && next - i < 5) {          // 5 块内有 h1-h6 → 一起切
        for (j=i; j<=next; j++) push(blocks[j])
        flush()
      } else flush()
    }
  } else push(block)
}
```

**为什么 WARMUP=400**：DeepSeek KV cache 第二个请求才开始命中；前 2 块故意小一点，命中率提升幅度 > 翻译成本。

---

## 6. 缓存策略（三层）

### 6.1 L1 — URL 整页缓存

- Key: `sha256(url + target + glossary_id)`
- Value: 完整 HTML 响应
- TTL: 永久（手动 invalidation）
- 命中：直接返回，**零 LLM 调用**

### 6.2 L2 — Block 精细缓存

- Key: `simpleHash(text) + first200CharsHash + source + target + glossary_id`
- Value: 单条译文（`{ id, translated_text }`）
- 命中：chunk 内 99% 命中 → 只翻译 1 块 → 1 次 LLM

### 6.3 L3 — Glossary

- Key: glossary_id
- Value: `{ entries: [{ term, translation }] }`
- 注入 system prompt 头部；切换 glossary_id 才换 prompt prefix

### 6.4 失效

- 改 `glossary_id` → L1 / L2 全失效（合理：新术语可能影响所有译文）
- 改 `target` → L1 失效，L2 只在 `(text, source, target, glossary)` 完全一致时命中
- 改 `url` → L1 失效（key 变了），L2 可能仍命中

**实现**：Netlify Blobs，store 名 `translations` / `glossaries` / `pages`。

---

## 7. 翻译服务（核心循环）

### 7.1 Prompt 模板

`prompt.js`：

```js
const SYSTEM_PROMPT = `你是一个专业翻译。将以下 JSON 数组中的每条文本从 {source} 翻译成 {target}。

严格规则:
1. 输出**仅**为 JSON 格式: {"translations":[{"id":"<原id>","translated_text":"<译文>"}]}
2. id 必须**逐字**保留输入的 id,不可省略、不可改名
3. 不可翻译为空字符串
4. 保留专有名词、技术术语、数字、标点
5. 术语表（glossary）中的硬性术语必须使用指定译文

{glossaryBlock}
{sitePrompt}`

const USER_PROMPT = `JSON:\n\n{blocksJson}`
```

### 7.2 LLM 调用参数（与 _ref_only/deepseek.ts 对齐）

```js
{
  model: 'deepseek-v4-flash',
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: USER_PROMPT },
  ],
  response_format: { type: 'json_object' },
  temperature: 0.1,                 // 翻译要稳
  max_tokens: estimateMaxTokens(blocksJson),    // max(1024, estTokens*5*2)
  user_id: 'vocal-saga-translate', // 标识来源（DeepSeek 后台统计用）
  thinking: { type: 'disabled' },   // DeepSeek 特定：关闭思考省钱
  stream: false
}
```

**关键：经由 `/api/v1/chat/completions` 代理调用**，不直连 DeepSeek — 复用多后端路由。

### 7.3 响应解析（宽容）

```js
// 模型可能用 text / translated_text / translation 中的任意一个
const translated =
  item.translated_text ?? item.text ?? item.translation ?? null
```

**硬编码 `translated_text` 会让 result Map 是空** — fanyi-extension 真实踩过。

### 7.4 缺失重试

```js
const missingIds = inputIds.filter(id => !outputIds.has(id))
if (shouldRetryMissing({ missingCount: missingIds.length, isRetry: false })) {
  const retryChunk = buildRetryChunk(parentChunk, missingIds)
  const retryResult = await translateService.translate(retryChunk, ...)
  // 合并 retryResult 到 result Map
}
```

`buildRetryChunk` 重新序列化 jsonContent（**与 parent 不同**），bypass 缓存，触发全新 API 调用。

### 7.5 不变块检测

```js
if (translated === original) {
  console.warn('Block', id, 'came back unchanged — LLM refused / no-op')
}
```

`logUnchangedBlocks` 在响应解析后跑一遍，全 unchange 时报错（prompt 失效 / 内容过滤）。

---

## 8. 串行队列

```js
class TranslationQueue {
  constructor(concurrency = 1, maxRetries = 2) { ... }
  async add(task) { ... }
}
```

**为什么 concurrency=1**：DeepSeek KV cache 命中是顺序敏感的 — 第二个起的请求（系统 prompt 拼好后）会命中第一个请求的 prefix。**4 个 chunk 并行** → 全 miss → 成本 × 4。

Phase 5 可选：等前 N 块顺序跑完（warmup），后续用更高并发吃 prefix 命中。

---

## 9. 文件改动总览

```
package.json                                    + jsdom cheerio @netlify/blobs
netlify/functions/api.mjs                       + 4 个 /api/translate/* 路由
public/translate.html                           极简 URL 翻译 UI
public/paste.html                               极简文本翻译 UI
public/glossary.html                            术语表管理 UI

lib/translate/                                  ★ 新增（从 fanyi-extension 移植）
├── blockExtractor/
│   ├── constants.js        ~400 行   规则集合
│   ├── types.js            ~10 行    TextBlock 接口
│   ├── rules.js            ~300 行   谓词函数
│   ├── walker.js           ~350 行   TreeWalker 主流程
│   └── index.js            ~30 行    collectBlocks 入口
├── chunkBuilder.js         ~120 行   切 chunk
├── chunkRetry.js           ~100 行   缺失重试
├── translationQueue.js     ~120 行   串行队列
├── cacheKey.js             ~25 行    缓存键
├── cacheManager.js         ~120 行   Blobs 适配
├── translateApi.js         ~150 行   调翻译服务
├── prompt.js               ~80 行    batch 翻译 prompt
├── urlFetcher.js           ~60 行    服务端 fetch + jsdom
├── applyTranslation.js     ~80 行    cheerio 回填
└── pipeline.js             ~100 行   串联

_ref_only/deepseek.ts                          不动（继续作为 prompt 设计的早期参考）
_ref_only/fanyi-extension/                     不动（继续作为源码参考）— 符号链接
```

---

## 10. 部署注意

### 10.1 Netlify Function 限制

- 同步函数 **26s（Pro）** / 30s（Enterprise） 上限
- 一篇 5000 字文章，10 chunk × ~2s/块 = 20s，**临界**
- 长文 > 10000 字不适合

**对策**：
1. Phase 1：单次同步 + 缓存兜底
2. Phase 5：长文切多次请求（前端分页拉）
3. 终极方案：迁 Cloudflare Workers（CPU 30s + wall time 灵活）

### 10.2 esbuild 配置

`netlify.toml` 默认 bundled；`jsdom` / `cheerio` 走 bundled 即可（5MB + 250KB，可接受）。

`@netlify/blobs` 走 bundled。

### 10.3 环境变量

复用现有的：
- `DEEPSEEK_API_KEY` / `CLOUDFLARE_*` / `NVIDIA_API_KEY` / `OPENROUTER_API_KEY`
- `AUTH_KEY`

---

## 11. 成本估算

按 DeepSeek v4-flash 公开价（cache hit 折后价）：

| 场景 | 假设 | 成本（人民币 / 月） |
|---|---|---|
| 短文（500 字） | 100 篇 × 1k input + 0.5k output | ¥0.03 |
| 长文（5000 字） | 30 篇 × 8k input + 4k output | ¥0.5 |
| URL 翻译（带缓存 80% 命中） | 200 篇 | ¥1–3 |
| 系统 prompt（glossary 200 token） | 每请求 +200 token | +¥0.5 |

**总成本：每月 ¥2–5 人民币**。

KV cache 命中（prompt cache miss tokens=0）时 DeepSeek 折后价是 1/10，**实际可能 < ¥1**。

---

## 12. 实施分阶段

### Phase 1 — MVP（半天）
- [ ] 装 `jsdom` / `cheerio` / `@netlify/blobs`
- [ ] `lib/translate/prompt.js` + `translateApi.js`（直调现有 LLM 代理）
- [ ] `POST /api/translate/text`（最简路径，无 glossary 无缓存）
- [ ] `public/paste.html`

**验收**：粘贴英文 → 看中文。

### Phase 2 — Block 翻译 + chunk
- [ ] `chunkBuilder.js` + `chunkRetry.js` + `translationQueue.js`
- [ ] `POST /api/translate/blocks`

**验收**：10 块输入 → 10 块输出，无 missing。

### Phase 3 — Block 抽取（DOM）
- [ ] `lib/translate/blockExtractor/` 完整移植
- [ ] jsdom 适配（替换 `document`）
- [ ] 单测：跨 5 个真实 HTML 样本

**验收**：抓一篇 HTML → 抽出 ≥ 10 块。

### Phase 4 — URL 翻译
- [ ] `urlFetcher.js`（fetch + jsdom）
- [ ] `applyTranslation.js`（cheerio）
- [ ] `POST /api/translate/url`
- [ ] `public/translate.html`

**验收**：贴 Medium URL → 看双语文本。

### Phase 5 — 缓存 + 术语表
- [ ] `cacheManager.js`（Netlify Blobs）
- [ ] `cacheKey.js`
- [ ] `/api/glossary` CRUD

**验收**：重复 URL → 第二次 < 100ms。

### Phase 6 — 优化
- [ ] stream 模式（如果迁移到 CF Workers 再做）
- [ ] glossary fuzzy 匹配
- [ ] 失败块 UI 重试

---

## 13. 已知风险 / 限制

| 风险 | 缓解 |
|---|---|
| Netlify Function 30s 超时，长文易超时 | 切 chunk + 多次串行；或迁 CF Workers |
| jsdom 抓不到反爬 / SPA 渲染后内容 | 失败回退：cheerio 直接操作 raw HTML，能力下降但不 500 |
| LLM 返回的 ID 与输入对不上 | `chunkRetry` 自动单挑重试 1 次 |
| 块过多导致 LLM 截断 | chunk size 控 ≤ 30 块 / ≤ 800 token |
| Glossary 表过大撑爆 system prompt | 限制单表 ≤ 200 条 |
| Cloudflare 缓存命中依赖 prefix 一致 | glossary 整表拼头部，user 消息只放 blocks（无动态内容） |
| 跨站 skip class 不全 | 接受 — 漏的会进 LLM，结果里手动 ignore；持续累积列表 |

---

## 14. 决策记录

- **Q: URL 翻译用 Readability 还是 TreeWalker?**
  A: **TreeWalker**。Readability 只对单篇文章好用；工具页 / 文档 / 论坛都抓不到。TreeWalker 是 fanyi-extension 已验证的方案，移植即可。
- **Q: 翻译服务调直连 DeepSeek 还是经代理?**
  A: **经代理**。复用多后端路由 + 认证 + 日志；多一个网络跳转（自环）成本 < 1ms。
- **Q: chunk 串行还是并行?**
  A: **串行（concurrency=1）**。DeepSeek KV cache 是顺序敏感，并行 4 个 chunk 同 prefix 全 miss。
- **Q: 默认用哪个 LLM?**
  A: `deepseek-v4-flash`（最便宜 + 缓存命中 + 中文好）。经 `?model=...` 切换。
- **Q: 缓存用 Netlify Blobs 还是 Upstash Redis?**
  A: Blobs。零外部依赖，免费额度够用。
- **Q: 做不做浏览器扩展?**
  A: **不做**。fanyi-extension 已经在做了。Web 端用 URL + 粘贴两种入口覆盖。
