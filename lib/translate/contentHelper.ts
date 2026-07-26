import { extractBlocks, getLastCounters, type TextBlock, type ArticleContext } from './blockExtractor';
import { buildChunks, type Chunk } from './chunkBuilder';
import { selectBestRoot } from './extraction/pipeline';

// =============================================================================
// Global Noise Marker: 标记根容器外的 UI 噪声
// =============================================================================
//
// extractBlocks 只在选定的 effectiveRoot（如 <main>）内遍历，因此 <main>
// 之外的侧边栏、fixed 底部栏、登录提示等不会被 walker 标记。
// 这里在 prepareDocument 早期对整篇文档做一次轻量扫描，给这些元素打上
// data-fanyi-remove / data-fanyi-low-priority，让翻译结果页的视觉样式生效。

/** 判断元素是否通过 fixed/sticky 类名或 inline style 固定在底部。 */
function isFixedBottomElement(el: Element): boolean {
  const cls = (el.className || '').toString().toLowerCase();
  const style = (el.getAttribute('style') || '').toLowerCase();

  const isFixed =
    /\bfixed\b/.test(cls) ||
    /\bsticky\b/.test(cls) ||
    style.includes('position:fixed') ||
    style.includes('position: sticky');
  if (!isFixed) return false;

  const isBottom =
    /\bbottom-0\b/.test(cls) ||
    /\binset-x-0\s+bottom/.test(cls) ||
    /bottom\s*:\s*0/.test(style);
  return isBottom;
}

/**
 * 全文档噪声标记。
 * 注意：只设置 data-fanyi-* 属性，不修改 DOM 结构，避免影响 extraction。
 */
function markGlobalNoise(doc: Document, pageUrl: string): void {
  const body = doc.body;
  if (!body) return;

  // 1. 语义噪声容器直接移除（侧边栏 / 弹窗）
  body.querySelectorAll('aside, dialog').forEach((el) => {
    // 若 <aside> 位于 <article> 内部，可能是文章注释/边注，保留
    let parent: Element | null = el.parentElement;
    let insideArticle = false;
    while (parent && parent !== body) {
      if (parent.tagName.toLowerCase() === 'article') {
        insideArticle = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (!insideArticle) {
      el.setAttribute('data-fanyi-remove', 'true');
    }
  });

  // 2. fixed/sticky 底部栏（X/Twitter 登录提示、Cookie 条等）
  body.querySelectorAll('*').forEach((el) => {
    if (isFixedBottomElement(el)) {
      el.setAttribute('data-fanyi-remove', 'true');
    }
  });

  // 3. X/Twitter 站点特定：侧边栏列
  const host = pageUrl ? new URL(pageUrl).hostname : '';
  if (host === 'x.com' || host === 'twitter.com') {
    body.querySelectorAll('[data-testid="sidebarColumn"]').forEach((el) => {
      el.setAttribute('data-fanyi-remove', 'true');
    });
  }
}

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
 * 段落类容器集合: 块级元素或语义段落容器。
 * 用于 mergeInlineBlocks 判断“同一自然段落”的边界。
 */
const PARAGRAPH_CONTAINER_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'td',
  'th',
  'figcaption',
  'blockquote',
  'pre',
]);

/** 判断元素是否为段落类容器 (语义段落或站点特定的正文容器)。 */
function isParagraphContainer(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (PARAGRAPH_CONTAINER_TAGS.has(tag)) return true;

  const dataTestid = el.getAttribute('data-testid') || '';
  if (dataTestid === 'tweetText') return true;

  const cls = (el.getAttribute('class') || '').toLowerCase();
  if (cls.includes('public-draftstyledefault-block')) return true;

  const role = el.getAttribute('role') || '';
  if (role === 'paragraph' || role === 'heading') return true;

  return false;
}

/**
 * 从元素向上查找最近的段落容器。
 * 遇到 body/main/article/section/header/footer/nav/aside 或 document 边界时停止,
 * 返回 null 表示该元素不在可合并的段落容器内。
 */
function findParagraphContainer(el: Element, doc?: Document): Element | null {
  let current: Element | null = el;
  const stopTags = new Set(['body', 'main', 'article', 'section', 'header', 'footer', 'nav', 'aside']);

  while (current && current.nodeType === 1) {
    const tag = current.tagName.toLowerCase();
    if (stopTags.has(tag)) return null;
    if (isParagraphContainer(current)) return current;
    if (current === doc?.documentElement) return null;
    current = current.parentElement;
  }
  return null;
}

/**
 * 合并相邻的短 inline 候选块, 减少翻译碎片。
 *
 * 问题: walker 对 <p>This is <strong>important</strong> text.</p> 可能产生
 * 3 个独立 block ("This is", "important", "text"), 翻译后拼接不自然。
 * X/Twitter 等站点更极端: 一段正文被拆成 <span>text<div><a>@user</a></div>text</span>。
 *
 * 策略:
 *   - 相邻的 inlineCandidate 块, 如果合并后总长度 < 500 字符, 合并
 *   - 合并后取第一个块的 xpath/id, 文本用空格连接
 *   - 优先按“段落容器”合并: 同一 <p> / <div data-testid="tweetText"> 内的碎片
 *     即使父节点不同也合并; 跨段落则不合并
 *   - 若有 doc, 同步合并 DOM: 把后续 inline 元素的内容移入第一个元素,
 *     并移除后续元素, 避免回填时原文被拆碎。
 */
function mergeInlineBlocks(blocks: TextBlock[], doc?: Document): TextBlock[] {
  if (blocks.length <= 1) return blocks;

  const MAX_MERGE_LEN = 500;
  const merged: TextBlock[] = [];
  let currentGroup: TextBlock[] = [];

  /** 获取 xpath 的 parent 路径 (去掉最后一段) */
  function parentPath(xpath: string): string {
    const lastSlash = xpath.lastIndexOf('/');
    return lastSlash > 0 ? xpath.slice(0, lastSlash) : '/';
  }

  /** 判断 block 是否为可合并的 inline 元素 */
  function isInlineBlock(block: TextBlock): boolean {
    if (block.renderHint?.inlineCandidate === true) return true;
    const inlineTags = new Set([
      'span', 'a', 'em', 'strong', 'i', 'b', 'u', 'code', 'small', 'label',
      'time', 'mark', 'q', 'dfn', 'abbr', 'cite', 'sup', 'sub', 'samp', 'kbd',
      'var', 'wbr', 's', 'data', 'bdi', 'bdo', 'ruby', 'rb', 'rt', 'rp', 'del',
      'ins', 'font', 'tt', 'big', 'strike', 'img',
    ]);
    return inlineTags.has(block.tag.toLowerCase());
  }

  /** 同步合并 DOM: 把 group 中后续 block 对应的元素移入第一个元素 */
  function mergeDomGroup(group: TextBlock[]) {
    if (!doc || group.length <= 1) return;
    const first = group[0];
    const firstEl = doc.querySelector(`[data-fanyi-block-id="${first.id}"]`);
    if (!firstEl || firstEl.nodeType !== 1) return;

    for (let i = 1; i < group.length; i++) {
      const other = group[i];
      const otherEl = doc.querySelector(`[data-fanyi-block-id="${other.id}"]`);
      if (!otherEl || otherEl.nodeType !== 1) continue;

      // 把 otherEl 的所有子节点移入 firstEl, 并在文本节点之间补一个空格
      // 避免 "with @NVIDIAAI" 变成 "with@NVIDIAAI"
      if (firstEl.lastChild && firstEl.lastChild.nodeType === 3) {
        const lastText = firstEl.lastChild.textContent || '';
        if (lastText.length > 0 && !/\s$/.test(lastText)) {
          firstEl.appendChild(doc.createTextNode(' '));
        }
      }
      while (otherEl.firstChild) {
        firstEl.appendChild(otherEl.firstChild);
      }
      otherEl.removeAttribute('data-fanyi-block-id');
      (otherEl as HTMLElement).remove();
    }
  }

  /** 查找 block 对应的段落容器 */
  function getParagraphContainer(block: TextBlock): Element | null {
    if (!doc) return null;
    const el = doc.querySelector(`[data-fanyi-block-id="${block.id}"]`);
    if (!el || el.nodeType !== 1) return null;
    return findParagraphContainer(el, doc);
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
    mergeDomGroup(currentGroup);
    merged.push({
      ...first,
      text: combinedText,
      renderHint: { ...first.renderHint, inlineCandidate: false },
    });
    currentGroup = [];
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockParent = parentPath(block.xpath);
    const lastBlock = currentGroup.length > 0 ? currentGroup[currentGroup.length - 1] : null;
    const groupParent = lastBlock ? parentPath(lastBlock.xpath) : blockParent;

    // 优先按段落容器合并: 同一段落容器内的相邻 inline 块合并,
    // 即使它们不是同一 parent (X/Twitter 的 tweetText 常见)
    const blockContainer = getParagraphContainer(block);
    const groupContainer = lastBlock ? getParagraphContainer(lastBlock) : blockContainer;
    const sameParagraphContainer =
      blockContainer !== null && groupContainer !== null && blockContainer === groupContainer;

    const canMerge =
      isInlineBlock(block) && (blockParent === groupParent || sameParagraphContainer);

    if (canMerge) {
      // 检查合并后总长度
      const groupLen = currentGroup.reduce((sum, b) => sum + b.text.length + 1, 0);
      const newLen = groupLen + block.text.length;

      if (newLen <= MAX_MERGE_LEN) {
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

/**
 * 检测文档是否是 PDF.js viewer 页面。
 *
 * PDF.js viewer 把 PDF 内容渲染为 <canvas> 位图，.textLayer span 是透明的
 * 文字选择层。服务端（vocal-saga）不执行 JavaScript，抓取到的 HTML 只有
 * 空壳（#viewer.pdfViewer + <canvas>），没有可翻译的文本。
 *
 * 检测信号（按可靠性排序）：
 *   1. #viewer.pdfViewer — PDF.js viewer 初始化时加的 class，在初始 HTML 中就存在
 *   2. #viewerContainer — PDF.js viewer 的页面容器，ID 足够独特
 *
 * 注：.textLayer 在服务端抓取的 HTML 中不存在（由 JavaScript 在客户端创建），
 * 所以不作为服务端检测信号。
 */
function isPdfJsViewerHtml(root: Document | Element): boolean {
  // 不依赖全局 Document 构造函数：Workers 环境没有全局 Document。
  const doc =
    root.nodeType === 9 /* DOCUMENT_NODE */
      ? (root as Document)
      : (root as Element).ownerDocument;
  if (!doc) return false;
  const viewer = doc.getElementById('viewer');
  if (viewer && viewer.classList.contains('pdfViewer')) return true;
  return doc.getElementById('viewerContainer') !== null;
}

/**
 * 如果 content detector 选中的根是 <table>，把表格内容展平到一个 <div> 包装器中。
 *
 * 背景：walker 的 SKIP_SET 包含 table/thead/tbody/tr/td/th（数据表不应翻译）。
 * 但有些老式 CMS 用 <table> 做整页布局，正文段落实际放在 <td> 里。
 * 直接以 <table> 为 root 遍历会导致整棵子树被 reject，一块都抓不到。
 *
 * 解决：把 <table> 下的 <td>/<th> 内容移动到新建的 <div class="fanyi-table-unwrapped">中，
 * 用这个 div 替换原 table 的位置，并作为新的 effectiveRoot 返回。
 * block id 会标记在 wrapper 内的元素上，回填阶段仍可正常查找。
 */
function unwrapTableRoot(table: Element): Element {
  const doc = table.ownerDocument;
  if (!doc) return table;

  const wrapper = doc.createElement('div');
  wrapper.className = 'fanyi-table-unwrapped';

  // 收集 table 内所有 td/th 的直接子节点，保持原有顺序
  const cells = table.querySelectorAll('td, th');
  cells.forEach((cell) => {
    while (cell.firstChild) {
      wrapper.appendChild(cell.firstChild);
    }
  });

  // 如果没有 td/th（理论上不应发生），把整个 table 子树移进去兜底
  if (!wrapper.firstChild) {
    while (table.firstChild) {
      wrapper.appendChild(table.firstChild);
    }
  }

  table.parentElement?.replaceChild(wrapper, table);
  return wrapper;
}

/**
 * 原地递归展平容器内的所有 <table>。
 *
 * 用于表格布局兜底：当某个 root 内部嵌套 table，但 walker 因 SKIP_SET
 * 拒绝 table 导致 0 块时，把每个 table 的 td/th 内容提升到 table 原位置，
 * 让 walker 能抓到其中的段落文本。
 *
 * 注意：这是一个破坏性 DOM 修改，只应在副本或已确认需要处理的根上调用。
 */
function unwrapAllTablesInPlace(container: Element): void {
  // 先处理子 table，从深层向外层，避免 replaceChild 后 querySelectorAll 失效
  const tables = Array.from(container.querySelectorAll('table'));
  tables.forEach((table) => {
    unwrapTableRoot(table);
  });

  // 如果容器自身就是 table，也一并处理
  if (container.tagName.toLowerCase() === 'table') {
    // unwrapTableRoot 已经需要父元素，这里不做特殊处理；
    // 调用方通常在 prepareDocument 里已单独处理 root === table 的情况。
  }
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

  // 优先判断 root 类型，供后续逻辑复用
  const isDoc = root.nodeType === 9;

  // 先在整篇文档上标记根容器外的 UI 噪声（如侧边栏、fixed 底部栏），
  // 再进入选根和块提取。这一步只打 data-fanyi-* 标记，不删节点。
  if (isDoc) {
    markGlobalNoise(root as Document, pageUrl);
  }

  // 优先使用文章容器，减少 TreeWalker 遍历范围
  const rootResult = isDoc ? findArticleRoot(root as Document, pageUrl, articleContext) : { root: root as Element, strategy: 'selector' };
  let effectiveRoot: Element = rootResult.root;

  // 如果 content detector 选中的根是 <table>，需要把表格内容展平。
  // walker 默认拒绝所有表格元素，否则以 table 为 root 会一块都抓不到。
  if (effectiveRoot.tagName.toLowerCase() === 'table') {
    effectiveRoot = unwrapTableRoot(effectiveRoot);
  }

  let blocks = extractBlocks(effectiveRoot, pageUrl, articleContext);
  let strategy = rootResult.strategy;
  let rootSelector = `<${effectiveRoot.tagName.toLowerCase()}>.${(effectiveRoot.className || '').toString().split(/\s+/)[0] || ''}`;

  // 合并 walker 产生的 inline 碎片（如 X/Twitter 的 <span>text<a>@user</a>text</span>）。
  // 传入 doc 以便同步合并 DOM，避免回填后原文被拆碎。
  const doc = isDoc ? (root as Document) : (root as Element).ownerDocument;
  blocks = mergeInlineBlocks(blocks, doc ?? undefined);

  // 表格布局兜底：如果第一次提取 0 块，且 effectiveRoot 内包含 <table>，
  // 说明内容可能被困在表格元素里（老式 CMS 用 table 做页面布局）。
  // walker 默认拒绝所有 table 元素，因此把它们展平后重试。
  if (blocks.length === 0 && effectiveRoot.querySelector('table')) {
    const clonedRoot = effectiveRoot.cloneNode(true) as Element;
    unwrapAllTablesInPlace(clonedRoot);
    const clonedBlocks = extractBlocks(clonedRoot, pageUrl, articleContext);
    if (clonedBlocks.length > 0) {
      // 把展平后的 DOM 应用到原文档，让后续翻译回填能找到 block id
      effectiveRoot.replaceWith(clonedRoot);
      effectiveRoot = clonedRoot;
      blocks = clonedBlocks;
      strategy = `${strategy}-table-unwrap`;
      rootSelector = `<${effectiveRoot.tagName.toLowerCase()}>.${(effectiveRoot.className || '').toString().split(/\s+/)[0] || ''}`;
    }
  }

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
    if (isPdfJsViewerHtml(root)) {
      throw new Error(
        'PDF.js viewer pages render content client-side as canvas bitmap. ' +
        'Server-side translation cannot extract text. ' +
        'Please use the browser extension directly on this URL for client-side PDF translation.',
      );
    }
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
