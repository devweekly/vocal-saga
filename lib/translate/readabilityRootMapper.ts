/**
 * Readability → 原始 DOM 映射器（fanyi-extension 与 vocal-saga 共享算法）。
 *
 * 背景：@mozilla/readability 在【克隆 DOM】上解析出正文（article.textContent），
 * 但后续 block extraction 必须作用在【原始 DOM】的元素上。旧实现只取 Readability
 * 正文的第一段作为签名，在原始 DOM 里用 includes/Jaccard 定位一个 TextNode，
 * 再向上爬到覆盖 80% 文本的最外层容器。
 *
 * 问题（GPT 分析 + 本项目 MEMORY P1 已记录）：
 *   1. 单锚点定位有 collision 风险：首匹配可能落在 related-articles 等噪声区。
 *   2. 80% 是「raw 文本长度覆盖」，wrapper(40k) 覆盖 article(20k) 仍误判。
 *   3. 祖先爬升只取「文本最长的稳定容器」，不一定是正文语义边界。
 *
 * 本模块改为 多锚点 + LCA + 内容覆盖率：
 *   - 从 Readability 正文抽取 首/中/尾 多个「锚段落」(multi-anchor)
 *   - 在原始 DOM 中定位每个锚段落所在的「块级元素」(DOM block matching)
 *   - 取这些块级元素的【最低公共祖先 LCA】作为最小稳定正文容器
 *   - contentCoverage = 命中锚段落文本 / Readability 正文文本（语义覆盖，非 raw 长度）
 *
 * 环境无关：只使用标准 DOM API（递归文本遍历，不依赖 TreeWalker），
 * fanyi-extension（浏览器 DOM）与 vocal-saga（linkedom）均可使用。
 * clone + parse 步骤由各自 tryReadabilityRoot 完成，本模块只做映射。
 */

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'li', 'blockquote', 'td',
  'header', 'aside', 'figure', 'ul', 'ol', 'table',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

// 最终根必须落在这些「容器级」标签上，避免把单个 <p>/<li>/<h*> 当正文根。
const CONTAINER_TAGS = new Set(['article', 'main', 'div', 'section', 'body', 'td']);

export interface ReadabilityMappingResult {
  /** 映射到原始 DOM 的正文根元素 */
  root: Element;
  /** 兼容旧契约：raw 文本长度覆盖率 (root.textContent / articleText)，0..1 */
  coverage: number;
  /** 成功定位的锚段落比例 0..1（matchedAnchors / totalAnchors） */
  anchorCoverage: number;
  /** 映射本身的置信度 0..1（由 anchorCoverage 推导，含内容覆盖修正） */
  mappingConfidence: number;
  /** Readability 正文内容被映射根覆盖的比例 0..1（语义覆盖，非 raw 长度） */
  contentCoverage: number;
  /** Readability 解析出的正文文本长度 */
  articleTextLength: number;
  /** 实际命中的锚段落数 */
  matchedAnchors: number;
  /** 尝试定位的锚段落总数 */
  totalAnchors: number;
}

export interface MapReadabilityOptions {
  /** 锚段落最小字符数，低于此视为无效锚（默认 40） */
  minAnchorLength?: number;
  /** 内容覆盖率最低阈值，低于此认为映射不可信（返回 null，默认 0.3） */
  minContentCoverage?: number;
  /** 锚段落数量上限（默认 5） */
  maxAnchors?: number;
  /** 环境相关的 consent SDK 判定（用于最终根防御） */
  isConsent?: (el: Element) => boolean;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 从正文抽取 首/尾/中间若干 锚段落（multi-anchor）。
 * 均匀采样而非只取首段，提升跨段落定位的鲁棒性，降低噪声区 collision 风险。
 */
function extractAnchors(text: string, maxAnchors: number, minLen: number): string[] {
  const paras = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((p) => p.length >= minLen);
  if (paras.length === 0) return [];
  if (paras.length === 1) return [paras[0]];

  const idxs = new Set<number>([0, paras.length - 1]);
  const extra = maxAnchors - 2;
  if (extra > 0) {
    for (let i = 1; i <= extra; i++) {
      const frac = i / (extra + 1);
      idxs.add(Math.min(paras.length - 1, Math.floor(frac * (paras.length - 1))));
    }
  }
  const ordered = Array.from(idxs).sort((a, b) => a - b);
  const anchors: string[] = [];
  for (const i of ordered) {
    const p = paras[i];
    if (!anchors.includes(p)) anchors.push(p);
    if (anchors.length >= maxAnchors) break;
  }
  return anchors;
}

/** 把 TextNode 提升到最近的块级祖先（避免 <span> 级抖动导致 LCA 过深）。 */
function blockOf(node: Text | null): Element | null {
  let el = node?.parentElement ?? null;
  while (el) {
    if (BLOCK_TAGS.has(el.tagName.toLowerCase())) return el;
    el = el.parentElement;
  }
  return node?.parentElement ?? null;
}

/**
 * 在原始 DOM 中定位一个锚段落所在的块级元素。
 * 优先精确子串匹配（处理跨节点拆分：先用 includes，失败再用 token Jaccard >= 0.5 兜底）。
 */
function locateAnchor(doc: Document, anchor: string): Element | null {
  const normAnchor = normalizeWs(anchor);
  if (!normAnchor) return null;
  const anchorTokens = new Set(
    normAnchor.toLowerCase().split(/\s+/).filter((t) => t.length >= 4),
  );

  let bestNode: Text | null = null;
  let bestJaccard = 0;

  const walk = (node: Node) => {
    if (bestJaccard >= 1) return; // 已精确命中，提前结束
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const t = node.textContent || '';
      if (t.trim().length < 5) return;
      const norm = normalizeWs(t);
      if (norm.includes(normAnchor)) {
        bestNode = node as Text;
        bestJaccard = 1;
        return;
      }
      const toks = new Set(norm.toLowerCase().split(/\s+/).filter((x) => x.length >= 4));
      if (toks.size === 0) return;
      let inter = 0;
      for (const tk of anchorTokens) if (toks.has(tk)) inter++;
      const union = anchorTokens.size + toks.size - inter;
      const j = union > 0 ? inter / union : 0;
      if (j > bestJaccard) {
        bestJaccard = j;
        bestNode = node as Text;
      }
    } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
      const tag = (node as Element).tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') {
        return;
      }
      const children = (node as Element).childNodes;
      for (let i = 0; i < children.length; i++) walk(children[i]);
    }
  };
  walk(doc.body);

  if (bestNode && bestJaccard >= 0.5) {
    return blockOf(bestNode);
  }
  return null;
}

/** 两元素的最低公共祖先（LCA）。 */
function lowestCommonAncestor(a: Element | null, b: Element | null): Element | null {
  if (!a || !b) return a || b;
  const set = new Set<Element>();
  let cur: Element | null = a;
  while (cur) {
    set.add(cur);
    cur = cur.parentElement;
  }
  cur = b;
  while (cur) {
    if (set.has(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/**
 * 把 Readability 解析结果映射回原始 DOM 的正文根。
 *
 * @param originalDoc 原始文档（用于文本定位，必须未被 Readability 修改）
 * @param article Readability.parse() 的结果（至少含 textContent）
 * @returns 映射结果；任何一步不可信时返回 null
 */
export function mapReadabilityToRoot(
  originalDoc: Document,
  article: { textContent?: string | null },
  options: MapReadabilityOptions = {},
): ReadabilityMappingResult | null {
  const minAnchorLength = options.minAnchorLength ?? 40;
  const minContentCoverage = options.minContentCoverage ?? 0.3;
  const maxAnchors = options.maxAnchors ?? 5;

  const articleText = article.textContent || '';
  const articleTextLength = articleText.length;
  if (articleTextLength < 200) return null;

  const anchors = extractAnchors(articleText, maxAnchors, minAnchorLength);
  if (anchors.length === 0) return null;

  const blocks: Element[] = [];
  for (const anchor of anchors) {
    const block = locateAnchor(originalDoc, anchor);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return null;

  // LCA = 跨所有命中锚段落的最小稳定正文容器
  let root: Element | null = blocks[0];
  for (let i = 1; i < blocks.length; i++) {
    root = lowestCommonAncestor(root, blocks[i]);
    if (!root) break;
  }
  if (!root) return null;

  // 若 LCA 落在叶级块（<p>/<li>/<h*>），上爬到容器级，避免只框住单段
  while (
    root &&
    !CONTAINER_TAGS.has(root.tagName.toLowerCase()) &&
    root !== originalDoc.body
  ) {
    root = root.parentElement;
  }
  if (!root) return null;

  // consent 防御
  if (options.isConsent && options.isConsent(root)) return null;

  // 覆盖率指标
  const rootTextLen = (root.textContent || '').length;
  const coverage = articleTextLength > 0 ? Math.min(1, rootTextLen / articleTextLength) : 0;

  // contentCoverage：命中锚段落文本之和 / Readability 正文文本（语义覆盖）
  let matchedTextLen = 0;
  for (const b of blocks) matchedTextLen += (b.textContent || '').length;
  const contentCoverage =
    articleTextLength > 0 ? Math.min(1, matchedTextLen / articleTextLength) : 0;

  const totalAnchors = anchors.length;
  const matchedAnchors = blocks.length;
  const anchorCoverage = totalAnchors > 0 ? matchedAnchors / totalAnchors : 0;

  // mappingConfidence：主要由锚命中率决定，内容覆盖过低时压低
  let mappingConfidence: number;
  if (anchorCoverage >= 1) mappingConfidence = 0.95;
  else if (anchorCoverage >= 0.66) mappingConfidence = 0.8;
  else if (anchorCoverage >= 0.33) mappingConfidence = 0.55;
  else mappingConfidence = 0.3;
  if (contentCoverage < minContentCoverage) mappingConfidence *= 0.5;

  if (contentCoverage < minContentCoverage) return null;

  return {
    root,
    coverage,
    anchorCoverage,
    mappingConfidence,
    contentCoverage,
    articleTextLength,
    matchedAnchors,
    totalAnchors,
  };
}
