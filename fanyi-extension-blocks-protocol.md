# fanyi-extension ↔ Server 预标记 HTML 翻译协议

## 1. 背景与动机

当前 `/fanyi/page` 端点接收扩展传来的原始 HTML，服务端需要完整执行：

```
parseHTML → walker 提取 blocks → chunkBuilder 分块 → LLM 翻译 → 回填 HTML
```

这个流程在服务端重复了扩展端已经在浏览器中做过的工作。扩展端天然拥有完整 DOM， walker 提取 blocks 后，可以在 DOM 元素上标记 `data-fanyi-block-id`，序列化后的 HTML 保留这些属性。服务端收到后直接收集标记元素，无需重新 walk DOM。

**目标**：让扩展端在 walker 提取 block 时，给 DOM 元素设置 `data-fanyi-block-id` 属性，然后把标记后的 HTML 发送到服务端。服务端跳过 DOM 解析中的 walker 阶段，直接从 HTML 提取 blocks 并分块翻译，降低服务端 CPU 开销、减少整体延迟。

---

## 2. 协议概述

扩展端在浏览器中完成 DOM 解析、walker 提取 blocks，给每个被提取的元素设置 `data-fanyi-block-id` 属性，然后将标记后的 HTML 发送到服务端。

```
POST /fanyi/page
Body: { html, url, source, target, mode, service }
```

服务端行为分支：

| 场景 | 服务端行为 |
|------|-----------|
| HTML 中**没有** `data-fanyi-block-id` | 走原有流程：parseHTML → walker → chunkBuilder → 翻译 → 回填 |
| HTML 中**有** `data-fanyi-block-id` | **跳过 walker**，直接从 HTML 收集标记元素 → chunkBuilder → 翻译 → 回填 |

> 扩展端无需发送 `blocks` 或 `chunks`，只需发送标记了 `data-fanyi-block-id` 的 HTML。

---

## 3. 请求格式

```typescript
interface FanyiPageRequest {
  /** 标记后的页面 HTML（包含 data-fanyi-block-id 属性） */
  html: string;

  /** 页面原始 URL，用于计算 <base> href 和相对路径解析 */
  url: string;

  source?: string;   // 默认 'auto'
  target?: string;   // 默认 'zh'
  mode?: 'bilingual' | 'target';  // 默认 'bilingual'
  service?: 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare' | 'mimo';  // 默认 'deepseek'
}
```

### 3.1 发送示例

```json
{
  "html": "<!doctype html><html><body><article><h1 data-fanyi-block-id=\"b1\">How Anthropic Built Multi-Agent</h1><p data-fanyi-block-id=\"b2\">In this post we explore...</p></article></body></html>",
  "url": "https://theaiengineer.substack.com/p/how-anthropic-built-multi-agent-deep",
  "source": "en",
  "target": "zh",
  "mode": "bilingual",
  "service": "deepseek"
}
```

扩展端 walker 在浏览器中执行时，给每个被接受的 DOM 元素设置 `data-fanyi-block-id` 属性：

```typescript
// 扩展端 walker.ts
function grabNode(el: Element, blockId: number): Element | null {
  // ... 现有逻辑 ...
  if (/* accept 条件 */) {
    el.setAttribute('data-fanyi-block-id', `b${blockId}`);
    return el;
  }
  return null;
}
```

序列化后的 HTML 会保留这些属性：

```html
<article>
  <h1 data-fanyi-block-id="b1">How Anthropic Built Multi-Agent</h1>
  <p data-fanyi-block-id="b2">In this post we explore...</p>
</article>
```

---

## 4. 响应格式

与当前 `/fanyi/page` 保持一致：

```
Content-Type: text/html; charset=utf-8
X-Translate-Blocks: 12
X-Translate-Chunks: 3
X-Translate-Duration-Ms: 2345
```

Body 为翻译后的完整 HTML 字符串。

---

## 5. 扩展端职责

### 5.1 Block 提取与标记

扩展端在浏览器真实 DOM 上执行 walker，提取 blocks 时同时给 DOM 元素设置 `data-fanyi-block-id`：

```typescript
import { extractBlocks } from './blockExtractor';

const blocks = extractBlocks(document.body, location.href);
// extractBlocks 内部已在被接受的元素上设置了 data-fanyi-block-id
```

### 5.2 发送标记后的 HTML

```typescript
const html = document.documentElement.outerHTML;

fetch('https://s.sunxiunan.com/fanyi/page', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    html,           // 包含 data-fanyi-block-id 属性的完整 HTML
    url: location.href,
    source: 'en',
    target: 'zh',
    mode: 'bilingual',
  }),
});
```

### 5.3 关于 XPath

扩展端提取的 `xpath` 在服务端回填时作为 fallback 使用。服务端优先通过 `data-fanyi-block-id` 定位元素（`querySelector`），如果失败则使用 XPath。

> 注意：如果扩展端在提取 blocks 后修改了 DOM（如注入翻译标记），必须发送**修改前的原始 HTML**（先 clone 再 walk），否则服务端定位会失败。

---

## 6. 服务端职责

### 6.1 流程分支

```typescript
// translateHtml 内部逻辑
export async function translateHtml(input: TranslateHtmlInput): Promise<...> {
  const doc = parseHTML(input.html);

  // 检测扩展端是否已在 HTML 中标记了 data-fanyi-block-id
  const hasMarkedBlocks = doc.querySelector('[data-fanyi-block-id]') !== null;
  let preExtractedBlocks: TextBlock[] | undefined;

  if (hasMarkedBlocks) {
    preExtractedBlocks = extractBlocksFromMarkedHtml(doc);
    console.log(`[Pipeline] Received pre-marked HTML from extension: ${input.url}`);
  }

  const result = await runTranslationPipeline(
    doc,
    input.url,
    sourceLang,
    targetLang,
    mode,
    input.service || 'deepseek',
    input.model,
    input.glossary,
    preExtractedBlocks,   // 预提取的 blocks（如果有）
  );
  // ...
}
```

### 6.2 从预标记 HTML 提取 blocks

```typescript
/**
 * 从已标记 data-fanyi-block-id 的 HTML 中直接提取 blocks。
 * 扩展端 walker 在浏览器中执行时已经给 DOM 元素设置了 data-fanyi-block-id，
 * 序列化后的 HTML 会保留这些属性。服务端收到后无需重新 walk，直接收集即可。
 */
export function extractBlocksFromMarkedHtml(doc: Document): TextBlock[] {
  const blocks: TextBlock[] = [];
  const seenIds = new Set<string>();

  doc.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
    const id = el.getAttribute('data-fanyi-block-id');
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);

    const text = el.textContent?.trim() || '';
    if (!text) return;

    blocks.push({
      id,
      xpath: getXPath(el),
      tag: el.tagName.toLowerCase(),
      text,
    });
  });

  // 按 b1, b2, b10... 的数值顺序排序，避免字典序 b10 < b2
  blocks.sort((a, b) => {
    const na = parseInt(a.id.replace(/^b/, ''), 10) || 0;
    const nb = parseInt(b.id.replace(/^b/, ''), 10) || 0;
    return na - nb;
  });

  return blocks;
}
```

### 6.3 回填策略

服务端回填时优先使用 `data-fanyi-block-id` 定位元素：

```typescript
// 优先用 id 查找（O(1)）
const el = doc.querySelector(`[data-fanyi-block-id="${block.id}"]`);
if (!el) {
  // fallback：用 xpath 或跳过该 block 的回填
}
```

---

## 7. 性能收益预估

以典型文章（50 blocks，~5000 tokens）为例：

| 指标 | 原有流程 | 预标记 HTML 流程 | 收益 |
|------|---------|-----------------|------|
| 服务端 parseHTML | ~20ms | ~20ms | 不变 |
| 服务端 walker | ~15ms | 0ms | **省 15ms** |
| 服务端 buildChunks | ~1ms | ~1ms | 不变 |
| 网络传输 | 原始 HTML | 原始 HTML + 属性 | 增极少 |
| **服务端总 CPU** | ~36ms | ~21ms | **省 15ms** |
| **端到端延迟** | ~36ms + LLM | ~21ms + LLM | **省 15ms** |

> 对于 CF Workers 的 50ms CPU limit，省 15ms 意味着更不容易触发 CPU limit，也能更快释放 Worker 去处理下一个请求。

---

## 8. 实施步骤

### Step 1: 扩展端 — 在 walker 中设置 `data-fanyi-block-id`

修改扩展端的 walker，在提取 block 时同时给 DOM 元素设置 `data-fanyi-block-id`：

```typescript
// 扩展端 walker.ts
function grabNode(el: Element, blockId: number): Element | null {
  // ... 现有逻辑 ...
  if (/* accept 条件 */) {
    el.setAttribute('data-fanyi-block-id', `b${blockId}`);
    return el;
  }
  return null;
}
```

### Step 2: 扩展端 — 发送标记后的 HTML

```typescript
const html = document.documentElement.outerHTML;

fetch('https://s.sunxiunan.com/fanyi/page', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    html,           // 包含 data-fanyi-block-id
    url: location.href,
    source: 'en',
    target: 'zh',
    mode: 'bilingual',
  }),
});
```

### Step 3: 服务端 — 修改 `translateHtml` 支持预标记 HTML

在 `translateHtml` 中，检测 HTML 是否包含 `data-fanyi-block-id`：

```typescript
const hasMarkedBlocks = doc.querySelector('[data-fanyi-block-id]') !== null;
let preExtractedBlocks: TextBlock[] | undefined;

if (hasMarkedBlocks) {
  preExtractedBlocks = extractBlocksFromMarkedHtml(doc);
}

const result = await runTranslationPipeline(
  doc, input.url, sourceLang, targetLang, mode,
  input.service || 'deepseek', input.model, input.glossary,
  preExtractedBlocks,   // 预提取的 blocks
);
```

### Step 4: 服务端 — 实现 `extractBlocksFromMarkedHtml`

新增 `extractBlocksFromMarkedHtml` 函数，通过 `querySelectorAll('[data-fanyi-block-id]')` 直接收集标记元素。

### Step 5: 测试验证

1. 扩展端发送标记后的 HTML → 服务端跳过 walker，直接提取 blocks
2. 验证翻译结果与原有流程一致
3. 性能对比：服务端 CPU 时间、总延迟

---

## 9. 边界情况

1. **HTML 中没有标记**：服务端自动回退到原有 walker 流程，完全向后兼容。

2. **重复 id**：`extractBlocksFromMarkedHtml` 内部用 `seenIds` Set 去重，只保留第一个。

3. **空文本元素**：`extractBlocksFromMarkedHtml` 过滤掉 `textContent.trim() === ''` 的元素。

4. **id 排序**：按数值顺序排序（`b1, b2, b10`），避免字典序 `b10 < b2`。

5. **DOM 修改后发送**：扩展端应在 walker 执行后**立即序列化 HTML**，避免用户交互导致 DOM 变化后 id 与 HTML 不匹配。

---

## 10. 向后兼容

`/fanyi/page` 的原有调用方式（只传 `html + url`，HTML 中没有 `data-fanyi-block-id`）**完全不受影响**。服务端检测到没有标记时，自动走原有 walker 流程。
