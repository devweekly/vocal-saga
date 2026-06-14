import { parseHTML } from 'linkedom';
import { prepareDocument } from '../lib/translate/contentHelper';

const URLS = [
  'https://blog.janestreet.com/formal-methods-at-jane-street-index/',
  'https://arxiv.org/html/2601.14470v1',
];

async function analyze(url: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`URL: ${url}`);

  // fetch (I/O, 不算 CPU)
  const t0 = performance.now();
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();
  const t1 = performance.now();
  console.log(`  fetch (I/O):     ${Math.round(t1 - t0)}ms  (${(html.length / 1024).toFixed(0)}KB)`);

  // parseHTML (CPU)
  const t2 = performance.now();
  const { document } = parseHTML(html) as { document: Document };
  const t3 = performance.now();
  const domNodes = document.querySelectorAll('*').length;
  console.log(`  parseHTML:       ${Math.round(t3 - t2)}ms  (${domNodes} nodes)`);

  // contentHelper + walker + headingPath + xpath (CPU)
  const t4 = performance.now();
  const { blocks, chunks } = prepareDocument(document, url);
  const t5 = performance.now();
  console.log(`  prepareDoc:      ${Math.round(t5 - t4)}ms  (${blocks.length} blocks → ${chunks.length} chunks)`);

  // headingPath 统计
  const withHeading = blocks.filter(b => b.context?.headingPath?.length > 0).length;
  console.log(`  headingPath:     ${withHeading}/${blocks.length} blocks`);

  // xpath 统计
  const withXpath = blocks.filter(b => b.xpath && b.xpath.length > 0).length;
  console.log(`  xpath:           ${withXpath}/${blocks.length} blocks`);

  // chunkBuilder 单独计时
  const t6 = performance.now();
  // prepareDocument 内部已经调用了 buildChunks，这里模拟看看如果单独调
  // 实际上 prepareDoc 已经包含了 chunkBuilder

  // translateChunks 模拟（不实际调 API）
  const service = { translate: async () => '[]' } as any;
  const t7 = performance.now();
  // 这里只是模拟构造请求的 CPU 开销
  try {
    for (const chunk of chunks.slice(0, 2)) { // 只测 2 个 chunk
      buildTranslationBody(
        JSON.parse(chunk.jsonContent),
        'en', 'zh'
      );
    }
  } catch {}
  const t8 = performance.now();
  console.log(`  reqConstruct(2): ${Math.round(t8 - t7)}ms`);

  // CPU 时间总计
  const cpuTime = (t3 - t2) + (t5 - t4) + (t8 - t7);
  console.log(`  ────────────────────────`);
  console.log(`  CPU total:       ${Math.round(cpuTime)}ms`);
  console.log(`  (parseHTML + prepareDoc + reqConstruct)`);
}

async function main() {
  for (const url of URLS) {
    await analyze(url);
  }
}

main();
