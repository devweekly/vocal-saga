import { parseHTML } from 'linkedom';
import { prepareDocument } from '../lib/translate/contentHelper';

const URLS = [
  'https://techcrunch.com/',
  'https://www.theverge.com/',
  'https://blog.janestreet.com/formal-methods-at-jane-street-index/',
  'https://arxiv.org/html/2601.14470v1',
];

async function analyze(url: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`URL: ${url}`);

  // 1. fetch
  const t0 = performance.now();
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();
  const t1 = performance.now();
  console.log(`  fetch:        ${Math.round(t1 - t0)}ms  (${(html.length / 1024).toFixed(0)}KB)`);

  // 2. parseHTML
  const t2 = performance.now();
  const { document } = parseHTML(html) as { document: Document };
  const t3 = performance.now();
  const domNodes = document.querySelectorAll('*').length;
  console.log(`  parseHTML:    ${Math.round(t3 - t2)}ms  (${domNodes} nodes)`);

  // 3. prepareDocument (contentHelper + walker)
  const t4 = performance.now();
  const { blocks, chunks } = prepareDocument(document, url);
  const t5 = performance.now();
  console.log(`  prepareDoc:   ${Math.round(t5 - t4)}ms  (${blocks.length} blocks → ${chunks.length} chunks)`);

  // 4. headingPath 统计
  const withHeading = blocks.filter(b => b.context?.headingPath?.length > 0).length;
  console.log(`  headingPath:  ${withHeading}/${blocks.length} blocks`);

  // 5. xpath 统计
  const withXpath = blocks.filter(b => b.xpath && b.xpath.length > 0).length;
  console.log(`  xpath:        ${withXpath}/${blocks.length} blocks`);

  // 6. 总计
  console.log(`  ────────────────────────`);
  console.log(`  TOTAL:        ${Math.round(t5 - t0)}ms`);
}

async function main() {
  for (const url of URLS) {
    await analyze(url);
  }
}

main();
