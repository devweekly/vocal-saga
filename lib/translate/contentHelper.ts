import { extractBlocks, getLastCounters, type TextBlock, type ArticleContext } from './blockExtractor';
import { buildChunks, type Chunk } from './chunkBuilder';
import { selectBestRoot } from './extraction/pipeline';

// =============================================================================
// ExtractionReport: 抽取质量报告
// =============================================================================
// 输出抽取过程的元数据, 用于诊断翻译失败和质量监控。
// 低 confidence 时可触发 retry root strategy。

export interface ExtractionReport {
  /** 最终选中的文章根选择器 (tag.class 格式) */
  rootSelector: string;
  /** 提取的翻译块数 */
  blockCount: number;
  /** 总文本长度 (字符) */
  textLength: number;
  /** heading 数量 */
  headingCount: number;
  /** chunk 数量 */
  chunkCount: number;
  /** 噪声比例 (被跳过的节点 / 总节点), 0~1 */
  noiseRatio: number;
  /**
   * 抽取质量分 0~1, 基于块数/文本长度/噪声比例/heading 数综合计算。
   *
   * 语义区别（P1-3 统一）：
   *   - `ExtractionReport.extractionQuality`：抽取**过程**的置信度，
   *     反映 prepareDocument 完成后实际拿到了多少可用内容。
   *   - `ArticleCandidate.confidence`（extraction/scoring.ts）：候选**根**
   *     的质量分，反映选根阶段 provider 候选本身的文本密度/结构等。
   * 两者都叫过 confidence 容易混淆，故本字段改名以明确语义。
   */
  extractionQuality: number;
  /** 使用了哪个策略: "site-rule" | "selector" | "density" | "readability" | "data-island" | "body-fallback" */
  strategy: string;
}

function buildReport(
  rootSelector: string,
  blocks: TextBlock[],
  chunks: Chunk[],
  strategy: string,
  rejected: number,
  skipped: number,
  accepted: number,
): ExtractionReport {
  const textLength = blocks.reduce((sum, b) => sum + b.text.length, 0);
  const headingCount = blocks.filter((b) => /^h[1-6]$/.test(b.tag)).length;
  const totalNodes = rejected + skipped + accepted;
  const noiseRatio = totalNodes > 0 ? (rejected + skipped) / totalNodes : 0;

  // 抽取质量分: 综合块数/文本长度/噪声比例
  // - 块数 >= 5 → +0.3
  // - 文本 >= 500 → +0.3
  // - 噪声比例 < 0.5 → +0.2
  // - heading >= 1 → +0.2
  let extractionQuality = 0;
  if (blocks.length >= 5) extractionQuality += 0.3;
  else if (blocks.length >= 1) extractionQuality += 0.1;
  if (textLength >= 500) extractionQuality += 0.3;
  else if (textLength >= 100) extractionQuality += 0.15;
  if (noiseRatio < 0.5) extractionQuality += 0.2;
  if (headingCount >= 1) extractionQuality += 0.2;
  extractionQuality = Math.min(extractionQuality, 1);

  return {
    rootSelector,
    blockCount: blocks.length,
    textLength,
    headingCount,
    chunkCount: chunks.length,
    noiseRatio,
    extractionQuality,
    strategy,
  };
}

function findArticleRoot(
  doc: Document,
  pageUrl: string,
  /**
   * 可选 out 参数: 透传给 extraction pipeline, 供 block extraction 复用
   * noiseSet / textCache / confidence / semanticHints。
   */
  contextOut?: Partial<ArticleContext>,
): { root: Element; strategy: string } {
  // P1-3 后 selectBestRoot 已整合 body-fallback（候选质量分 < 阈值或无候选时
  // 直接返回 doc.body）。contentHelper 不再单独实现 L3 兜底。
  const selection = selectBestRoot(doc, pageUrl, contextOut);
  return { root: selection.root, strategy: selection.strategy };
}

// =============================================================================
// Data Island fallback —— 从 SPA 数据岛提取正文
// =============================================================================
//
// 许多 SPA 站点（Next.js / Nuxt / SvelteKit）首屏 DOM 是骨架，真正的内容塞在
// <script type="application/json"> / #__NEXT_DATA__ / #__NUXT_DATA__ 里。
// 当 DOM 上 extractBlocks 抓到 0 块时，尝试从数据岛解析结构化数据，递归提取
// 字符串字段，包装成 TextBlock。
//
// 不修改 DOM：返回的 TextBlock 用占位 xpath `/data-island/[i]`，调用方据此
// 知道这些块没有真实 DOM 节点，apply 阶段会跳过 DOM 修改。

/** 优先字段名：这些字段通常是正文（不分大小写）。 */
const DATA_ISLAND_PRIORITY_FIELDS =
  /^(articleBody|text|content|description|body|html|markdown|summary|excerpt|plaintext)$/i;

/** 跳过字段名：导航/元数据/技术字段（不分大小写）。 */
const DATA_ISLAND_SKIP_FIELDS =
  /^(url|href|src|image|icon|logo|type|@type|@context|id|key|name|slug|tag|category|author|date|published|modified|created|updated|locale|lang|language|version|site|domain|host|path|query|method|status|code|token|csrf|nonce)$/i;

/** 短于此长度的字符串不算正文（过滤标题、面包屑、按钮文案）。 */
const DATA_ISLAND_MIN_TEXT_LEN = 50;

/** DataIsland 块类型：保留结构信息, 让 chunk builder 优化分块 */
interface DataIslandBlock {
  text: string;
  type: 'heading' | 'paragraph' | 'code' | 'quote';
  level?: number;
}

/**
 * 递归遍历 JSON 数据，提取正文字符串（保留 block type）。
 * - 命中 PRIORITY_FIELDS 的字段：长度 ≥ 1 即采集
 * - 其他字段：长度 ≥ DATA_ISLAND_MIN_TEXT_LEN 才采集
 * - SKIP_FIELDS 字段：跳过
 * - 保留 type 信息: 根据 fieldName 和 parent context 推断 heading/paragraph/code/quote
 */
function walkDataIsland(
  obj: unknown,
  fieldName: string | undefined,
  blocks: DataIslandBlock[],
  seen: Set<string>,
): void {
  if (obj == null || typeof obj === 'number' || typeof obj === 'boolean') return;

  if (typeof obj === 'string') {
    const trimmed = obj.trim();
    if (trimmed.length === 0) return;
    if (seen.has(trimmed)) return;

    if (fieldName && DATA_ISLAND_SKIP_FIELDS.test(fieldName)) return;

    const isPriority = fieldName && DATA_ISLAND_PRIORITY_FIELDS.test(fieldName);
    if (!isPriority && trimmed.length < DATA_ISLAND_MIN_TEXT_LEN) return;

    seen.add(trimmed);

    // 推断 block type: 根据字段名和内容特征
    let type: DataIslandBlock['type'] = 'paragraph';
    let level: number | undefined;
    if (fieldName && /^(title|heading|headline)$/i.test(fieldName)) {
      type = 'heading';
      level = 2;
    } else if (fieldName && /^(subtitle|subtitle)$/i.test(fieldName)) {
      type = 'heading';
      level = 3;
    } else if (fieldName && /^(code|snippet|codeBlock)$/i.test(fieldName)) {
      type = 'code';
    } else if (fieldName && /^(quote|blockquote|citation)$/i.test(fieldName)) {
      type = 'quote';
    }

    blocks.push({ text: trimmed, type, level });
    return;
  }

  if (Array.isArray(obj)) {
    // 数组中的对象可能含 type 字段 (如 Next.js 的 blocks 数组)
    for (const item of obj) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        // 检查是否有 type 字段指示 block 类型
        const itemType = typeof record.type === 'string' ? record.type : '';
        const itemText = typeof record.text === 'string' ? record.text.trim() : '';
        if (itemText && itemType) {
          if (seen.has(itemText)) continue;
          seen.add(itemText);
          let bt: DataIslandBlock['type'] = 'paragraph';
          let bl: number | undefined;
          if (itemType === 'heading' || itemType === 'header') {
            bt = 'heading';
            bl = typeof record.level === 'number' ? record.level : 2;
          } else if (itemType === 'code' || itemType === 'codeBlock') {
            bt = 'code';
          } else if (itemType === 'quote' || itemType === 'blockquote') {
            bt = 'quote';
          }
          blocks.push({ text: itemText, type: bt, level: bl });
          continue;
        }
      }
      walkDataIsland(item, fieldName, blocks, seen);
    }
    return;
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      walkDataIsland(record[key], key, blocks, seen);
    }
  }
}

/**
 * 从 SPA 数据岛提取正文 TextBlock。
 *
 * 候选 script（按优先级）：
 * 1. #__NEXT_DATA__（Next.js SSR 数据）
 * 2. #__NUXT_DATA__（Nuxt SSR 数据）
 * 3. <script type="application/json">（通用，排除前两者）
 *
 * 解析失败的 script 静默跳过；提取到的字符串去重后包装成 TextBlock。
 * 不修改 DOM，返回的 xpath 是占位符 `/data-island/[i]`。
 *
 * 对 vocal-saga 服务端尤其重要：fetch 拿到的初始 HTML 通常 DOM 是骨架，
 * 内容全在 __NEXT_DATA__ 里，客户端 hydrate 之前 walker 抓不到任何块。
 */
export function extractFromDataIsland(doc: Document): TextBlock[] {
  const candidates: string[] = [];

  // 优先级 1：Next.js
  const nextData = doc.getElementById('__NEXT_DATA__');
  if (nextData?.textContent) candidates.push(nextData.textContent);

  // 优先级 2：Nuxt
  const nuxtData = doc.getElementById('__NUXT_DATA__');
  if (nuxtData?.textContent) candidates.push(nuxtData.textContent);

  // 优先级 3：通用 application/json（排除已收集的）
  const scripts = doc.querySelectorAll('script[type="application/json"]');
  for (const s of Array.from(scripts)) {
    if (s.id === '__NEXT_DATA__' || s.id === '__NUXT_DATA__') continue;
    if (s.textContent) candidates.push(s.textContent);
  }

  if (candidates.length === 0) return [];

  const islandBlocks: DataIslandBlock[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate);
      walkDataIsland(data, undefined, islandBlocks, seen);
    } catch {
      // JSON 解析失败，跳过这个 script
    }
  }

  if (islandBlocks.length === 0) return [];

  console.log(
    `[ContentHelper] Extracted ${islandBlocks.length} blocks from data island (${candidates.length} script(s) scanned)`,
  );

  // 将 DataIslandBlock 转换为 TextBlock, 保留 type 信息到 renderHint
  return islandBlocks.map((b, i) => ({
    id: `data-island-${i}`,
    xpath: `/data-island/${i}`,
    tag: b.type === 'heading' ? `h${b.level || 2}` : b.type === 'code' ? 'pre' : b.type === 'quote' ? 'blockquote' : 'p',
    text: b.text,
    renderHint: b.type !== 'paragraph' ? { dataIslandType: b.type, dataIslandLevel: b.level } : undefined,
  }));
}

/**
 * 合并相邻的短 inline 候选块, 减少翻译碎片。
 *
 * 问题: walker 对 <p>This is <strong>important</strong> text.</p> 可能产生
 * 3 个独立 block ("This is", "important", "text"), 翻译后拼接不自然。
 *
 * 策略:
 *   - 相邻的 inlineCandidate 块, 如果合并后总长度 < 500 字符, 合并
 *   - 合并后取第一个块的 xpath/id, 文本用空格连接
 *   - 只合并同一 parent 下的相邻块 (通过 xpath 前缀判断)
 */
function mergeInlineBlocks(blocks: TextBlock[]): TextBlock[] {
  if (blocks.length <= 1) return blocks;

  const MAX_MERGE_LEN = 500;
  const merged: TextBlock[] = [];
  let currentGroup: TextBlock[] = [];

  /** 获取 xpath 的 parent 路径 (去掉最后一段) */
  function parentPath(xpath: string): string {
    const lastSlash = xpath.lastIndexOf('/');
    return lastSlash > 0 ? xpath.slice(0, lastSlash) : '/';
  }

  /** 尝试将当前 group 合并为一个 block */
  function flushGroup() {
    if (currentGroup.length === 0) return;
    if (currentGroup.length === 1) {
      merged.push(currentGroup[0]);
      currentGroup = [];
      return;
    }
    // 合并 group: 取第一个块的 id/xpath, 文本用空格连接
    const first = currentGroup[0];
    const combinedText = currentGroup.map((b) => b.text).join(' ');
    merged.push({
      ...first,
      text: combinedText,
      renderHint: { ...first.renderHint, inlineCandidate: false },
    });
    currentGroup = [];
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const isInline = block.renderHint?.inlineCandidate === true;

    if (isInline) {
      // 检查是否与 currentGroup 的最后一个块相邻 (同一 parent)
      const blockParent = parentPath(block.xpath);
      const groupParent =
        currentGroup.length > 0 ? parentPath(currentGroup[currentGroup.length - 1].xpath) : blockParent;

      // 检查合并后总长度
      const groupLen = currentGroup.reduce((sum, b) => sum + b.text.length + 1, 0);
      const newLen = groupLen + block.text.length;

      if (blockParent === groupParent && newLen <= MAX_MERGE_LEN) {
        currentGroup.push(block);
      } else {
        flushGroup();
        currentGroup.push(block);
      }
    } else {
      flushGroup();
      merged.push(block);
    }
  }
  flushGroup();

  return merged;
}

export function prepareDocument(
  root: Document | Element,
  pageUrl: string
): {
  blocks: TextBlock[];
  chunks: Chunk[];
  fullText: string;
  report: ExtractionReport;
} {
  // ArticleContext: 共享 root detection → block extraction 的上下文。
  // extraction pipeline 在 provider 运行期间把被排除的 consent SDK 容器
  // 加入 noiseSet; prepareDocument 把 noiseSet 传给 extractBlocks, 让 walker
  // 通过 WalkCache.knownNoise 直接 O(1) 跳过这些已识别的噪声, 避免重复判定。
  const articleContext: Partial<ArticleContext> = {};

  // 优先使用文章容器，减少 TreeWalker 遍历范围
  const isDoc = root.nodeType === 9;
  const rootResult = isDoc ? findArticleRoot(root as Document, pageUrl, articleContext) : { root: root as Element, strategy: 'selector' };
  const effectiveRoot: Element = rootResult.root;
  let blocks = extractBlocks(effectiveRoot, pageUrl, articleContext);
  let strategy = rootResult.strategy;
  let rootSelector = `<${effectiveRoot.tagName.toLowerCase()}>.${(effectiveRoot.className || '').toString().split(/\s+/)[0] || ''}`;

  // P1-3：body-fallback 已整合到 selectBestRoot（候选质量分 < 阈值或无候选时直接返回 body）。
  // 这里只剩 data-island 兜底：当 body 仍然 0 块（SPA 首屏 DOM 是骨架，
  // 内容在 __NEXT_DATA__ / __NUXT_DATA__ 等 script 里）时从 JSON 提取。
  // 注意：data-island 不是"选根"（不返回 Element），是 prepareDocument 的最终兜底，
  // 属于 contentHelper 职责，不属于 extraction 模块。
  if (blocks.length === 0 && isDoc) {
    blocks = extractFromDataIsland(root as Document);
    strategy = 'data-island';
    rootSelector = '/data-island';
  }

  if (blocks.length === 0) {
    throw new Error('No translatable content found');
  }

  // Block merge: 合并相邻的短 inline 候选块, 减少翻译碎片。
  // 问题: walker 对 <p>This is <strong>important</strong> text.</p> 可能产生
  // 3 个独立 block ("This is", "important", "text"), 翻译后拼接不自然。
  // 策略: 相邻的 inlineCandidate 块如果总长度 < 500 字符, 合并为一个 block。
  blocks = mergeInlineBlocks(blocks);

  const fullText = blocks.map((b) => b.text).join('\n\n');
  const chunks = buildChunks(blocks);

  // 构建 ExtractionReport (使用 walker counters)
  const counters = getLastCounters();
  const report = buildReport(
    rootSelector,
    blocks,
    chunks,
    strategy,
    counters?.rejected || 0,
    counters?.skipped || 0,
    counters?.accepted || blocks.length,
  );

  console.log(
    `[ContentHelper] ExtractionReport: strategy=${strategy}, blocks=${report.blockCount}, textLen=${report.textLength}, headings=${report.headingCount}, chunks=${report.chunkCount}, noise=${report.noiseRatio.toFixed(2)}, quality=${report.extractionQuality.toFixed(2)}`,
  );

  return { blocks, chunks, fullText, report };
}

export type { TextBlock, Chunk };

// 兼容导出：原 contentHelper.ts 中暴露的函数/类型仍可从本文件导入。
export {
  refineArticleRoot,
  expandWrappers,
  chooseBestRoot,
  hasArticleLikeHeading,
  scoreArticleContainer,
} from './extraction/providers/selector';
