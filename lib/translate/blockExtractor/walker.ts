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
  isInsideArticle,
  isMetadataClass,
  isNonHTMLNamespace,
  isValidText,
  shouldSkipByClass,
  shouldSkipBySiteRules,
} from './rules';
import type { TextBlock } from './types';

/** DIRECT_SET 拼接成 CSS 选择器, 用于 querySelector 检查子树是否还有 DIRECT_SET 元素。 */
const DIRECT_SET_CSS_SELECTOR = Array.from(DIRECT_SET).join(',');

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
 */
function grabNode(node: Node, pageUrl: string): Element | false {
  if (!node || node.nodeType === TEXT_NODE_TYPE) return false;
  if (node.nodeType !== ELEMENT_NODE_TYPE) return false;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  // 1) 块级元素 (DIRECT_SET): 若子树还有 DIRECT_SET 元素,自身不算
  //    (子块会被独立抓到,避免重复)
  if (DIRECT_SET.has(tag)) {
    const hasDirectSetDescendant = el.querySelector(DIRECT_SET_CSS_SELECTOR) !== null;
    if (hasDirectSetDescendant) return false;
    return isValidText(el.textContent, pageUrl) ? el : false;
  }

  // 2) 内联元素: 在 article 内且无块级父 → 单独抓; 否则跳过
  if (INLINE_SET.has(tag)) {
    if (isInsideArticle(el) && !hasBlockLevelParent(el)) {
      return isValidText(el.textContent, pageUrl) ? el : false;
    }
    return false;
  }

  // 3) 其他 (div, section, article...): 看子节点结构
  const { hasDirectText, hasNonInlineChild } = classifyChildren(el);
  if (hasNonInlineChild) return false; // 容器,子树会被独立处理
  if (hasDirectText) {
    return isValidText(el.textContent, pageUrl) ? el : false;
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
  rejectedCache: WeakSet<Element>,
  pageUrl: string
): number {
  // 文本节点: 仅当父被拒时连坐拒绝;否则接受让 grabNode 评估
  if (node.nodeType === TEXT_NODE_TYPE) {
    if (node.parentElement && rejectedCache.has(node.parentElement)) {
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
  if (el.parentElement && rejectedCache.has(el.parentElement)) {
    rejectedCache.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }

  // 1) 硬性拒绝条件 (整棵子树拒绝,无例外)
  if (isNonHTMLNamespace(el)) {
    rejectedCache.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  if (SKIP_SET.has(tag) || hasTranslateBlockClass(el) || isContentEditable(el)) {
    rejectedCache.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  if (isElementHidden(el)) {
    rejectedCache.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  if (shouldSkipByClass(el) || shouldSkipBySiteRules(el, pageUrl)) {
    rejectedCache.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }
  if (isMetadataClass(el)) {
    // 文章元数据 (作者 / 日期 / 分类) 整棵子树拒绝
    rejectedCache.add(el);
    counters.rejected++;
    return FILTER_REJECT;
  }

  // 2) <header> 特殊处理: 文章 header vs 页面 chrome
  //    - 含 h1-h6 → 跳过自身, 走子树 (文章标题要翻)
  //    - 不含     → 整棵拒绝 (navbar / site-header)
  if (tag === 'header') {
    const hasHeading = el.querySelector('h1, h2, h3, h4, h5, h6') !== null;
    if (hasHeading) {
      counters.skipped++;
      return FILTER_SKIP;
    }
    rejectedCache.add(el);
    counters.skipped++;
    return FILTER_REJECT;
  }

  // 3) 其他语义噪声 (footer / aside / nav): 整棵拒绝
  if (SEMANTIC_SKIP_TAGS.has(tag)) {
    rejectedCache.add(el);
    counters.skipped++;
    return FILTER_REJECT;
  }

  // 4) DIRECT_SET 元素: 自身评估, 若子树还有 DIRECT_SET 则跳过 (让子块独立抓)
  if (DIRECT_SET.has(tag)) {
    const hasDirectSetDescendant = el.querySelector(DIRECT_SET_CSS_SELECTOR) !== null;
    if (hasDirectSetDescendant) {
      counters.skipped++;
      return FILTER_SKIP;
    }
    if (isValidText(el.textContent)) {
      counters.accepted++;
      return FILTER_ACCEPT;
    }
    counters.skipped++;
    return FILTER_SKIP;
  }

  // 5) 其他容器: 看子节点结构决定
  const { hasDirectText, hasNonEmptyElement, hasOnlyInlineChildren } =
    classifyChildren(el);

  if (!hasOnlyInlineChildren) {
    counters.skipped++;
    return FILTER_SKIP;
  }
  if (hasDirectText || hasNonEmptyElement) {
    if (isValidText(el.textContent)) {
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
  // Per-walker WeakSet: 被 REJECT 的元素入表, 后代 O(1) 查表。
  // 随 DOM GC, 无内存泄漏。
  const rejectedCache = new WeakSet<Element>();

  // startNode 自身不被 visit（与 TreeWalker 行为一致：root 是位置，不是节点），
  // 第一个 visit 的是它的 childNodes。
  for (const child of Array.from(startNode.childNodes)) {
    walkNode(child, blocks, blockIdRef, seenTexts, counters, rejectedCache, pageUrl);
  }

  // TreeWalker 不跨 shadow root 边界, 手动遍历 open shadow roots。
  collectFromShadowHosts(startNode, blocks, blockIdRef, seenTexts, pageUrl);

  console.log(`[PERF]   collectBlocks ${Math.round((performance.now() - t0) * 1000)}µs (rejected=${counters.rejected} skipped=${counters.skipped} accepted=${counters.accepted})`);

  return counters;
}

/**
 * 递归 visit 单个节点：
 *   - FILTER_REJECT → 整棵子树跳过
 *   - FILTER_ACCEPT → grabNode() 评估，合格就 push
 *   - FILTER_SKIP   → 不 grab，继续 recurse 子节点
 */
function walkNode(
  node: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number },
  seenTexts: Set<string>,
  counters: WalkerCounters,
  rejectedCache: WeakSet<Element>,
  pageUrl: string
): void {
  const verdict = acceptWalkerNode(node, counters, rejectedCache, pageUrl);
  if (verdict === FILTER_REJECT) return;

  if (verdict === FILTER_ACCEPT) {
    const translateNode = grabNode(node, pageUrl);
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
          blocks.push({
            id,
            xpath: getXPath(translateNode),
            tag: translateNode.tagName.toLowerCase(),
            text,
            context: {
              headingPath: getHeadingPath(translateNode),
              position: blockIdRef.value,
            },
          });
        }
      }
    }
  }

  // ACCEPT 和 SKIP 都要继续 recurse 子节点（TreeWalker 行为一致）
  for (const child of Array.from(node.childNodes)) {
    walkNode(child, blocks, blockIdRef, seenTexts, counters, rejectedCache, pageUrl);
  }
}

// =============================================================================
// Shadow DOM 处理
// =============================================================================

function collectFromShadowHosts(
  root: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number },
  seenTexts: Set<string>,
  pageUrl: string
): void {
  for (const child of Array.from(root.childNodes)) {
    walkForShadow(child, blocks, blockIdRef, seenTexts, pageUrl);
  }
}

/** shadow-host 巡检专用：找到所有 Element，看是否有 open shadowRoot。 */
function walkForShadow(
  node: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number },
  seenTexts: Set<string>,
  pageUrl: string
): void {
  if (node.nodeType === ELEMENT_NODE_TYPE) {
    const shadow = (node as unknown as { shadowRoot?: { mode: string } | null }).shadowRoot;
    if (shadow && shadow.mode === 'open') {
      // 递归进 shadowRoot（不是 host 本身，host 的 light DOM 已经被 collectBlocks
      // 处理过了；这里只看 shadow tree 里的内容）
      const shadowCounters = collectBlocks(
        shadow as unknown as Node,
        blocks,
        blockIdRef,
        seenTexts,
        pageUrl
      );
      void shadowCounters;
      // shadow 内部的节点不再继续（避免重复处理）
      return;
    }
  }
  for (const child of Array.from(node.childNodes)) {
    walkForShadow(child, blocks, blockIdRef, seenTexts, pageUrl);
  }
}

// =============================================================================
// XPath & Heading Path (辅助)
// =============================================================================

/** 生成元素 XPath, 用于回退查找 (data attr 优先)。 */
export function getXPath(node: Node): string {
  if (node.nodeType === DOCUMENT_NODE_TYPE) return '';
  if (node.nodeType !== ELEMENT_NODE_TYPE) return '';

  const t0 = performance.now();
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
  // 单次 < 0.1ms 不单独打，collectBlocks 已汇总总耗时。
  return '/' + parts.join('/');
}

/** 获取元素的前置 heading 路径（兄弟/祖先链上最近的 h1-h6 文本列表）。 */
export function getHeadingPath(block: Element): string[] {
  const t0 = performance.now();
  const headings: string[] = [];
  let current: Element | null = block;
  while (current) {
    const prev = findPreviousHeading(current);
    if (!prev) break;
    headings.unshift(prev.textContent?.trim() || '');
    current = prev;
  }
  return headings;
}

function findPreviousHeading(element: Element): Element | null {
  let current: Node | null = element;
  while (current) {
    // 兄弟节点倒序遍历
    while (current.previousSibling) {
      current = current.previousSibling;
      if (current.nodeType === ELEMENT_NODE_TYPE) {
        const el = current as Element;
        if (isHeading(el)) return el;
        const found = findLastHeadingInSubtree(el);
        if (found) return found;
      }
    }
    current = (current as Element).parentElement;
  }
  return null;
}

function findLastHeadingInSubtree(element: Element): Element | null {
  for (const child of Array.from(element.children).reverse()) {
    if (isHeading(child)) return child;
    const found = findLastHeadingInSubtree(child);
    if (found) return found;
  }
  return null;
}

function isHeading(el: Element): boolean {
  return /^H[1-6]$/.test(el.tagName);
}
