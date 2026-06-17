/**
 * blockExtractor 公共 API
 *
 * 负责对外暴露的函数和类型。内部实现拆分为:
 *   - ./constants  静态数据 (regex, set, 跳过类名, 计数接口)
 *   - ./rules      谓词 (shouldSkip*, is*, classifyChildren, ...)
 *   - ./walker     TreeWalker 收集 (collectBlocks, acceptNode, grabNode)
 *
 * 公开 API:
 *   - extractBlocks(rootNode)         主入口: 提取所有翻译块
 *   - findBlockNode(block, root)      按 id 查回 DOM 节点 (data attr + XPath 兜底)
 *   - buildNodeMap(blocks, root)      构建 blockId → Node 的 Map
 *
 * 为什么不直接用 Mozilla Readability:
 *   - Readability 是"挑出主文章"模式,返回单一 article 节点,适合 Reader View。
 *   - 我们需要"逐块翻译整页所有可读文本",必须保留 nav / sidebar 之外的
 *     所有正文,模型逐块收到独立 context 才能稳定返回 JSON。
 *   - 同类翻译扩展 (XTranslate, 侧边翻译, Read Frog) 都用 block-walking
 *     方案,这是行业标准。
 */

import { collectBlocks, getXPath } from './walker';
import type { TextBlock } from './types';

export type { TextBlock };

/**
 * 从 rootNode 出发抽取所有翻译块。
 * @param rootNode Document 或 DocumentFragment
 * @param pageUrl 当前页面 URL，用于站点规则匹配（不再读 window.location.href）
 * @returns 顺序的 TextBlock 数组
 */
export function extractBlocks(rootNode: Node, pageUrl: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const blockIdRef = { value: 0 };
  // 跨段落去重: 同一文本多次出现只取第一个 (HBR summary callout 模式)。
  const seenTexts = new Set<string>();

  const startNode =
    rootNode.nodeType === 9 /* DOCUMENT_NODE */
      ? (rootNode as Document).body || (rootNode as Document).documentElement
      : rootNode;
  if (!startNode) {
    console.warn('[BlockExtractor] No valid start node found');
    return [];
  }

  collectBlocks(startNode, blocks, blockIdRef, seenTexts, pageUrl);
  return blocks;
}

/**
 * 按 block.id 找回 DOM 节点。
 * 优先用临时 data 属性 (更健壮, 抗 DOM 变化), 回退到 XPath。
 */
export function findBlockNode(block: TextBlock, root: Document): Node | null {
  const el = root.querySelector(`[data-fanyi-block-id="${block.id}"]`);
  if (el) return el;

  try {
    const result = root.evaluate(
      block.xpath,
      root,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return result.singleNodeValue;
  } catch {
    return null;
  }
}

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
      // renderHint 和 context 信息在扩展端 walker 中已丢失，
      // 但回填时只需要 id 即可定位元素，不影响核心功能。
      // 如需完整 renderHint，扩展端可通过 data-fanyi-inline-candidate 属性传递。
    });
  });

  // 按 b1, b2, b10... 的数值顺序排序，避免字典序 b10 < b2
  blocks.sort((a, b) => {
    const na = parseInt(a.id.replace(/^b/, ''), 10) || 0;
    const nb = parseInt(b.id.replace(/^b/, ''), 10) || 0;
    return na - nb;
  });

  console.log(`[BlockExtractor] Extracted ${blocks.length} blocks from pre-marked HTML`);
  return blocks;
}

/** 批量构建 blockId → Node 映射, 用于翻译应用阶段。 */
export function buildNodeMap(
  blocks: TextBlock[],
  root: Document
): Map<string, Node> {
  const map = new Map<string, Node>();
  for (const block of blocks) {
    const node = findBlockNode(block, root);
    if (node) map.set(block.id, node);
  }
  return map;
}

// 重新导出内部模块供测试 / 高级用法使用
export { PATTERNS, MIN_TEXT_LENGTH, MAX_TEXT_LENGTH } from './constants';
export {
  isMetadataClass,
  shouldSkipByClass,
  shouldSkipBySiteRules,
  isElementHidden,
  isNonHTMLNamespace,
  isValidText,
  isInsideArticle,
  hasBlockLevelParent,
  classifyChildren,
  isContentEditable,
  hasTranslateBlockClass,
} from './rules';
