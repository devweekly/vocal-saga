/**
 * 测试 @mozilla/readability 对 github.blog 的处理结果。
 */
import { Readability } from '@mozilla/readability';
import { fetchPage } from '../lib/translate/urlFetcher';

const url = 'https://github.blog/ai-and-ml/github-copilot/better-tools-made-copilot-code-review-worse-heres-how-we-actually-improved-it/';

async function main() {
  const page = await fetchPage(url, { timeoutMs: 20_000 });
  console.log(`Fetched ${page.finalUrl} status=${page.status}`);

  // 在克隆文档上运行 Readability（因为它会修改 DOM）
  const { parseHTML } = await import('linkedom');
  const cloneDoc = parseHTML(page.doc.documentElement.outerHTML).document;

  const reader = new Readability(cloneDoc);
  const article = reader.parse();

  if (!article) {
    console.log('Readability returned null');
    return;
  }

  console.log('\nReadability result:');
  console.log(`  title: ${article.title}`);
  console.log(`  byline: ${article.byline}`);
  console.log(`  length: ${article.length}`);
  console.log(`  textContent length: ${article.textContent?.length || 0}`);
  console.log(`  excerpt: ${article.excerpt}`);
  console.log('\n  first 1000 chars of textContent:');
  console.log(article.textContent?.slice(0, 1000));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
