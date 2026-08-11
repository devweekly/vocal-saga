/**
 * blockExtractor 遍历器
 *
 * 核心遍历逻辑:
 *   1. 递归 walk + acceptNode 决定每个节点的 FILTER_* 状态
 *   2. FILTER_ACCEPT 节点进 grabNode() 评估是否可作为翻译块
 *   3. 已拒绝的祖先进 WeakSet 缓存,后代 O(1) 查表拒绝,避免回溯父链
 *
 * 历史：原本走 `document.createTreeWalker`，jsdom 支持但 linkedom 的 TreeWalker
 * 没有 acceptNode 回调，只能按 whatToShow mask 平铺。改成手写递归后
 * jsdom / linkedom / 真浏览器都能跑，逻辑也更直观。
 *
 * 同时处理 Shadow DOM (Reddit <shreddit-post> 等 web component 文本)。
 *
 * =====================================================================
 * 性能优化历史 (按收益从高到低):
 *   1. hasDirectSetDescendant 缓存 — el.querySelector(DIRECT_SET_CSS_SELECTOR)
 *      是 O(N²) 热点（每个 DIRECT_SET 元素 + 其 DIRECT_SET 子孙都要扫整子树）。
 *      WeakMap 缓存后, 整树只扫一次。
 *   2. headingStack 维护 — getHeadingPath() 之前是 O(tree) 反查（向上+向左+递归子树）。
 *      DFS 过程中维护 stack, 块提取时 O(1) snapshot。
 *   3. Shadow DOM 合并到主遍历 — collectFromShadowHosts 第二次扫描整树。
 *      walkNode 内部发现 shadowRoot 立即递归, 消除 2N 重复访问。
 *   4. classifyChildren / isValidText 缓存 — 之前 acceptNode + grabNode 各算一次。
 *      WeakMap 缓存后, 每个 element 只算一次。
 *   5. Array.from 替换为 indexed for — childNodes 本就是索引集合,
 *      避免每次迭代分配临时数组。
 * =====================================================================
 */

import {
  DIRECT_SET,
  INLINE_SET,
  SEMANTIC_SKIP_TAGS,
  SKIP_SET,
  type WalkerCounters,
} from './constants';
import {
  classifyChildren,
  hasBlockLevelParent,
  hasContentTokens,
  hasTranslateBlockClass,
  isContentEditable,
  isElementHidden,
  isInlineCandidate,
  isInsideArticle,
  isLowPriorityElement,
  isMetadataClass,
  isNonHTMLNamespace,
  isOverlayElement,
  isParagraphLikeElement,
  isValidText,
  shouldSkipByClass,
  shouldSkipBySiteRules,
  type ChildClassification,
} from './rules';
import { PATTERNS } from './constants';
import type { TextBlock } from './types';

// =============================================================================
// Per-Traversal 缓存
// =============================================================================
//
// 整次 collectBlocks 调用内的局部缓存, 一次遍历结束随 WeakMap GC, 无泄漏。
// 这是消除 O(N²) 重复计算的关键: 同一 element 在 DFS 父链上被多个祖先访问时,
// acceptNode / grabNode 共享同一份结果。
//
// - rejectedCache: REJECT 元素入表, 后代 O(1) 查表拒绝
// - directSetDescendantCache: 缓存 el 子树是否含 DIRECT_SET 元素
// - classifyCache: 缓存 classifyChildren(el) 结果
// - validTextCache: 缓存 isValidText(el.textContent) 结果
//
interface WalkCache {
  rejected: WeakSet<Element>;
  directSetDescendant: WeakMap<Element, boolean>;
  classify: WeakMap<Element, ChildClassification>;
  validText: WeakMap<Element, boolean>;
  // 噪声安全阀缓存 (per-traversal, 避免全局 WeakSet 跨调用残留)
  noiseMemo: WeakMap<Element, boolean>;
  /** root detection 已识别的噪声元素 (O(1) 跳过, 避免重复 shouldSkipByClass) */
  knownNoise: WeakSet<Element>;
}

/**
 * 检查 el 子树是否含 DIRECT_SET 元素 (DFS + 缓存).
 *
 * 关键优化: 之前是 el.querySelector(DIRECT_SET_CSS_SELECTOR), 对每个 DIRECT_SET
 * 元素 + 其 DIRECT_SET 子孙都要扫整子树, 复杂度 O(N²). 改用缓存后, 整树只扫一次.
 */
function hasDirectSetDescendant(el: Element, cache: WeakMap<Element, boolean>): boolean {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;

  // 手动 DFS (避开 querySelector 的 O(子节点数) 启动开销)
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (DIRECT_SET.has(child.tagName.toLowerCase())) {
      cache.set(el, true);
      return true;
    }
    if (hasDirectSetDescendant(child, cache)) {
      cache.set(el, true);
      return true;
    }
  }
  cache.set(el, false);
  return false;
}

/** 缓存 classifyChildren 结果 */
function getClassification(
  el: Element,
  cache: WeakMap<Element, ChildClassification>,
): ChildClassification {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;
  const result = classifyChildren(el);
  cache.set(el, result);
  return result;
}

/** 缓存 isValidText 结果 */
function getTextValid(
  el: Element,
  cache: WeakMap<Element, boolean>,
  pageUrl: string,
): boolean {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;
  const result = isValidText(el.textContent, pageUrl);
  cache.set(el, result);
  return result;
}

// =============================================================================
// FILTER_* 常量（linkedom 的 NodeFilter 类只导出了 SHOW_*，没有 FILTER_*）
// 这里按 W3C 规范手写：1 = ACCEPT, 2 = SKIP, 3 = REJECT。
// =============================================================================
const FILTER_ACCEPT = 1;
const FILTER_SKIP = 2;
const FILTER_REJECT = 3;

// =============================================================================
// NodeType 数值常量
// linkedom 和 jsdom 的 Text/Element 是不同的 class，instanceof 跨实现不工作。
// nodeType 是 W3C 标准 int，所有 DOM 实现一致。
// =============================================================================
const TEXT_NODE_TYPE = 3;
const ELEMENT_NODE_TYPE = 1;
const DOCUMENT_NODE_TYPE = 9;

// =============================================================================
// grabNode：把 walker 节点转成可翻译的 Element
// =============================================================================

/**
 * 从 walker 节点抓取可翻译的 Element。
 * 文本节点 → 找父 block-level 元素；Element → 自身。
 *
 * 优化: 使用 WalkCache 复用 acceptWalkerNode 已算过的 hasDirectSetDescendant /
 * classifyChildren / isValidText, 避免重复扫描同一子树.
 */
function grabNode(node: Node, cache: WalkCache, pageUrl: string): Element | false {
  if (!node || node.nodeType === TEXT_NODE_TYPE) return false;
  if (node.nodeType !== ELEMENT_NODE_TYPE) return false;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  // 1) 块级元素 (DIRECT_SET) 或段落类容器 (如 Draft.js 段落): 若子树还有 DIRECT_SET 元素,自身不算
  //    (子块会被独立抓到,避免重复)。段落类 div 自身作为整块返回。
  if (DIRECT_SET.has(tag) || isParagraphLikeElement(el)) {
    if (DIRECT_SET.has(tag) && hasDirectSetDescendant(el, cache.directSetDescendant)) return false;
    return getTextValid(el, cache.validText, pageUrl) ? el : false;
  }

  // 2) 内联元素: 在 article 内且无块级父 → 单独抓; 否则跳过
  if (INLINE_SET.has(tag)) {
    if (isInsideArticle(el) && !hasBlockLevelParent(el)) {
      return getTextValid(el, cache.validText, pageUrl) ? el : false;
    }
    return false;
  }

  // 3) 其他 (div, section, article...): 看子节点结构
  const { hasDirectText, hasNonInlineChild } = getClassification(el, cache.classify);
  if (hasNonInlineChild) return false; // 容器,子树会被独立处理
  if (hasDirectText) {
    return getTextValid(el, cache.validText, pageUrl) ? el : false;
  }
  return false;
}

// =============================================================================
// acceptWalkerNode：决定单个节点的 FILTER_* 状态
// =============================================================================

/**
 * 手写 acceptNode 回调：决定 node 的 FILTER_* 状态。
 *
 * 逻辑分层（从最快到最慢）:
 *   0) 父已被拒 → O(1) 直接 REJECT
 *   1) 硬性拒绝 (命名空间 / skip tag / hidden / metadata / site rules)
 *   2) <header> 含标题 → SKIP（走子树），不含 → REJECT
 *   3) 语义噪声 (footer/nav/aside) → REJECT
 *   4) DIRECT_SET → 子树有 DIRECT_SET descendant → SKIP，否则 ACCEPT
 *   5) 其他容器 → 按子节点结构决定 SKIP / ACCEPT
 *
 * 为什么 inline 元素（INLINE_SET）在这里不处理：
 *   grabNode() 会把它们转成 block-level 父元素或自身；acceptNode 阶段
 *   只管"是否允许 walker 继续"，不负责翻译粒度。
 */
function acceptWalkerNode(
  node: Node,
  counters: WalkerCounters,
  cache: WalkCache,
  pageUrl: string
): number {
  // 文本节点: 仅当父被拒时连坐拒绝;否则接受让 grabNode 评估
  if (node.nodeType === TEXT_NODE_TYPE) {
    if (node.parentElement && cache.rejected.has(node.parentElement)) {
      return FILTER_REJECT;
    }
    return FILTER_ACCEPT;
  }

  if (node.nodeType !== ELEMENT_NODE_TYPE) {
    return FILTER_SKIP;
  }

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  // 0) 父已被拒 → 整棵连坐拒绝 (O(1) 查表,避免向上回溯)
  if (el.parentElement && cache.rejected.has(el.parentElement)) {
    cache.rejected.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }

  // ⭐ 标记低优先级元素和弹窗（用于翻译结果页的视觉处理）
  if (isOverlayElement(el)) {
    el.setAttribute('data-fanyi-remove', 'true');
  } else if (isLowPriorityElement(el)) {
    el.setAttribute('data-fanyi-low-priority', 'true');
  }

  // 1) 硬性拒绝条件 (整棵子树拒绝,无例外)
  if (isNonHTMLNamespace(el)) {
    cache.rejected.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  // 嵌套 <body> / <html>（parent 不是文档级 <html> 或 #document）不拒绝：
  // WordPress CMS（如 github.blog）会在正文 <section> 内注入
  //   <!DOCTYPE><html><body><p>正文段落</p></body></html>
  // linkedom 解析后产生嵌套 <html><body>，其子节点是正文内容，
  // 不应因 <html>/<body> 在 SKIP_SET 中而被整棵跳过。
  // 文档级 <html>/<body> 不会被 walker 访问到（遍历起始于
  // <main>/<article> 等下游容器），所以放行嵌套标签是安全的。
  const skipSetMatch = SKIP_SET.has(tag);
  // 嵌套 <body>: WordPress CMS 会在正文容器内注入完整 HTML 文档,
  //   <section class="post__content"><html><body><p>正文</p></body></html></section>
  // linkedom 解析后保留这些嵌套标签, 但其父元素不是 document.documentElement。
  // 旧版用 parentElement.tagName !== 'html' 判断, 但嵌套 <body> 的父元素也是
  // 嵌套 <html>, 导致误判为文档级 body 而整棵拒绝, 正文全部丢失。
  const isNestedBody = tag === 'body' && el.parentElement !== el.ownerDocument?.documentElement;
  const isNestedHtml = tag === 'html' && el.parentElement !== null && el.parentElement !== undefined && el.parentElement !== el.ownerDocument?.documentElement;
  if ((skipSetMatch && !isNestedBody && !isNestedHtml) || hasTranslateBlockClass(el) || isContentEditable(el)) {
    cache.rejected.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  if (isElementHidden(el)) {
    cache.rejected.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  // 快速路径: root detection 已标记的噪声元素直接拒绝 (O(1) WeakSet 查找)
  if (cache.knownNoise.has(el)) {
    cache.rejected.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  if (shouldSkipByClass(el, cache.noiseMemo) || shouldSkipBySiteRules(el, pageUrl)) {
    // article / main 例外：噪声类（如 has-sidebar）命中时只跳过自身、继续下钻子树，
    // 避免整棵正文被拒（404media.co 的 <article class="... has-sidebar"> 因 "sidebar"
    // 模式被整棵拒绝，正文全失）。与下方元数据类守卫对 article/main 的特例保持一致。
    // 不扩展到 div / section，否则 ad-content / sponsored-content 等噪声容器会被下钻提取。
    if (tag === 'article' || tag === 'main') {
      counters.skipped++;
      return FILTER_SKIP;
    }
    cache.rejected.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  // 结构容器标签（article/main）和带内容 token 的容器元素（section/div）：
  // 不因元数据类名而拒绝。
  // 像 WordPress 的 <article class="category-ai"> 或
  // <section class="post__content category-ai-and-ml"> 中 "category"
  // 会命中 METADATA_TOKENS，导致整篇文章子树被拒绝，正文丢失翻译。
  // 对 section/div, 当同时拥有内容 token (post/content/article/story/entry/rich) 时,
  // 它是正文容器, 不应因 metadata class 被拒绝。
  // 注意: 仅限容器标签, <p class="post-meta"> 等叶子节点仍应被拒绝。
  const isContainerWithContent =
    (tag === 'section' || tag === 'div') && hasContentTokens(el);
  if (
    tag !== 'article' && tag !== 'main' &&
    isMetadataClass(el) && !isContainerWithContent
  ) {
    // 文章元数据 (作者 / 日期 / 分类) 整棵子树拒绝
    cache.rejected.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }

  // 2) <header> 特殊处理: 文章 header vs 页面 chrome
  //    - 含 h1-h6 → 跳过自身, 走子树 (文章标题要翻)
  //    - 不含     → 整棵拒绝 (navbar / site-header)
  if (tag === 'header') {
    // 用 hasDirectSetDescendant 缓存过的子查询 (h1-h6 ⊂ DIRECT_SET ∪? 不, 改用专门的 h 查询)
    // 这里 header 内含 h1-h6 是 <header> 内文章标题场景, 不频繁, 不额外缓存
    const hasHeading = el.querySelector('h1, h2, h3, h4, h5, h6') !== null;
    if (hasHeading) {
      counters.skipped++;
      return FILTER_SKIP;
    }
    cache.rejected.add(el);
    counters.skipped++;
    return FILTER_REJECT;
  }

  // 3) 其他语义噪声 (footer / aside / nav): 整棵拒绝
  if (SEMANTIC_SKIP_TAGS.has(tag)) {
    cache.rejected.add(el);
    counters.skipped++;
    return FILTER_REJECT;
  }

  // DIRECT_SET 与段落类容器: 只按文本有效性决定 ACCEPT / SKIP
  if (DIRECT_SET.has(tag) || isParagraphLikeElement(el)) {
    return getTextValid(el, cache.validText, pageUrl)
      ? FILTER_ACCEPT
      : FILTER_SKIP;
  }

  // 5) 其他容器: 看子节点结构决定 (用缓存的 classifyChildren)
  const { hasDirectText, hasNonEmptyElement, hasOnlyInlineChildren } =
    getClassification(el, cache.classify);

  if (!hasOnlyInlineChildren) {
    // 容器元素: 走子树 (skip 自身, 不影响遍历)
    counters.skipped++;
    return FILTER_SKIP;
  }
  if (hasDirectText || hasNonEmptyElement) {
    if (getTextValid(el, cache.validText, pageUrl)) {
      counters.accepted++;
      return FILTER_ACCEPT;
    }
  }
  counters.skipped++;
  return FILTER_SKIP;
}

// =============================================================================
// 主收集函数
// =============================================================================

/**
 * 从 startNode 出发, 收集所有翻译块到 blocks。
 * 同时跨 Shadow DOM 边界 (Reddit <shreddit-post> 等)。
 *
 * 实现：手写递归 walk，逻辑等价于 createTreeWalker 的 whatToShow=SHOW_ALL
 * + acceptNode callback，但 jsdom / linkedom / 浏览器都能跑。
 *
 * 优化:
 *   - Per-traversal WalkCache: 消除 O(N²) 重复 querySelector / classify / text 校验
 *   - headingStack: O(1) 块上下文快照, 替代 O(tree) 反查
 *   - Shadow DOM 合并: walkNode 内 inline, 消除 2N 重复扫描
 *   - indexed for: 避免 Array.from 临时数组分配
 */
export function collectBlocks(
  startNode: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number },
  seenTexts: Set<string>,
  pageUrl: string,
  /** root detection 已识别的噪声集合 (可选, 注入到 WalkCache.knownNoise) */
  preNoiseSet?: WeakSet<Element>,
): WalkerCounters {
  const t0 = performance.now();
  const counters = { rejected: 0, skipped: 0, accepted: 0 };
  const cache: WalkCache = {
    rejected: new WeakSet<Element>(),
    directSetDescendant: new WeakMap<Element, boolean>(),
    classify: new WeakMap<Element, ChildClassification>(),
    validText: new WeakMap<Element, boolean>(),
    noiseMemo: new WeakMap(),
    // 共享 root detection 的 noiseSet: 已识别的 consent SDK 容器直接 O(1) 跳过,
    // 避免 collectBlocks 重复调用 shouldSkipByClass / isConsentSdkContainer。
    // 未传 preNoiseSet 时回退到空 WeakSet, 保持原有行为。
    knownNoise: preNoiseSet ?? new WeakSet(),
  };
  // headingStack / headingLevels: 基于 heading 级别的 outline 栈。
  //
  // 语义: 遇到 heading 时, 先弹出所有 >= 当前级别的旧 heading, 再 push。
  //   - h1 "React Hooks" → push → 后续 block 的 headingPath = ["React Hooks"]
  //   - h2 "Hooks Intro" → push → headingPath = ["React Hooks", "Hooks Intro"]
  //   - h1 "Vue Signals" → pop "Hooks Intro" + "React Hooks", push "Vue Signals"
  //     → headingPath = ["Vue Signals"]
  //
  // 这解决了旧版 "只 push 不 pop" 的问题 (所有 heading 累积, 后面 block 拿到
  // 所有前面的 heading), 同时保留了 HTML 中 heading 作为 sibling 的语义
  // (heading 后续的同级 block 能拿到 heading 作为上下文)。
  const headingStack: string[] = [];
  const headingLevels: number[] = [];

  // startNode 自身不被 visit（与 TreeWalker 行为一致：root 是位置，不是节点），
  // 第一个 visit 的是它的 childNodes。
  const children = startNode.childNodes;
  for (let i = 0; i < children.length; i++) {
    walkNode(children[i], blocks, blockIdRef, seenTexts, counters, cache, headingStack, headingLevels, pageUrl);
  }

  // Shadow DOM 处理已合并到 walkNode 内部, 不再需要 collectFromShadowHosts 第二轮扫描.

  console.log(`[PERF]   collectBlocks ${Math.round((performance.now() - t0) * 1000)}µs (rejected=${counters.rejected} skipped=${counters.skipped} accepted=${counters.accepted})`);

  return counters;
}

/**
 * 递归 visit 单个节点：
 *   - FILTER_REJECT → 整棵子树跳过
 *   - FILTER_ACCEPT → grabNode() 评估，合格就 push
 *   - FILTER_SKIP   → 不 grab，继续 recurse 子节点
 *
 * 优化:
 *   - headingStack DFS 维护, O(1) snapshot
 *   - shadowRoot 内部递归, 单次扫描覆盖 light + shadow tree
 *   - indexed for 替代 Array.from
 */
function walkNode(
  node: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number },
  seenTexts: Set<string>,
  counters: WalkerCounters,
  cache: WalkCache,
  headingStack: string[],
  headingLevels: number[],
  pageUrl: string
): void {
  const verdict = acceptWalkerNode(node, counters, cache, pageUrl);
  if (verdict === FILTER_REJECT) return;

  // Heading outline stack: 遇到 heading 时, 先弹出 >= 当前级别的旧 heading,
  // 再 push。这样后续同级 block 能拿到 heading 作为上下文,
  // 而同级新 heading 出现时旧 heading 被自动清除。
  if (verdict !== FILTER_REJECT && node.nodeType === ELEMENT_NODE_TYPE) {
    const tag = (node as Element).tagName.toLowerCase();
    const headingMatch = tag.match(/^h([1-6])$/);
    if (headingMatch) {
      const level = parseInt(headingMatch[1], 10);
      // 弹出所有 >= 当前级别的 heading (开启新 section)
      while (headingLevels.length > 0 && headingLevels[headingLevels.length - 1] >= level) {
        headingStack.pop();
        headingLevels.pop();
      }
      headingStack.push((node as Element).textContent?.trim() || '');
      headingLevels.push(level);
    }
  }

  if (verdict === FILTER_ACCEPT) {
    const translateNode = grabNode(node, cache, pageUrl);
    if (translateNode) {
      const text = translateNode.textContent?.trim();
      if (text) {
        if (seenTexts.has(text)) {
          counters.skipped++;
        } else {
          seenTexts.add(text);
          const id = `b${++blockIdRef.value}`;
          try {
            (translateNode as unknown as { dataset: Record<string, string> }).dataset.fanyiBlockId = id;
          } catch {
            /* ignore */
          }
          const isCandidate = isInlineCandidate(translateNode, text);
          blocks.push({
            id,
            xpath: getXPath(translateNode),
            tag: translateNode.tagName.toLowerCase(),
            text,
            renderHint: isCandidate ? { inlineCandidate: true } : undefined,
            context: {
              // O(1) snapshot: headingStack 反映当前节点的 heading outline 路径。
              // heading 自身已 push, 所以 heading block 的 headingPath 含自身。
              headingPath: headingStack.slice(),
              position: blockIdRef.value,
            },
          });
        }
      }
    }
  }

  // Shadow DOM 合并: 若当前节点是 shadow host, 立即递归 shadowRoot.
  if (node.nodeType === ELEMENT_NODE_TYPE) {
    const shadow = (node as unknown as { shadowRoot?: { mode: string; childNodes: NodeListOf<ChildNode> } | null }).shadowRoot;
    if (shadow && shadow.mode === 'open') {
      const shadowChildren = shadow.childNodes;
      for (let i = 0; i < shadowChildren.length; i++) {
        walkNode(shadowChildren[i], blocks, blockIdRef, seenTexts, counters, cache, headingStack, headingLevels, pageUrl);
      }
    }
  }

  // ACCEPT 和 SKIP 都要继续 recurse 子节点（TreeWalker 行为一致）
  const childList = node.childNodes;
  for (let i = 0; i < childList.length; i++) {
    walkNode(childList[i], blocks, blockIdRef, seenTexts, counters, cache, headingStack, headingLevels, pageUrl);
  }
}

// =============================================================================
// XPath (辅助, 翻译回填定位)
// =============================================================================

/**
 * 生成元素 XPath, 用于回退查找 (data attr 优先).
 *
 * 复杂度: O(深度 × 兄弟数) — 实际上每个节点的兄弟遍历是 O(1) 因为 data-fanyi-block-id
 * 已经能直接定位, XPath 只在 dataset 写入失败时作为兜底, 调用频率极低.
 */
export function getXPath(node: Node): string {
  if (node.nodeType === DOCUMENT_NODE_TYPE) return '';
  if (node.nodeType !== ELEMENT_NODE_TYPE) return '';

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
