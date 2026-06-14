import { parseHTML } from 'linkedom';
import { prepareDocument } from '../lib/translate/contentHelper';
import { collectCandidates, scoreElement } from '../lib/translate/contentDetector';

const ARTICLE_SELECTORS = [
  '.article-body', '.article-content', '.article-text',
  '.story-body', '.story-content',
  '.u-rich-text-blog', '.rich-text', '.post-content', '.entry-content',
  'article', '[role="article"]', '[role="main"]', 'main',
];

const URLs = [
  'https://techcrunch.com/',
  'https://www.theverge.com/',
  'https://blog.janestreet.com/formal-methods-at-jane-street-index/',
];

async function analyze(url: string) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const { document } = parseHTML(html) as { document: Document };

    // Layer 1 命中
    let layer1Hit = false;
    let layer1Selector = '';
    for (const sel of ARTICLE_SELECTORS) {
      if (document.querySelector(sel)) { layer1Hit = true; layer1Selector = sel; break; }
    }

    // Layer 2
    const candidates = collectCandidates(document);
    const layer2Hit = candidates.length > 0 && candidates.some(el => scoreElement(el) > 0.35);

    // DOM 节点数
    const domNodes = document.querySelectorAll('*').length;

    // Walker 提取
    const { blocks, chunks } = prepareDocument(document, url);

    // headingPath 统计
    const withHeading = blocks.filter(b => b.context?.headingPath?.length > 0).length;

    console.log('='.repeat(60));
    console.log('URL:', url);
    console.log('  DOM nodes:', domNodes);
    console.log('  Blocks:', blocks.length);
    console.log('  Chunks:', chunks.length);
    console.log('  Layer1:', layer1Hit ? 'HIT (' + layer1Selector + ')' : 'MISS');
    console.log('  Layer2:', !layer1Hit ? 'TRIGGERED' : 'SKIPPED');
    console.log('  Blocks with headingPath:', withHeading, '/', blocks.length);
  } catch (e) {
    console.log('URL:', url, 'ERROR:', (e as Error).message);
  }
}

async function main() {
  for (const url of URLs) {
    await analyze(url);
  }
}

main();
