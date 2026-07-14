/**
 * 诊断 github.blog .post__content 被 walker 拒绝的原因。
 */
import { fetchPage } from '../lib/translate/urlFetcher';
import {
  isMetadataClass,
  hasContentTokens,
  shouldSkipByClass,
  isElementHidden,
  isNonHTMLNamespace,
} from '../lib/translate/blockExtractor/rules';

const url = 'https://github.blog/ai-and-ml/github-copilot/better-tools-made-copilot-code-review-worse-heres-how-we-actually-improved-it/';

async function main() {
  const page = await fetchPage(url, { timeoutMs: 20_000 });
  console.log(`Fetched ${page.finalUrl} status=${page.status}`);

  const postContent = page.doc.querySelector('.post__content');
  if (!postContent) {
    console.log('No .post__content found');
    return;
  }

  console.log('\n.post__content element:');
  console.log(`  tag: ${postContent.tagName.toLowerCase()}`);
  console.log(`  className: "${postContent.className}"`);
  console.log(`  textLen: ${(postContent.textContent || '').length}`);

  console.log(`\n  isMetadataClass: ${isMetadataClass(postContent)}`);
  console.log(`  hasContentTokens: ${hasContentTokens(postContent)}`);
  console.log(`  shouldSkipByClass: ${shouldSkipByClass(postContent)}`);
  console.log(`  isElementHidden: ${isElementHidden(postContent)}`);
  console.log(`  isNonHTMLNamespace: ${isNonHTMLNamespace(postContent)}`);

  // 检查 class token 命中了哪些 SKIP_CLASS_PATTERNS
  const tokens = postContent.className.toLowerCase().split(/\s+/);
  const { SKIP_CLASS_PATTERNS } = await import('../lib/translate/blockExtractor/constants');
  console.log('\n  class tokens and matching skip patterns:');
  for (const token of tokens) {
    const matches = SKIP_CLASS_PATTERNS.filter((p) => {
      return token === p || token.startsWith(p + '-') || token.startsWith(p + '_') ||
             token.endsWith('-' + p) || token.endsWith('_' + p);
    });
    if (matches.length > 0) {
      console.log(`    "${token}" -> ${matches.join(', ')}`);
    }
  }

  // 检查是否有直接子元素被 reject
  console.log('\n  direct children of .post__content:');
  Array.from(postContent.children).slice(0, 10).forEach((c, i) => {
    console.log(`    [${i}] <${c.tagName.toLowerCase()}> class="${c.className || ''}" meta=${isMetadataClass(c)} skip=${shouldSkipByClass(c)} hidden=${isElementHidden(c)} textLen=${(c.textContent || '').length}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
