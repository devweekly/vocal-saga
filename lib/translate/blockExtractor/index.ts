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
import type { WalkerCounters } from './constants';

export type { TextBlock };
export type { ArticleContext } from './types';

/**
 * 合并 CSS letter-spacing 渲染的"分散单词"。
 *
 * hero section、CTA 按钮、品牌名常用 `letter-spacing` 装饰，textContent
 * 抽取后变成 "S t a r t" 这种单字符 + 空格序列。直接送给翻译模型会被
 * 当成独立字符处理，返回 "开 始 使 用" 这种带空格的中文，apply 回 DOM
 * 后视觉错乱。
 *
 * 检测连续 ≥4 个 "ASCII 字母/数字 + 空格" 序列，合并为无空格单词。
 * 阈值 4：避免误伤 "I am a coder" 这类正常英文（"I a" 只有 2 个单字符
 * 序列，远低于阈值）。
 *
 * 不处理 CJK：中文字符本身是有意义的单字，letter-spacing 渲染的中文
 * （如 "开 始 使 用"）应保留原样，让翻译模型按独立字符处理。
 *
 * @example
 *   collapseSpacedText('S t a r t')        // → 'Start'
 *   collapseSpacedText('2 0 2 4 年度报告')  // → '2024 年度报告'
 *   collapseSpacedText('hello world')      // → 'hello world'（不变）
 *   collapseSpacedText('I am a coder')     // → 'I am a coder'（不变）
 *   collapseSpacedText('开 始 使 用')       // → '开 始 使 用'（中文不变）
 */
export function collapseSpacedText(text: string): string {
  // 匹配连续 ≥4 个 ASCII 字母/数字（用空白分隔），整体合并去掉空白。
  // [a-zA-Z0-9] 排除了 CJK 字符，避免误合并中文。
  return text.replace(
    /([a-zA-Z0-9](?:\s+[a-zA-Z0-9]){3,})/g,
    (match) => match.replace(/\s+/g, ''),
  );
}

/**
 * 从 rootNode 出发抽取所有翻译块。
 * @param rootNode Document 或 DocumentFragment
 * @param pageUrl 当前页面 URL，用于站点规则匹配（不再读 window.location.href）
 * @returns 顺序的 TextBlock 数组
 */
/** 最近一次 extractBlocks 调用的 walker 计数, 供 ExtractionReport 使用 */
let _lastCounters: WalkerCounters | null = null;

/** 获取最近一次 extractBlocks 的 walker 计数 */
export function getLastCounters(): WalkerCounters | null {
  return _lastCounters;
}

export function extractBlocks(
  rootNode: Node,
  pageUrl: string,
  /**
   * 可选的 ArticleContext: 来自 detectArticleRoot 的 root detection 上下文。
   * 如果传入 noiseSet, 会被注入到 WalkCache.knownNoise, 实现 root detection
   * 已识别的噪声 → block extractor O(1) 跳过的复用, 避免两个阶段重复判定。
   */
  context?: { noiseSet?: WeakSet<Element> },
): TextBlock[] {
  const blocks: TextBlock[] = [];
  const blockIdRef = { value: 0 };
  const seenTexts = new Set<string>();

  const startNode =
    rootNode.nodeType === 9 /* DOCUMENT_NODE */
      ? (rootNode as Document).body || (rootNode as Document).documentElement
      : rootNode;
  if (!startNode) {
    console.warn('[BlockExtractor] No valid start node found');
    return [];
  }

  const counters = collectBlocks(startNode, blocks, blockIdRef, seenTexts, pageUrl, context?.noiseSet);
  _lastCounters = counters;

  // 后处理：合并 CSS letter-spacing 渲染的分散单词。
  for (const block of blocks) {
    block.text = collapseSpacedText(block.text);
  }

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
  hasContentTokens,
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
