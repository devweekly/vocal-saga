# 短句列表 Inline 翻译设计文档（修订版）

## 1. 问题描述

当前短句列表项（如 `<li>Repository embedding index</li>`，3~8 个单词）的翻译结果会作为一个新的 `.fanyi-translation` block 插入原文下方：

```html
<li>
  <span class="fanyi-original">Repository embedding index</span>
  <span class="fanyi-translation">仓库嵌入索引</span>
</li>
```

视觉上产生明显的"换行 + 左边框"段落，对短句来说过于笨重，破坏了列表的紧凑感。

**目标**：对符合条件的短句列表项，译文直接 inline append 在原文末尾：

```html
<!-- 双语模式 -->
<li>
  <span class="fanyi-inline-original">Repository embedding index</span>
  <span class="fanyi-inline-translation">（仓库嵌入索引）</span>
</li>

<!-- target 模式（CSS 隐藏 original） -->
<li>
  <span class="fanyi-inline-original" style="display:none">Repository embedding index</span>
  <span class="fanyi-inline-translation">仓库嵌入索引</span>
</li>
```

---

## 2. 核心架构原则

```text
Extract (Walker)     → 只给 hint，不做渲染决策
Translate (Pipeline) → 得到译文
Render (Display)     → 根据「原文特征 + 译文长度」最终决定 inline / block
```

为什么把最终决策推迟到 Render 阶段？

- **原文短 ≠ 译文短**。例如 `Corporate governance and sustainability framework`（6 词）→ `公司治理与可持续发展框架说明文件`（很长），inline 会很丑。
- Walker 阶段拿不到译文长度，只能做"候选"标记。
- Display 阶段同时拥有 `block.text`（原文）和 `translated`（译文），信息最完整。

---

## 3. 数据模型修改

`lib/translate/blockExtractor/types.ts`：

```typescript
export interface TextBlock {
  id: string;
  xpath: string;
  tag: string;
  text: string;
  /** 渲染提示：Walker 阶段只标记候选，Render 阶段再决定 */
  renderHint?: {
    inlineCandidate?: boolean;
  };
  context?: {
    headingPath: string[];
    position: number;
  };
}
```

> 不叫 `displayMode`，因为 Walker 不负责决定"怎么显示"。`renderHint` 只是告诉下游"这个元素可能适合 inline，但最终你说了算"。

---

## 4. Walker 层修改：只给 Candidate Hint

### 4.1 检测条件

基于 **已经提取好的 `block.text`** 判断，不要重新读 DOM（避免 hidden 元素污染长度）。

`lib/translate/blockExtractor/rules.ts` 新增：

```typescript
const INLINE_MAX_CHARS = 60;      // 原文最大字符数
const INLINE_MAX_WORDS = 8;       // 原文最大单词数
const BLOCK_LEVEL_TAGS = new Set([
  'div','p','ul','ol','li','h1','h2','h3','h4','h5','h6',
  'pre','blockquote','table','section','article','header','footer','nav','aside'
]);

/**
 * 判断元素是否适合作为 inline 翻译候选。
 * 只基于 Extract 阶段已知信息，不读 DOM textContent（避免 hidden 子元素污染）。
 */
export function isInlineCandidate(el: Element, blockText: string): boolean {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;

  // 条件1：列表上下文（li 或 ul/ol 的直接子元素）
  const isListContext = tag === 'li' ||
    (parent && ['ul', 'ol'].includes(parent.tagName.toLowerCase()));
  if (!isListContext) return false;

  // 条件2：原文很短（用已经提取的 blockText，不是 el.textContent）
  const text = blockText.trim();
  if (text.length > INLINE_MAX_CHARS) return false;
  const wordCount = text.split(/\s+/).length;
  if (wordCount > INLINE_MAX_WORDS) return false;

  // 条件3：内部没有 block-level 子元素
  for (let i = 0; i < el.children.length; i++) {
    if (BLOCK_LEVEL_TAGS.has(el.children[i].tagName.toLowerCase())) {
      return false;
    }
  }

  return true;
}
```

### 4.2 walkNode 中标记 candidate

`lib/translate/blockExtractor/walker.ts`：

```typescript
if (translateNode) {
  const text = translateNode.textContent?.trim();
  if (text) {
    // ... 去重逻辑 ...
    const isCandidate = isInlineCandidate(translateNode, text);
    blocks.push({
      id,
      xpath: getXPath(translateNode),
      tag: translateNode.tagName.toLowerCase(),
      text,
      renderHint: isCandidate ? { inlineCandidate: true } : undefined,
      context: { headingPath: headingStack.slice(), position: blockIdRef.value },
    });
  }
}
```

> 注意：这里**不写** `data-fanyi-inline` 到 DOM。inline/block 是 Render 阶段决策，Walker 阶段不污染 DOM。

---

## 5. Display 层修改

### 5.1 新增 applyInlineTranslation

`lib/translate/translationDisplay.ts`：

```typescript
/**
 * Inline 翻译：译文 append 在原文的最后一个文本承载元素内。
 *
 * 为什么不是 node.appendChild？
 * 对于 <li><button>Delete</button></li>，append 到 li 会让译文跑到 button 外面，
 * 视觉上变成 "Delete [按钮] （删除）[文本]"，用户会以为这是两个独立元素。
 *
 * 正确做法：找到最后一个包含直接文本节点的叶子元素，把译文插进去。
 * 例如 <li><a>Repository embedding index</a></li> → 插到 <a> 内部。
 */
export function applyInlineTranslation(
  node: HTMLElement,
  translatedText: string,
  mode: TranslationMode
): void {
  if (node.classList.contains('fanyi-translated')) return;

  const doc = node.ownerDocument;
  if (!doc) return;

  // 1) 找到最后一个"文本承载元素"（包含直接 text node 的最深叶子）
  const textHost = findLastTextHost(node);
  if (!textHost) return;

  // 2) 包裹原文：把 textHost 的所有子节点移入 .fanyi-inline-original
  const originalSpan = doc.createElement('span');
  originalSpan.className = 'fanyi-inline-original';
  while (textHost.firstChild) {
    originalSpan.appendChild(textHost.firstChild);
  }
  textHost.appendChild(originalSpan);

  // 3) 插入译文 span
  const translationSpan = doc.createElement('span');
  translationSpan.className = 'fanyi-inline-translation';
  translationSpan.textContent = `（${translatedText}）`;
  textHost.appendChild(translationSpan);

  // 4) target 模式：隐藏原文，只显示译文（去掉括号）
  if (mode === 'target') {
    originalSpan.style.display = 'none';
    translationSpan.textContent = translatedText; // 去掉括号
  }

  // 5) 标记宿主
  node.classList.add('fanyi-translated');
  node.dataset.originalText = originalSpan.textContent || '';
}

/**
 * 找到 el 子树中"最后一个包含直接文本节点的元素"。
 * 例如：
 *   <li>text</li>              → <li>
 *   <li><a>text</a></li>       → <a>
 *   <li><button>ok</button></li> → <button>
 *   <li><span></span></li>     → null（无文本）
 */
function findLastTextHost(el: Element): Element | null {
  // DFS 找最后一个含直接 text node 的元素
  let result: Element | null = null;

  function dfs(current: Element): void {
    const children = current.childNodes;
    let hasDirectText = false;
    for (let i = 0; i < children.length; i++) {
      const n = children[i];
      if (n.nodeType === 3 && (n.textContent || '').trim()) {
        hasDirectText = true;
      }
      if (n.nodeType === 1) {
        dfs(n as Element);
      }
    }
    if (hasDirectText) {
      result = current;
    }
  }

  dfs(el);
  return result;
}
```

### 5.2 修改 restoreBlock

```typescript
export function restoreBlock(node: HTMLElement): void {
  // inline 模式：移除 .fanyi-inline-original 和 .fanyi-inline-translation，
  // 把 original 的子节点移回 textHost
  const inlineOriginal = node.querySelector('.fanyi-inline-original');
  const inlineTranslation = node.querySelector('.fanyi-inline-translation');

  if (inlineOriginal && inlineTranslation) {
    const textHost = inlineOriginal.parentElement;
    if (textHost) {
      while (inlineOriginal.firstChild) {
        textHost.insertBefore(inlineOriginal.firstChild, inlineOriginal);
      }
      inlineOriginal.remove();
      inlineTranslation.remove();
    }
    node.classList.remove('fanyi-translated');
    node.classList.remove('fanyi-missing');
    node.removeAttribute('title');
    delete node.dataset.originalText;
    return;
  }

  // block 模式：原有逻辑不变...
  const originalSpan = node.querySelector('.fanyi-original');
  if (originalSpan) {
    while (originalSpan.firstChild) {
      node.insertBefore(originalSpan.firstChild, originalSpan);
    }
    originalSpan.remove();
  }
  const translationSpan = node.querySelector('.fanyi-translation');
  if (translationSpan) {
    translationSpan.remove();
  }
  // ... 后续原有逻辑 ...
}
```

### 5.3 修改 toggleBlockTranslation

```typescript
export function toggleBlockTranslation(node: HTMLElement): void {
  // inline 模式
  const inlineOriginal = node.querySelector('.fanyi-inline-original') as HTMLElement | null;
  const inlineTranslation = node.querySelector('.fanyi-inline-translation') as HTMLElement | null;
  if (inlineOriginal && inlineTranslation) {
    const isHidden = inlineOriginal.style.display === 'none';
    inlineOriginal.style.display = isHidden ? '' : 'none';
    // 切换时同时切换括号： bilingual 显示括号，target 不显示
    const rawText = inlineTranslation.textContent || '';
    if (isHidden) {
      // 从 target 切回 bilingual：加上括号
      inlineTranslation.textContent = rawText.startsWith('（') ? rawText : `（${rawText}）`;
    } else {
      // 从 bilingual 切到 target：去掉括号
      inlineTranslation.textContent = rawText.replace(/^（|）$/g, '');
    }
    return;
  }

  // block 模式：原有逻辑
  const translationSpan = node.querySelector('.fanyi-translation');
  if (translationSpan) {
    const el = translationSpan as HTMLElement;
    el.style.display = el.style.display === 'none' ? '' : 'none';
  }
}
```

---

## 6. Pipeline 层修改：Render 阶段做最终决策

`lib/translate/pipeline.ts`：

```typescript
const { applyBlockTranslation, applyInlineTranslation } = await import('./translationDisplay');
// ... blockMap 构建不变 ...

for (const block of blocks) {
  const translated = translations.get(block.id);
  if (!translated) continue;
  const el = blockMap.get(block.id);
  if (!el || (el as Node).nodeType !== 1) continue;

  const htmlEl = el as unknown as HTMLElement;

  // Render 阶段最终决定：candidate + 译文也要短
  const shouldInline =
    block.renderHint?.inlineCandidate === true &&
    translated.length <= 40 &&               // 译文不超过 40 字符
    translated.split(/\s+/).length <= 12;    // 译文不超过 12 词（中文按字算也安全）

  if (shouldInline) {
    applyInlineTranslation(htmlEl, translated, mode);
  } else {
    applyBlockTranslation(htmlEl, translated, mode);
  }
}
```

> 这样即使 Walker 阶段标记了 candidate，如果译文过长，仍然回退到 block 模式。

---

## 7. CSS 样式

`lib/translate/pipeline.ts` 中注入的 style 标签追加：

```css
.fanyi-inline-original {
  /* 原文：不额外设颜色，继承原页面样式 */
}
.fanyi-inline-translation {
  opacity: 0.75;
  font-size: 0.9em;
  margin-left: 0.3em;
  white-space: normal;
}
```

设计原则：
- **不硬编码 `color: #666`**：暗黑模式 / 高对比主题 / 用户自定义样式下会失效。用 `opacity: 0.75` 降低视觉权重即可，颜色继承当前上下文。
- **`font-size: 0.9em`**：略小，但不突兀。
- **`white-space: normal`**：防止父元素是 `nowrap`（如某些导航栏）导致译文不换行溢出。
- **括号**： bilingual 模式下用 `（译文）` 明确标识；target 模式去掉括号。

---

## 8. 边界情况

| 场景 | 处理方式 |
|------|----------|
| 列表项内有 `<a>` 链接 | `findLastTextHost` 找到 `<a>`，译文插到 `<a>` 内部，与链接文本视觉一致 |
| 列表项内有 `<button>` | 同上，译文插到 `<button>` 内部 |
| 列表项内有 `<code>` | code 是 inline tag，`findLastTextHost` 可能找到 code 或外层 li，取决于文本分布 |
| 列表项内有嵌套 `<ul>` | `BLOCK_LEVEL_TAGS` 命中，不标记 candidate |
| 原文短但译文长 | Walker 标记 candidate，但 Pipeline 中 `translated.length > 40` 回退到 block 模式 |
| target 模式 | `.fanyi-inline-original` 隐藏，只显示译文（无括号） |
| 切换双语/target | `toggleBlockTranslation` 同时切换 original display 和括号 |
| 恢复翻译 | `restoreBlock` 识别 inline 结构，把 original 子节点移回 textHost |
| 非列表的短句（如 `<p>Hello world</p>`） | `isListContext = false`，不标记 candidate，保持 block 模式 |
| textHost 找不到（全空元素） | `findLastTextHost` 返回 null，`applyInlineTranslation` 直接 return，不翻译 |

---

## 9. 实施步骤（建议顺序）

1. **`types.ts`** — 把 `displayMode?: 'block' \| 'inline'` 改为 `renderHint?: { inlineCandidate?: boolean }`
2. **`rules.ts`** — 新增 `isInlineCandidate(el, blockText)`，基于 block.text 和子元素 tag 判断
3. **`walker.ts`** — 在 `walkNode()` 中调用 `isInlineCandidate(translateNode, text)`，填充 `renderHint`
4. **`translationDisplay.ts`** —
   - 新增 `findLastTextHost` + `applyInlineTranslation`
   - 修改 `restoreBlock` 支持 inline 结构恢复
   - 修改 `toggleBlockTranslation` 支持 inline 模式切换
5. **`pipeline.ts`** —
   - 回填阶段根据 `block.renderHint?.inlineCandidate && translated.length <= 40` 决定 inline/block
   - CSS 注入追加 `.fanyi-inline-original` 和 `.fanyi-inline-translation`
6. **测试** —
   - `blockExtractor`：短 `<li>` → `renderHint.inlineCandidate === true`；长 `<li>` / 含 `<ul>` → undefined
   - `translationDisplay`：验证 `findLastTextHost` 对 `<li><a>text</a></li>` 返回 `<a>`
   - `pipeline`：mock 译文长度 >40 时回退到 block 模式
