/**
 * 本地验证脚本：抓取真实页面 → linkedom 解析 → contentDetector 评分
 * 用法：npx tsx scripts/test-content-detection.ts
 */
import { parseHTML } from 'linkedom';
import { scoreElement, collectCandidates, detectArticleRoot } from '../lib/translate/contentDetector';
import { prepareDocument } from '../lib/translate/contentHelper';

const URLS = [
  // 已知站点（Layer 1 应命中）
  'https://blog.janestreet.com/formal-methods-at-jane-street-index/',
  'https://techcrunch.com/',
  // 未知站点（可能需要 Layer 2 评分）
  'https://www.paulgraham.com/greatwork.html',
  'https://www.joelonsoftware.com/',
];

async function fetchAndAnalyze(url: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`URL: ${url}`);
  console.log('='.repeat(70));

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentDetector/1.0)' },
      redirect: 'follow',
    });
    console.log(`Status: ${res.status} | Content-Type: ${res.headers.get('content-type')}`);

    if (!res.ok) {
      console.log('SKIP: non-200 response');
      return;
    }

    const html = await res.text();
    console.log(`HTML size: ${(html.length / 1024).toFixed(1)} KB`);

    const { document } = parseHTML(html) as { document: Document };

    // Layer 1: 选择器
    const SELECTORS = [
      '.article-body', '.article-content', '.article-text',
      '.story-body', '.story-content',
      '.u-rich-text-blog', '.rich-text', '.post-content', '.entry-content',
      'article', '[role="article"]', '[role="main"]', 'main',
    ];
    let found = false;
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        console.log(`Layer 1 HIT: <${el.tagName}> via "${sel}"`);
        found = true;
        break;
      }
    }

    // Layer 2: 智能评分
    if (!found) {
      console.log('Layer 1: no match → trying Layer 2 (scoring)');
      const candidates = collectCandidates(document);
      console.log(`  Candidates: ${candidates.length}`);

      const scored = candidates.map(el => ({
        tag: el.tagName,
        class: (el.className || '').split(/\s+/).slice(0, 3).join(' '),
        id: el.id || '',
        score: scoreElement(el),
      })).sort((a, b) => b.score - a.score);

      console.log('  Top 5:');
      for (const s of scored.slice(0, 5)) {
        console.log(`    <${s.tag}> .${s.class} #${s.id} → ${s.score.toFixed(3)}`);
      }

      const best = detectArticleRoot(document);
      if (best) {
        console.log(`  Layer 2 HIT: <${best.tagName}> .${(best.className || '').split(/\s+/)[0]}`);
      } else {
        console.log('  Layer 2: no candidate above threshold → fallback body');
      }
    }

    // 完整 pipeline 测试
    console.log('\n--- prepareDocument ---');
    const { blocks, chunks, fullText } = prepareDocument(document, url);
    console.log(`Blocks: ${blocks.length} | Chunks: ${chunks.length} | Text: ${fullText.length} chars`);
    if (blocks.length > 0) {
      console.log(`First block: "${blocks[0].text.slice(0, 80)}..."`);
      console.log(`Last block:  "${blocks[blocks.length - 1].text.slice(0, 80)}..."`);
    }
  } catch (err) {
    console.log(`ERROR: ${(err as Error).message}`);
  }
}

async function main() {
  for (const url of URLS) {
    await fetchAndAnalyze(url);
  }
}

main().catch(console.error);
