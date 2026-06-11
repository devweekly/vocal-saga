import { extractBlocks, type TextBlock } from './blockExtractor';
import { buildChunks, type Chunk } from './chunkBuilder';

// 优先级：先 class 后标签，先更具体的子容器再更通用的包裹元素。
// 像 bankingdive.com 把 <article> 用作整页 wrapper、正文放在
// .article-body 的站点，会直接定位到 .article-body。HBR 这种把整篇
// 装在 <article> 内的站点仍然走 <article>。
const ARTICLE_SELECTORS = [
  '.article-body',
  '.article-content',
  '.article-text',
  '.story-body',
  '.story-content',
  'article',
  '[role="article"]',
  '[role="main"]',
  'main',
  '.main-content',
  '.content-body',
  '.post-content',
  '.entry-content',
  '.page-content',
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

function findArticleRoot(doc: Document): Element {
  for (const selector of ARTICLE_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el) return refineArticleRoot(el);
  }
  return doc.body || doc.documentElement;
}

export function prepareDocument(root: Document | Element): {
  blocks: TextBlock[];
  chunks: Chunk[];
  fullText: string;
} {
  // 优先使用文章容器，减少 TreeWalker 遍历范围
  const effectiveRoot = root instanceof Document ? findArticleRoot(root) : root;
  const blocks = extractBlocks(effectiveRoot);

  if (blocks.length === 0) {
    throw new Error('No translatable content found');
  }

  const fullText = blocks.map((b) => b.text).join('\n\n');
  const chunks = buildChunks(blocks);

  return { blocks, chunks, fullText };
}

export type { TextBlock, Chunk };
