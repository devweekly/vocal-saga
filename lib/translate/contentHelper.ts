import { extractBlocks, type TextBlock } from './blockExtractor';
import { buildChunks, type Chunk } from './chunkBuilder';
import { detectArticleRoot } from './contentDetector';

// 优先级：先 class 后标签，先更具体的子容器再更通用的包裹元素。
// 像 bankingdive.com 把 <article> 用作整页 wrapper、正文放在
// .article-body 的站点，会直接定位到 .article-body。HBR 这种把整篇
// 装在 <article> 内的站点仍然走 <article>。
//
// 注意：选择器按 token 精确匹配（CSS 类选择器语义），所以 .blog-content
// 不会误命中 .blog-content__mbox / .blog-content__topic-block（BEM 子类
// 是独立 token）。Ghost 博客（commoncog.com 等）就靠这条。
const ARTICLE_SELECTORS = [
  '.article-body',
  '.article-content',
  '.article-text',
  '.story-body',
  '.story-content',
  '.u-rich-text-blog',        // Webflow blog rich text (claude.com)
  '.rich-text',               // Generic rich text wrapper
  '.post-content',            // Common blog CMS (Jane Street, Hugo, Jekyll)
  '.entry-content',           // WordPress
  '.page-content',
  '.blog-content',            // Ghost 博客（commoncog.com）
  'article',
  '[role="article"]',
  '[role="main"]',
  'main',
  '.main-content',
  '.content-body',
];

/**
 * 对于 bankingdive.com 这类把 <article> 当作整页 wrapper 的站点，
 * 直接用 <article> 会把页眉（h1、导语、分享菜单、署名、图片说明）
 * 和正文混在一起进同一个 chunk：模型拿到一份头重脚轻的输入，往
 * 往往正文翻译甚至直接截断。
 *
 * 策略：优先 .article-body 等具体容器，但当具体容器**外层是
 * <article> 且 <article> 里有不在该容器内的 h1/h2 标题**时，向上
 * 扩展到 <article>（TreeWalker 会一并遍历到 .first-page-pdf 里的 h1）。
 *
 * 校验：仅当 <article> 内**不在**该容器内、且有非空文本的 h1/h2
 * 才扩展。空标题（<h1></h1> 或全空格/装饰性 svg）不触发扩展，
 * 避免无谓把整页包装带回来。
 */
function hasValidHeadingOutside(
  container: Element,
  ancestor: Element
): Element | null {
  const headings = ancestor.querySelectorAll('h1, h2');
  for (const h of Array.from(headings)) {
    if (container.contains(h)) continue;
    const text = (h.textContent || '').trim();
    if (text.length < 4) continue;
    return h;
  }
  return null;
}

function refineArticleRoot(candidate: Element): Element {
  const SPECIFIC_SELECTORS = [
    '.article-body',
    '.article-content',
    '.article-text',
    '.story-body',
    '.story-content',
    '.post-content',            // Jane Street, Hugo, Jekyll
  ];

  if (SPECIFIC_SELECTORS.some((sel) => candidate.matches?.(sel))) {
    // candidate 已经是具体内容容器。如果它的祖先是 <article> 且
    // article 里有 h1/h2 标题不在 candidate 内，向上扩展到 <article>。
    const articleAncestor = candidate.closest('article');
    if (articleAncestor && articleAncestor !== candidate) {
      const heading = hasValidHeadingOutside(candidate, articleAncestor);
      if (heading) {
        console.log(
          '[ContentHelper] Bumping root up to <article> to capture heading:',
          heading.textContent?.slice(0, 40)
        );
        return articleAncestor;
      }
    }
    return candidate;
  }

  for (const sel of SPECIFIC_SELECTORS) {
    const inner = candidate.querySelector(sel);
    if (inner && candidate.contains(inner)) {
      // candidate 是 <article> 时：如果它本身含有效 h1/h2 标题而
      // inner 不含（典型：标题在 .first-page-pdf，正文在 .article-body），
      // 保留 candidate（<article>）并依赖 SKIP_CLASS_PATTERNS 过滤
      // 噪声；否则下钻到 inner。
      if (candidate.tagName.toLowerCase() === 'article') {
        const heading = hasValidHeadingOutside(inner, candidate);
        if (heading) {
          console.log(
            '[ContentHelper] Keeping outer <article> to preserve heading outside inner body:',
            heading.textContent?.slice(0, 40)
          );
          return candidate;
        }
      }
      console.log('[ContentHelper] Refining article root to inner:', sel);
      return inner;
    }
  }
  return candidate;
}

/**
 * Webflow 等 CMS 常把一篇博客拆到多个 .u-rich-text-blog / .rich-text 容器。
 * 第一个命中后只覆盖开篇，后续内容在同级兄弟容器中。
 *
 * 策略：逐层向上检查 ancestor 是否包含其他有实质文本的兄弟节点。
 * 如果有（且 ancestor 不是 nav/body），说明当前元素只是碎片，
 * 向上扩展到该 ancestor。
 *
 * 特殊处理 <main>：如果当前元素不包含 h1/h2 标题，继续向上扩展到 <main>，
 * 因为标题可能在 <main> 内但在 .entry-content 外。
 */
function expandIfFragmented(el: Element): Element {
  let current: Element = el;
  const MAX_UP = 6;
  for (let i = 0; i < MAX_UP; i++) {
    const parent = current.parentElement;
    if (!parent) break;

    const tag = parent.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;

    const classes = `${parent.className || ''} ${parent.id || ''}`;
    if (/nav|menu|sidebar|footer|header|comment|widget/i.test(classes)) break;

    // 当前元素不包含 h1/h2 标题 → 可能需要向上扩展来包含标题
    const hasHeading = current.querySelector('h1, h2') !== null;
    if (!hasHeading) {
      // 向上检查最多 3 级祖先，看标题是否在当前元素之外
      let ancestor: Element | null = parent;
      let foundHeadingOutside = false;
      for (let j = 0; j < 3 && ancestor; j++) {
        const ancTag = ancestor.tagName.toLowerCase();
        if (ancTag === 'body' || ancTag === 'html') break;
        // 检查 ancestor 的兄弟节点是否有标题
        const ancSiblings = Array.from(ancestor.parentElement?.children || []);
        foundHeadingOutside = ancSiblings.some(
          (s) => s !== ancestor && (s.tagName === 'H1' || s.tagName === 'H2' || s.querySelector?.('h1, h2'))
        );
        if (foundHeadingOutside) break;
        ancestor = ancestor.parentElement;
      }
      if (foundHeadingOutside) {
        current = parent;
        continue;
      }
    }

    const parentLen = (parent.textContent || '').trim().length;
    const currentLen = (current.textContent || '').trim().length;

    // 纯包装层（文本相同），穿过它继续向上
    if (parentLen <= currentLen) {
      current = parent;
      continue;
    }

    // parent 有额外文本：检查是否来自有实质内容的兄弟节点
    const siblings = Array.from(parent.children).filter((c) => c !== current);
    const hasRichSibling = siblings.some((s) => {
      const text = (s.textContent || '').trim();
      if (text.length > 200) return true;
      const sTag = s.tagName?.toLowerCase();
      if (sTag === 'h1' || sTag === 'h2') return true;
      if (s.querySelector('h1, h2')) return true;
      return false;
    });
    if (!hasRichSibling) break;

    current = parent;
  }
  return current;
}

function findArticleRoot(doc: Document): Element {
  // Layer 1: 选择器快速匹配（处理已知站点）
  for (const selector of ARTICLE_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el) {
      const refined = refineArticleRoot(el);
      // 如果 refine 后只覆盖碎片内容（如 Webflow 多个 .u-rich-text-blog），
      // 自动向上展开到包含所有片段的最近祖先
      const expanded = expandIfFragmented(refined);
      if (expanded !== refined) {
        console.log(
          `[ContentHelper] Expanded from <${refined.tagName}> .${(refined.className || '').slice(0, 40)} to <${expanded.tagName}> .${(expanded.className || '').slice(0, 40)}`,
        );
      }
      return expanded;
    }
  }

  // Layer 2: 智能评分（处理未知站点）
  const detected = detectArticleRoot(doc);
  if (detected) return detected;

  // Layer 3: 兜底
  return doc.body || doc.documentElement;
}

export function prepareDocument(
  root: Document | Element,
  pageUrl: string
): {
  blocks: TextBlock[];
  chunks: Chunk[];
  fullText: string;
} {
  // 优先使用文章容器，减少 TreeWalker 遍历范围
  // rootNode 是 Document 时找主文章容器 (article / main / [role=main])；
  // 否则直接用 rootNode (linkedom / jsdom 的 Document 是不同 class，不能 instanceof)
  const effectiveRoot = root.nodeType === 9 ? findArticleRoot(root as Document) : root;
  const blocks = extractBlocks(effectiveRoot, pageUrl);

  if (blocks.length === 0) {
    throw new Error('No translatable content found');
  }

  const fullText = blocks.map((b) => b.text).join('\n\n');
  const chunks = buildChunks(blocks);

  return { blocks, chunks, fullText };
}

export type { TextBlock, Chunk };
