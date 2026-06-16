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
  hasTranslateBlockClass,
  isContentEditable,
  isElementHidden,
  isInlineCandidate,
  isInsideArticle,
  isLowPriorityElement,
  isMetadataClass,
  isNonHTMLNamespace,
  isOverlayElement,
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
  // ⭐ NEW: lightweight soft score hint (VERY cheap heuristic)
  scoreHint: WeakMap<Element, number>;
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
// NEW: ultra-cheap heuristic score hint
// =============================================================================
//
// 只用于：
// - sidebar / article 混排
// - SPA wrapper vs real article body
// - 提前"倾向性"判断，而不是硬过滤
//
function computeSoftHint(el: Element): number {
  let score = 0;

  const cls = (el.className || '').toLowerCase();

  if (cls.includes('article') || cls.includes('post')) score += 2;
  if (cls.includes('content') || cls.includes('body')) score += 2;
  if (cls.includes('main')) score += 1;

  if (cls.includes('sidebar') || cls.includes('nav')) score -= 3;
  if (cls.includes('footer') || cls.includes('comment')) score -= 2;

  return score;
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

  // 1) 块级元素 (DIRECT_SET): 若子树还有 DIRECT_SET 元素,自身不算
  //    (子块会被独立抓到,避免重复)
  if (DIRECT_SET.has(tag)) {
    if (hasDirectSetDescendant(el, cache.directSetDescendant)) return false;
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
  if (SKIP_SET.has(tag) || hasTranslateBlockClass(el) || isContentEditable(el)) {
    cache.rejected.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  if (isElementHidden(el)) {
    cache.rejected.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  if (shouldSkipByClass(el) || shouldSkipBySiteRules(el, pageUrl)) {
    cache.rejected.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  if (isMetadataClass(el)) {
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

  // ==========================================================
  // ⭐ NEW: soft ranking hint injection (minimal change)
  // ==========================================================
  const hint = cache.scoreHint.get(el) ?? computeSoftHint(el);
  cache.scoreHint.set(el, hint);

  // ⭐ NEW: instead of hard skip for DIRECT_SET, bias via hint
  if (DIRECT_SET.has(tag)) {
    if (hint < 0) {
      counters.skipped++;
      return FILTER_SKIP;
    }
    return getTextValid(el, cache.validText, pageUrl)
      ? FILTER_ACCEPT
      : FILTER_SKIP;
  }

  // 5) 其他容器: 看子节点结构决定 (用缓存的 classifyChildren)
  const { hasDirectText, hasNonEmptyElement, hasOnlyInlineChildren } =
    getClassification(el, cache.classify);

  if (!hasOnlyInlineChildren) {
    // ⭐ CHANGED: soft skip instead of hard structural skip
    if (hint >= 2) return FILTER_SKIP;
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
  pageUrl: string
): WalkerCounters {
  const t0 = performance.now();
  const counters = { rejected: 0, skipped: 0, accepted: 0 };
  const cache: WalkCache = {
    rejected: new WeakSet<Element>(),
    directSetDescendant: new WeakMap<Element, boolean>(),
    classify: new WeakMap<Element, ChildClassification>(),
    validText: new WeakMap<Element, boolean>(),
    // ⭐ NEW
    scoreHint: new WeakMap(),
  };
  // headingStack: 维护 DFS 过程中遇到的所有 h1-h6, 块提取时 O(1) snapshot.
  // 与原 getHeadingPath (向上 + 向左 + 递归子树) 语义对齐: 反映"文档顺序
  // previous-headings 链", 即到当前节点为止见过的所有 h1-h6.
  //
  // 实现选择: 只 push 不 pop.
  //   - 优点: 简单, O(1) per heading, 兄弟子树间天然连续 (例如 h1/h2/h2 三个
  //     兄弟 heading, 第二个 h2 的 block 仍能拿到第一个 h2 的文本作为上下文).
  //   - 缺点: 栈会随 heading 数增长, 但单页 h1-h6 通常 < 30, 完全可接受.
  //   - pop 方案 (DFS enter/exit 对称) 在兄弟结构上会过早弹出, 导致第二个
  //     heading 的 headingPath 看不到第一个 heading, 行为偏离原 getHeadingPath.
  const headingStack: string[] = [];

  // startNode 自身不被 visit（与 TreeWalker 行为一致：root 是位置，不是节点），
  // 第一个 visit 的是它的 childNodes。
  const children = startNode.childNodes;
  for (let i = 0; i < children.length; i++) {
    walkNode(children[i], blocks, blockIdRef, seenTexts, counters, cache, headingStack, pageUrl);
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
  pageUrl: string
): void {
  const verdict = acceptWalkerNode(node, counters, cache, pageUrl);
  if (verdict === FILTER_REJECT) return;

  if (verdict === FILTER_ACCEPT) {
    const translateNode = grabNode(node, cache, pageUrl);
    if (translateNode) {
      const text = translateNode.textContent?.trim();
      if (text) {
        // 去重: 同样的段落出现在多个 callout (e.g. HBR summary box + body) 只取一个。
        // 节省 API 调用 + 避免堆叠相同译文。
        if (seenTexts.has(text)) {
          counters.skipped++;
        } else {
          seenTexts.add(text);
          const id = `b${++blockIdRef.value}`;
          // dataset 写入：linkedom 支持；jsdom 支持；旧浏览器不支持
          // （dataset 是 ES2015 起的标准，所有目标环境都满足）
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
              // O(1) snapshot: headingStack 是当前节点之前遇到的 h1-h6,
              // 自身 heading 不包含在自身 headingPath 里 (与原 getHeadingPath 行为一致).
              headingPath: headingStack.slice(),
              position: blockIdRef.value,
            },
          });
        }
      }
    }
  }

  // 维护 headingStack: 当前节点是 h1-h6 时 push (不 pop, 单调增长).
  // push 在 block 创建之后, 这样:
  //   - 当前 heading 自身的 block.headingPath 不含自己 (snapshot 在 push 前)
  //   - 后续兄弟节点能拿到这个 heading 作为上下文
  // 复杂度: O(1) per heading, 栈大小受页内 h1-h6 总数限制 (通常 < 30).
  // 注: PATTERNS.HEADING 是 /^H[1-6]$/ (大写 H), tagName 在 HTML 中是
  // 大写, 在 linkedom/svg 中可能是小写, 统一在测试时 /i case-insensitive.
  if (node.nodeType === ELEMENT_NODE_TYPE) {
    const tag = (node as Element).tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      headingStack.push((node as Element).textContent?.trim() || '');
    }
  }

  // Shadow DOM 合并: 若当前节点是 shadow host, 立即递归 shadowRoot.
  // 整次 DFS 同时覆盖 light DOM + shadow tree, 避免 collectFromShadowHosts
  // 二次扫描整树. host 自身的 light DOM 也会被正常访问 (下面的 childNodes 循环),
  // shadowRoot 内部节点通过本次调用栈独立处理, 与原 collectFromShadowHosts 行为一致.
  if (node.nodeType === ELEMENT_NODE_TYPE) {
    const shadow = (node as unknown as { shadowRoot?: { mode: string; childNodes: NodeListOf<ChildNode> } | null }).shadowRoot;
    if (shadow && shadow.mode === 'open') {
      const shadowChildren = shadow.childNodes;
      for (let i = 0; i < shadowChildren.length; i++) {
        walkNode(shadowChildren[i], blocks, blockIdRef, seenTexts, counters, cache, headingStack, pageUrl);
      }
    }
  }

  // ACCEPT 和 SKIP 都要继续 recurse 子节点（TreeWalker 行为一致）
  // indexed for 替代 Array.from, 避免每次迭代分配临时数组
  const childList = node.childNodes;
  for (let i = 0; i < childList.length; i++) {
    walkNode(childList[i], blocks, blockIdRef, seenTexts, counters, cache, headingStack, pageUrl);
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
