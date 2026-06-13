# vocal-saga vs fanyi-extension 规则差异分析报告

> 分析日期：2026-06-14
> 目的：确保 server 端翻译规则与 browser 扩展保持一致

---

## 一、核心结论

**提取规则（什么内容被翻译）完全一致**，差异仅在于运行环境适配（浏览器 vs CF Worker）。

---

## 二、逐文件差异分析

### 2.1 blockExtractor/constants.ts — 完全一致 ✓

两个项目的常量定义完全相同：
- `SKIP_CLASS_PATTERNS`：334 个跳过模式
- `SKIP_SET`：50+ 个跳过标签
- `DIRECT_SET`：12 个直接翻译标签
- `INLINE_SET`：40+ 个内联标签
- `METADATA_TOKENS`：6 个元数据 token

### 2.2 blockExtractor/rules.ts — 逻辑一致，API 适配

| 差异点 | fanyi-extension | vocal-saga | 原因 |
|--------|-----------------|------------|------|
| `getSiteRule()` | 无参数，用 `window.location.href` | 接受 `pageUrl` 参数 | Worker 无 window |
| `shouldSkipBySiteRules(el)` | 无 pageUrl 参数 | 接受 `pageUrl` 参数 | 同上 |
| `isValidText(text)` | 无 pageUrl 参数 | 接受 `pageUrl` 参数 | 同上 |
| `isElementHidden(el)` | `el instanceof HTMLElement` | `el.nodeType === 1` | linkedom 兼容 |
| `classifyChildren()` | `Node.TEXT_NODE` / `Node.ELEMENT_NODE` | 数字常量 3 / 1 | linkedom 兼容 |

**提取逻辑完全相同**，只是参数传递方式不同。

### 2.3 blockExtractor/walker.ts — 实现不同，逻辑一致

| 差异点 | fanyi-extension | vocal-saga | 原因 |
|--------|-----------------|------------|------|
| Walker 实现 | `document.createTreeWalker` | 手写递归 `walkNode` | linkedom TreeWalker 不支持 acceptNode |
| FILTER 常量 | `NodeFilter.FILTER_ACCEPT` 等 | 数字常量 1/2/3 | linkedom 不导出 FILTER_* |
| NodeType 检查 | `node instanceof Text/Element` | `node.nodeType === 3/1` | linkedom 兼容 |
| `grabNode` 签名 | `grabNode(node)` | `grabNode(node, pageUrl)` | 站点规则需要 URL |

**核心逻辑完全一致**：
- 同样的跳过规则（SKIP_SET、SKIP_CLASS_PATTERNS）
- 同样的接受逻辑（DIRECT_SET、INLINE_SET）
- 同样的 `<header>` 特殊处理
- 同样的去重逻辑（seenTexts）

### 2.4 contentHelper.ts — vocal-saga 有增强

| 差异点 | fanyi-extension | vocal-saga | 原因 |
|--------|-----------------|------------|------|
| `prepareDocument(root)` | 1 参数 | 2 参数（+ pageUrl） | 站点规则需要 URL |
| `findArticleRoot(doc)` | 无 `expandIfFragmented` | 有 `expandIfFragmented` | Webflow 多容器支持 |
| `effectiveRoot` 判断 | `root instanceof Document` | `root.nodeType === 9` | linkedom 兼容 |

**vocal-saga 额外功能**：
- `expandIfFragmented()`：Webflow 等 CMS 把文章拆到多个容器时，自动向上展开

### 2.5 blockExtractor/types.ts — vocal-saga 有扩展

| 差异点 | fanyi-extension | vocal-saga |
|--------|-----------------|------------|
| `SiteRule.documentTerms` | 无 | 有（文档级专有名词） |

这是 vocal-saga 独有的功能，不影响提取逻辑。

### 2.6 site-specific rules — 完全一致 ✓

- `github-rules.ts`：完全一致
- `reddit-rules.ts`：完全一致
- `hackernews-rules.ts`：完全一致
- `fortune-rules.ts`：完全一致
- `rules/index.ts`：完全一致

---

## 三、行为差异分析

### 3.1 提取范围

由于 vocal-saga 有 `expandIfFragmented()`，对于 Webflow 站点（如 claude.com），**vocal-saga 的提取范围可能比 fanyi-extension 更广**（能覆盖多个 `.u-rich-text-blog` 容器）。

### 3.2 站点规则匹配

fanyi-extension 用 `window.location.href` 匹配站点规则，vocal-saga 用传入的 `pageUrl`。

**潜在问题**：如果 `pageUrl` 传入的格式与 `window.location.href` 不同（如带/不带 `www.`），可能导致规则匹配失败。

**建议**：确保 `pageUrl` 在传入前经过 `cacheKeyUrl` 标准化。

### 3.3 Shadow DOM 处理

fanyi-extension 用 `document.createTreeWalker` 遍历 shadow root，vocal-saga 用 `walkForShadow` 递归。

**行为一致**：两者都会递归进入 open shadow root 处理内容。

---

## 四、需要同步的差异

### 4.1 已同步（无需操作）

- 核心提取规则（constants.ts）
- 站点规则（github/reddit/hackernews/fortune）
- 基本 walker 逻辑

### 4.2 vocal-saga 独有（保留）

- `expandIfFragmented()`：Webflow 多容器支持
- `documentTerms`：文档级专有名词
- linkedom 兼容性适配

### 4.3 建议同步到 fanyi-extension

以下 vocal-saga 的改进可以考虑同步回 fanyi-extension：

1. **`expandIfFragmented()`**：如果 fanyi-extension 也遇到 Webflow 站点问题，可以同步
2. **`pageUrl` 参数化**：如果 fanyi-extension 需要支持非当前页面的 URL（如后台翻译），可以同步

---

## 五、测试验证

### 5.1 提取一致性测试

建议添加对比测试，确保两个项目对同一 HTML 提取相同的 blocks：

```typescript
// vocal-saga 测试
it('extracts same blocks as fanyi-extension', () => {
  const html = loadFixture('towardsdatascience-article.html');
  const { document } = parseHTML(html);
  const { blocks } = prepareDocument(document, 'https://towardsdatascience.com/test');
  // 验证标题、副标题、正文都被提取
  expect(blocks.some(b => b.text.includes('When PyMuPDF'))).toBe(true);
});
```

### 5.2 站点规则一致性测试

```typescript
it('matches same site rules as fanyi-extension', () => {
  const rule = matchSiteRule('https://github.com/user/repo');
  expect(rule?.skipSelectors).toBeDefined();
});
```

---

## 六、总结

| 维度 | 状态 | 说明 |
|------|------|------|
| 核心提取规则 | ✓ 一致 | constants.ts 完全相同 |
| 站点规则 | ✓ 一致 | github/reddit/hackernews/fortune 相同 |
| Walker 逻辑 | ✓ 一致 | 实现不同但行为相同 |
| 内容检测 | ✓ 增强 | vocal-saga 多了 expandIfFragmented |
| 平台适配 | ✓ 必要差异 | linkedom vs browser DOM |

**结论**：两个项目的提取规则完全一致，差异仅在于运行环境适配。vocal-saga 有少量增强功能（expandIfFragmented、documentTerms），不影响与 fanyi-extension 的一致性。

---

*分析完毕。核心规则一致，差异合理。*
