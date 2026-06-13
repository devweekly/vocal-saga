/**
 * 智能正文识别：基于评分的容器选择算法。
 *
 * 当 ARTICLE_SELECTORS 选择器快速路径全部 miss 时，
 * 对所有候选容器评分，选最高分的作为文章根节点。
 *
 * 评分维度：
 *   1. textDensity   — 纯文本/HTML 比值（正文高，导航低）
 *   2. linkDensity   — 链接文本占比倒数（正文低，导航高）
 *   3. paragraphRatio — <p> 标签占比（正文高，sidebar 低）
 *   4. headingScore  — h1-h6 数量（适度多=好，太多=差）
 *   5. stopwordScore — 英文停用词密度（正文 20-40%）
 *   6. classHint     — class 名正向/负向暗示
 *   7. noisePenalty  — form/list/iframe 等噪声惩罚
 */

// =============================================================================
// 常量
// =============================================================================

/** 评分阈值：低于此分数回退 body */
export const SCORE_THRESHOLD = 0.35;

/** 正向 class 名模式 */
const POSITIVE_CLASS_RE = /article|content|post|body|text|entry|rich|blog|story|main/i;

/** 负向 class 名模式 */
const NEGATIVE_CLASS_RE = /nav|menu|sidebar|footer|header|comment|widget|ad|banner|social|share|related|cookie|popup|modal/i;

/** 英文停用词表（高频功能词） */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'shall', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'out', 'off',
  'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same',
  'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if',
  'while', 'about', 'up', 'its', 'it', 'he', 'she', 'we', 'they', 'you',
  'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their',
  'this', 'that', 'these', 'those', 'i', 'what', 'which', 'who', 'whom',
]);

// =============================================================================
// 评分函数
// =============================================================================

/**
 * 文本密度：纯文本字符数 / HTML 字符数。
 * 正文：0.3-0.6；导航：< 0.1
 */
function textDensity(el: Element): number {
  const text = el.textContent || '';
  const html = el.innerHTML || '';
  if (html.length === 0) return 0;
  return text.length / html.length;
}

/**
 * 链接密度倒数：1 - (链接文本 / 总文本)。
 * 正文：< 0.1 链接占比 → 倒数 > 0.9
 * 导航：> 0.5 链接占比 → 倒数 < 0.5
 */
function linkDensity(el: Element): number {
  const allText = el.textContent || '';
  if (allText.length === 0) return 0;
  let linkTextLen = 0;
  for (const a of Array.from(el.querySelectorAll('a'))) {
    linkTextLen += (a.textContent || '').length;
  }
  const ratio = linkTextLen / allText.length;
  return 1 - Math.min(ratio, 1);
}

/**
 * 段落比例：<p> 数量 / 总子元素数量。
 * 正文：<p> 多；导航/sidebar 几乎无 <p>
 */
function paragraphRatio(el: Element): number {
  const children = el.children.length || 1;
  const pCount = el.querySelectorAll('p').length;
  return Math.min(pCount / children, 1);
}

/**
 * 标题得分：h1-h6 数量。
 * 0 个：0.3（可能有内容但无标题）
 * 1-10 个：1.0（正常文章）
 * > 10 个：递减（可能包含导航/目录）
 */
function headingScore(el: Element): number {
  const h1 = el.querySelectorAll('h1').length;
  const h2 = el.querySelectorAll('h2').length;
  const h3 = el.querySelectorAll('h3').length;
  const total = h1 + h2 + h3;
  if (total === 0) return 0.3;
  if (total <= 10) return 1;
  return Math.max(0.3, 1 - (total - 10) * 0.05);
}

/**
 * 停用词得分：英文停用词占比。
 * 正文：20-40%
 * 代码/链接：< 10%
 */
function stopwordScore(el: Element): number {
  const text = (el.textContent || '').toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let stopCount = 0;
  for (const w of words) {
    if (STOPWORDS.has(w)) stopCount++;
  }
  // 归一化到 0-1，30% 停用词为满分
  return Math.min(stopCount / words.length / 0.3, 1);
}

/**
 * class 名暗示：正向加分，负向减分。
 */
function classHint(el: Element): number {
  const combined = `${el.className || ''} ${el.id || ''}`;
  let score = 0.5;
  if (POSITIVE_CLASS_RE.test(combined)) score += 0.3;
  if (NEGATIVE_CLASS_RE.test(combined)) score -= 0.4;
  return Math.max(0, Math.min(1, score));
}

/**
 * 噪声惩罚：含 form/list/iframe 等。
 * 返回 0（无噪声）到 1（高噪声）
 */
function noisePenalty(el: Element): number {
  let penalty = 0;

  // 链接比例高 → 导航/链接列表
  const linkCount = el.querySelectorAll('a').length;
  const childCount = el.children.length || 1;
  if (linkCount / childCount > 0.5) penalty += 0.4;

  // 含 <form> → 搜索/登录表单
  if (el.querySelector('form')) penalty += 0.2;

  // <li> 很多 → 列表/导航
  const listItems = el.querySelectorAll('li').length;
  if (listItems > 10) penalty += 0.3;

  // 含 iframe/embed → 嵌入内容
  if (el.querySelector('iframe, embed, object')) penalty += 0.2;

  return Math.min(penalty, 1);
}

// =============================================================================
// 综合评分
// =============================================================================

/** 各维度权重 */
const WEIGHTS = {
  textDensity: 30,
  linkDensity: 20,
  paragraphRatio: 25,
  headingScore: 10,
  stopwordScore: 10,
  classHint: 5,
  noisePenalty: 15, // 负向
};

/**
 * 对单个元素综合评分。
 * 返回 0-1 之间的分数。
 */
export function scoreElement(el: Element): number {
  const td = textDensity(el);
  const ld = linkDensity(el);
  const pr = paragraphRatio(el);
  const hs = headingScore(el);
  const ss = stopwordScore(el);
  const ch = classHint(el);
  const np = noisePenalty(el);

  const raw =
    td * WEIGHTS.textDensity +
    ld * WEIGHTS.linkDensity +
    pr * WEIGHTS.paragraphRatio +
    hs * WEIGHTS.headingScore +
    ss * WEIGHTS.stopwordScore +
    ch * WEIGHTS.classHint -
    np * WEIGHTS.noisePenalty;

  // 归一化到 0-1（满分 = 30+20+25+10+10+5 = 100）
  return Math.max(0, raw / 100);
}

// =============================================================================
// 候选收集
// =============================================================================

/**
 * 收集所有可能的正文候选容器。
 * 包括：语义标签、role 属性、class 名暗示、table 布局中的大 td、父级（向上 2 层）。
 */
export function collectCandidates(doc: Document): Element[] {
  const seen = new Set<Element>();
  const candidates: Element[] = [];

  function add(el: Element | null) {
    if (!el || seen.has(el) || el === doc.body || el === doc.documentElement) return;
    seen.add(el);
    candidates.push(el);
  }

  // 1) 语义标签
  for (const tag of ['article', 'main']) {
    for (const el of doc.querySelectorAll(tag)) {
      add(el);
    }
  }

  // 2) role 属性
  for (const sel of ['[role="main"]', '[role="article"]', '[role="region"]']) {
    for (const el of doc.querySelectorAll(sel)) {
      add(el);
    }
  }

  // 3) class 名暗示（div / section）
  for (const el of doc.querySelectorAll('div, section')) {
    const combined = `${el.className || ''} ${el.id || ''}`;
    if (POSITIVE_CLASS_RE.test(combined)) {
      add(el);
    }
  }

  // 4) table 布局中的大 td（Paul Graham 等老式站点）
  //    找文本长度 > 1000 字符的 td，作为候选
  for (const td of doc.querySelectorAll('td')) {
    const text = (td.textContent || '').trim();
    if (text.length > 1000) {
      add(td);
    }
  }

  // 5) 每个候选的父级（向上 2 层）
  const originals = [...candidates];
  for (const el of originals) {
    let parent = el.parentElement;
    for (let i = 0; i < 2 && parent && parent !== doc.body; i++) {
      add(parent);
      parent = parent.parentElement;
    }
  }

  // 6) 兜底：如果候选太少，把 body 的直接子 div 也加入
  if (candidates.length < 3) {
    for (const child of doc.body.children) {
      if (child.tagName === 'DIV' || child.tagName === 'SECTION') {
        add(child);
      }
    }
  }

  return candidates;
}

// =============================================================================
// 主入口
// =============================================================================

/**
 * 智能识别文章正文容器。
 *
 * @param doc Document
 * @returns 最佳候选元素，或 null（分数不够，建议回退 body）
 */
export function detectArticleRoot(doc: Document): Element | null {
  const candidates = collectCandidates(doc);
  if (candidates.length === 0) return null;

  let bestEl: Element | null = null;
  let bestScore = -1;

  for (const el of candidates) {
    const score = scoreElement(el);
    if (score > bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }

  if (bestScore < SCORE_THRESHOLD) {
    console.log(`[ContentDetector] Best score ${bestScore.toFixed(3)} < threshold ${SCORE_THRESHOLD}, fallback to body`);
    return null;
  }

  console.log(`[ContentDetector] Best: <${bestEl!.tagName}> .${(bestEl!.className || '').split(/\s+/)[0]} (score: ${bestScore.toFixed(3)})`);
  return bestEl;
}
