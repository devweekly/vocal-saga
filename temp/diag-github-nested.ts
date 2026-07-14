/**
 * 诊断 github.blog .post__content 内嵌套 <html><body> 的内容结构。
 */
import { fetchPage } from '../lib/translate/urlFetcher';

const url = 'https://github.blog/ai-and-ml/github-copilot/better-tools-made-copilot-code-review-worse-heres-how-we-actually-improved-it/';

async function main() {
  const page = await fetchPage(url, { timeoutMs: 20_000 });
  const postContent = page.doc.querySelector('.post__content');
  if (!postContent) return;

  console.log('.post__content children:');
  Array.from(postContent.childNodes).forEach((n, i) => {
    console.log(`  [${i}] nodeType=${n.nodeType} tag=${(n as Element).tagName || '#text'} textLen=${(n.textContent || '').length}`);
  });

  const nestedHtml = postContent.querySelector('html');
  if (!nestedHtml) {
    console.log('No nested <html>');
    return;
  }

  console.log('\nnested <html> parent:', nestedHtml.parentElement?.tagName.toLowerCase());
  console.log('nested <html> children:');
  Array.from(nestedHtml.childNodes).forEach((n, i) => {
    console.log(`  [${i}] nodeType=${n.nodeType} tag=${(n as Element).tagName || '#text'} textLen=${(n.textContent || '').length}`);
  });

  const nestedBody = nestedHtml.querySelector('body');
  if (!nestedBody) {
    console.log('No nested <body>');
    return;
  }

  console.log('\nnested <body> children (first 20):');
  Array.from(nestedBody.children).slice(0, 20).forEach((c, i) => {
    const text = (c.textContent || '').trim().slice(0, 80).replace(/\s+/g, ' ');
    console.log(`  [${i}] <${c.tagName.toLowerCase()}> class="${c.className || ''}" textLen=${(c.textContent || '').length} ${text}`);
  });

  // 测试从 .post__content 提取 blocks
  const { extractBlocks } = await import('../lib/translate/blockExtractor');
  const blocks = extractBlocks(postContent, page.finalUrl);
  console.log(`\nExtract blocks from .post__content directly: ${blocks.length}`);
  blocks.slice(0, 15).forEach((b, i) => {
    console.log(`  [${i}] ${b.tag} "${b.text.slice(0, 80).replace(/\n/g, ' ')}"`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
