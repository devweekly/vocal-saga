/**
 * blockExtractor TreeWalker
 *
 * 核心遍历逻辑:
 *   1. createTreeWalker + acceptNode 决定每个节点的 FILTER_* 状态
 *   2. FILTER_ACCEPT 节点进 grabNode() 评估是否可作为翻译块
 *   3. 已拒绝的祖先进 WeakSet 缓存,后代 O(1) 查表拒绝,避免回溯父链
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
// grabNode: 把已 ACCEPT 的节点评估为"翻译块"或"非块"
// =============================================================================

/**
 * 是否值得作为翻译块返回。
 * 与 walker 的 acceptNode 不同: 这里做更细的内容检查 (text 有效性、子树结构)。
 * 节点已被 walker 接受,不代表它一定能作为翻译块 (e.g. 空 <p>)。
 */
function grabNode(node: Node): Element | false {
  if (!node || node instanceof Text) return false;
  if (!(node instanceof Element)) return false;

  const el = node;
  const tag = el.tagName.toLowerCase();

  // 1) 块级元素 (DIRECT_SET): 若子树还有 DIRECT_SET 元素,自身不算
  //    (子块会被独立抓到,避免重复)
  if (DIRECT_SET.has(tag)) {
    const hasDirectSetDescendant = el.querySelector(DIRECT_SET_CSS_SELECTOR) !== null;
    if (hasDirectSetDescendant) return false;
    return isValidText(el.textContent) ? el : false;
  }

  // 2) 内联元素: 在 article 内且无块级父 → 单独抓; 否则跳过
  if (INLINE_SET.has(tag)) {
    if (isInsideArticle(el) && !hasBlockLevelParent(el)) {
      return isValidText(el.textContent) ? el : false;
    }
    return false;
  }

  // 3) 其他 (div, section, article...): 看子节点结构
  const { hasDirectText, hasNonInlineChild } = classifyChildren(el);
  if (hasNonInlineChild) return false; // 容器,子树会被独立处理
  if (hasDirectText) {
    return isValidText(el.textContent) ? el : false;
  }
  return false;
}

// =============================================================================
// acceptNode: walker 的过滤回调
// =============================================================================

/**
 * TreeWalker 的 acceptNode: 决定 FILTER_ACCEPT / FILTER_SKIP / FILTER_REJECT。
 *
 * 状态机核心:
 *   - FILTER_REJECT = 跳过自身 + 整棵子树
 *   - FILTER_SKIP   = 跳过自身, 走子树
 *   - FILTER_ACCEPT = 自身进 grabNode, 不走子树
 *
 * 性能优化:
 *   1. rejectedCache (WeakSet) 缓存所有被 REJECT 的元素,后代 O(1) 拒绝
 *   2. 早返回: 便宜的检查放前面 (parent rejected, SKIP_SET)
 *   3. 隐藏/命名空间检查一旦失败立即入 cache
 */
function acceptWalkerNode(
  node: Node,
  counters: WalkerCounters,
  rejectedCache: WeakSet<Element>
): number {
  // 文本节点: 仅当父被拒时连坐拒绝;否则接受让 grabNode 评估
  if (node instanceof Text) {
    if (node.parentElement && rejectedCache.has(node.parentElement)) {
      return NodeFilter.FILTER_REJECT;
    }
    return NodeFilter.FILTER_ACCEPT;
  }

  if (!(node instanceof Element)) {
    return NodeFilter.FILTER_SKIP;
  }

  const el = node;
  const tag = el.tagName.toLowerCase();

  // 0) 父已被拒 → 整棵连坐拒绝 (O(1) 查表,避免向上回溯)
  if (el.parentElement && rejectedCache.has(el.parentElement)) {
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  // 1) 硬性拒绝条件 (整棵子树拒绝,无例外)
  if (isNonHTMLNamespace(el)) {
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }
  if (SKIP_SET.has(tag) || hasTranslateBlockClass(el) || isContentEditable(el)) {
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }
  if (isElementHidden(el)) {
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }
  if (shouldSkipByClass(el) || shouldSkipBySiteRules(el)) {
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }
  if (isMetadataClass(el)) {
    // 文章元数据 (作者 / 日期 / 分类) 整棵子树拒绝
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  // 2) <header> 特殊处理: 文章 header vs 页面 chrome
  //    - 含 h1-h6 → 跳过自身, 走子树 (文章标题要翻)
  //    - 不含     → 整棵拒绝 (navbar / site-header)
  if (tag === 'header') {
    const hasHeading = el.querySelector('h1, h2, h3, h4, h5, h6') !== null;
    if (hasHeading) {
      counters.skipped++;
      return NodeFilter.FILTER_SKIP;
    }
    rejectedCache.add(el);
    counters.skipped++;
    return NodeFilter.FILTER_REJECT;
  }

  // 3) 其他语义噪声 (footer / aside / nav): 整棵拒绝
  if (SEMANTIC_SKIP_TAGS.has(tag)) {
    rejectedCache.add(el);
    counters.skipped++;
    return NodeFilter.FILTER_REJECT;
  }

  // 4) DIRECT_SET 元素: 自身评估, 若子树还有 DIRECT_SET 则跳过 (让子块独立抓)
  if (DIRECT_SET.has(tag)) {
    const hasDirectSetDescendant = el.querySelector(DIRECT_SET_CSS_SELECTOR) !== null;
    if (hasDirectSetDescendant) {
      counters.skipped++;
      return NodeFilter.FILTER_SKIP;
    }
    if (isValidText(el.textContent)) {
      counters.accepted++;
      return NodeFilter.FILTER_ACCEPT;
    }
    counters.skipped++;
    return NodeFilter.FILTER_SKIP;
  }

  // 5) 其他容器: 看子节点结构决定
  const { hasDirectText, hasNonEmptyElement, hasOnlyInlineChildren } =
    classifyChildren(el);

  if (!hasOnlyInlineChildren) {
    counters.skipped++;
    return NodeFilter.FILTER_SKIP;
  }
  if (hasDirectText || hasNonEmptyElement) {
    if (isValidText(el.textContent)) {
      counters.accepted++;
      return NodeFilter.FILTER_ACCEPT;
    }
  }
  counters.skipped++;
  return NodeFilter.FILTER_SKIP;
}

// =============================================================================
// 主收集函数
// =============================================================================

/**
 * 从 startNode 出发, 收集所有翻译块到 blocks。
 * 同时跨 Shadow DOM 边界 (Reddit <shreddit-post> 等)。
 */
export function collectBlocks(
  startNode: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number },
  seenTexts: Set<string>
): WalkerCounters {
  const counters = { rejected: 0, skipped: 0, accepted: 0 };
  // Per-walker WeakSet: 被 REJECT 的元素入表, 后代 O(1) 查表。
  // 随 DOM GC, 无内存泄漏。
  const rejectedCache = new WeakSet<Element>();

  const walker = document.createTreeWalker(
    startNode,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => acceptWalkerNode(node, counters, rejectedCache),
    }
  );

  let currentNode: Node | null;
  while ((currentNode = walker.nextNode()) !== null) {
    const translateNode = grabNode(currentNode);
    if (!translateNode) continue;

    const text = translateNode.textContent?.trim();
    if (!text) continue;

    // 去重: 同样的段落出现在多个 callout (e.g. HBR summary box + body) 只取一个。
    // 节省 API 调用 + 避免堆叠相同译文。
    if (seenTexts.has(text)) {
      counters.skipped++;
      continue;
    }
    seenTexts.add(text);

    const id = `b${++blockIdRef.value}`;
    if (translateNode instanceof HTMLElement) {
      translateNode.dataset.fanyiBlockId = id;
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

  // TreeWalker 不跨 shadow root 边界, 手动遍历 open shadow roots。
  collectFromShadowHosts(startNode, blocks, blockIdRef, seenTexts);

  return counters;
}

/**
 * 递归遍历 host 元素的 open shadow root。
 * 用宽松的 walker (FILTER_ACCEPT) 拿到 host 自身, 检查 shadowRoot。
 */
function collectFromShadowHosts(
  root: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number },
  seenTexts: Set<string>
): void {
  const treeWalker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
    { acceptNode: () => NodeFilter.FILTER_ACCEPT }
  );

  let currentNode: Node | null;
  while ((currentNode = treeWalker.nextNode()) !== null) {
    if (!(currentNode instanceof Element)) continue;
    const shadow = currentNode.shadowRoot;
    if (shadow && shadow.mode === 'open') {
      collectBlocks(shadow, blocks, blockIdRef, seenTexts);
    }
  }
}

// =============================================================================
// XPath & Heading Path (辅助)
// =============================================================================

/** 生成元素 XPath, 用于回退查找 (data attr 优先)。 */
export function getXPath(node: Node): string {
  if (node.nodeType === Node.DOCUMENT_NODE) return '';
  if (!(node instanceof Element)) return '';

  const parts: string[] = [];
  let current: Element | null = node;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling: Element | null = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }
  return '/' + parts.join('/');
}

/** 收集元素之前所有 h1-h6 标题, 用于 context.headingPath。 */
function getHeadingPath(block: Element): string[] {
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
      if (current.nodeType === Node.ELEMENT_NODE) {
        const el = current as Element;
        if (isHeading(el)) return el;
        const found = findLastHeadingInSubtree(el);
        if (found) return found;
      }
    }
    current = current.parentElement;
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
