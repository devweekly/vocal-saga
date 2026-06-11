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

import { collectBlocks } from './walker';
import type { TextBlock } from './types';

export type { TextBlock };

/**
 * 从 rootNode 出发抽取所有翻译块。
 * @param rootNode Document 或 DocumentFragment
 * @returns 顺序的 TextBlock 数组
 */
export function extractBlocks(rootNode: Node): TextBlock[] {
  const blocks: TextBlock[] = [];
  const blockIdRef = { value: 0 };
  // 跨段落去重: 同一文本多次出现只取第一个 (HBR summary callout 模式)。
  const seenTexts = new Set<string>();

  const startNode =
    rootNode instanceof Document
      ? rootNode.body || rootNode.documentElement
      : rootNode;
  if (!startNode) {
    console.warn('[BlockExtractor] No valid start node found');
    return [];
  }

  collectBlocks(startNode, blocks, blockIdRef, seenTexts);
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
