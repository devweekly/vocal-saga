# fanyi-extension vs vocal-saga 架构差异分析

## 1. 核心差异：运行环境决定架构

| 维度 | fanyi-extension（浏览器插件） | vocal-saga（server 代理） |
|------|-------------------------------|---------------------------|
| DOM 环境 | 浏览器原生 DOM + jsdom（测试） | linkedom（无头 DOM） |
| 页面来源 | 已加载的完整页面 | fetch 原始 HTML |
| 生命周期 | 可监听动态变化、渐进式翻译 | 一次性处理，返回完整 HTML |
| DOM 操作 | RAF 分批写入、可恢复/切换 | 一次 serialization |

## 2. 文章根节点检测 — 相同的三层策略，但 server 有碎片展开

两者 `findArticleRoot` 都是三层（快速选择器 → 评分检测 → body 兜底），代码几乎一致。**但 server 多了 `expandIfFragmented()`**。

### 为什么 extension 不需要展开？

extension 运行在浏览器中，页面**已经完整渲染**。所有内容都在 DOM 里，TreeWalker 从 `findArticleRoot` 的返回结果出发，递归遍历就是整个页面的可见区域。即便 `.u-rich-text-blog` 只包含开头，Walker 从 `<body>` 或 `<main>` 出发时仍然能访问到所有后续内容容器，不存在"只看到开头"的问题。

### 为什么 server 需要？

server fetch 原始 HTML 后，`prepareDocument` 把 `findArticleRoot` 的返回结果作为 **TreeWalker 的起始范围**。如果只返回第一个 `.u-rich-text-blog`（1200 chars），Walker 永远不会走到第二个 `.u-rich-text-blog`（14000 chars）。

**根本原因**：server 无法依赖"页面已完整渲染"这个假设，必须靠算法确定一个足够包容的范围。这就是 `expandIfFragmented` 存在的理由——逐层向上，找到包含所有内容碎片的公共祖先。

### 碎片展开算法

```
extension: findArticleRoot → refineArticleRoot → extractBlocks(refined)
            ↑ 在浏览器里，Walker 从 refined 出发就能覆盖全文

server:    findArticleRoot → refineArticleRoot → expandIfFragmented → extractBlocks(expanded)
            ↑ Walker 范围必须足够大才能覆盖多个 .u-rich-text-blog 兄弟
```

`expandIfFragmented` 的逻辑（`lib/translate/contentHelper.ts`）：
1. 从候选元素向上走，最多 6 层
2. 跳过纯包装层（父子 textContent 相同）
3. 当遇到有**实质文本兄弟**的 ancestor 时，展开到该 ancestor
4. 不在 `body / html / main` 或负面 class 容器上展开

## 3. contentDetector 评分系统完全一致

两者共用同一套 `scoreElement / collectCandidates / detectArticleRoot`。评分维度（文本密度 30% + 链接密度 20% + 段落比例 25% + 标题 10% + 停用词 10% + class 暗示 5% − 噪声 15%）和阈值（0.35）完全一致。这份代码直接从 extension 移植过来，没有改动。

## 4. blockExtractor / walker — 关键差别

两者 Walker 逻辑完全一致（`acceptNode` + `grabNode` + `classifyChildren`），但 server 有两个环境适应性调整：

| 方面 | extension | server |
|------|-----------|--------|
| DOM 实现检查 | `instanceof Text` / `instanceof Element` | ❌ 统一用 `nodeType === 3` / `nodeType === 1` |
| `globalThis.window` | 始终存在（浏览器） | 需 mock / 注入（CF Workers 无 window） |
| `globalThis.HTMLElement` | 始终存在 | 需 mock / 删除 |
| 测试 DOM | jsdom（Text/Element class 与 linkedom 不同） | linkedom（class 不同） |

**`nodeType` 替换是唯一必须的语义差异**——同一套 Walker 代码在两个 DOM 实现下都能跑。

## 5. chunkBuilder 完全一致

两边的 `buildChunks` 代码完全一样（800 token 目标，warmup 前 2 块 400 token，结构性边界触发分块）。预序列化 `jsonContent` 的逻辑也一样。

## 6. translationDisplay 一致，但注入方式不同

| 层面 | extension | server |
|------|-----------|--------|
| 样式注入 | 通过 CSSOM / `insertRule` 注入 | 序列化时在 `<head>` 追加 `<style>` |
| DOM 写入 | `requestAnimationFrame` 分批 + 5s 后备 | 全部在 serialization 前写入 |
| 恢复/切换 | 支持（保留原始 DOM 结构） | 不适用（一次性返回 HTML） |

## 7. site rules — extension 多 4 条

extension 有 `github-rules.ts / reddit-rules.ts / hackernews-rules.ts / fortune-rules.ts`。server 从 `fanyi-rules` 目录加载相同的规则文件，尚未迁移到 `lib/` 下。

## 8. glossary 提取一致

两者都使用 `compromise` 库做本地 NLP（提取缩写、专有名词、高频名词短语）。代码一致。

## 9. 总结：为什么 server 有这些"不一样"

| 差异 | 原因 | 是否本质差异 |
|------|------|------------|
| `expandIfFragmented` 碎片展开 | Server 的 Walker 范围依赖选定的根节点，无法像浏览器那样访问"全部 DOM" | **必须** |
| `nodeType` 替代 `instanceof` | linkedom vs jsdom 的 class 不同 | **必须** |
| 无 RAF / 分批写入 | Server 一次性 serialization | 合理 |
| 无 restoreBlock / toggle | Server 不交互 | 合理 |
| 无 domObserver / statusOverlay | Server 无动态 UI | 合理 |
| site rules 未迁移 | 尚未完成移植 | 待补齐 |
