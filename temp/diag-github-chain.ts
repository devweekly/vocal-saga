/**
 * 诊断 .post__content 及其父链上各元素的 walker 判定结果。
 */
import { fetchPage } from '../lib/translate/urlFetcher';
import {
  isMetadataClass,
  hasContentTokens,
  shouldSkipByClass,
  isElementHidden,
  isNonHTMLNamespace,
} from '../lib/translate/blockExtractor/rules';
import { SKIP_SET, SEMANTIC_SKIP_TAGS } from '../lib/translate/blockExtractor/constants';

const url = 'https://github.blog/ai-and-ml/github-copilot/better-tools-made-copilot-code-review-worse-heres-how-we-actually-improved-it/';

async function main() {
  const page = await fetchPage(url, { timeoutMs: 20_000 });
  const postContent = page.doc.querySelector('.post__content');
  if (!postContent) return;

  // 父链
  const chain: Element[] = [];
  let cur: Element | null = postContent;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentElement;
  }

  console.log('Chain from document root down to .post__content:');
  chain.forEach((el, i) => {
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    const inSkipSet = SKIP_SET.has(tag);
    const inSemanticSkip = SEMANTIC_SKIP_TAGS.has(tag);
    const containerWithContent = (tag === 'section' || tag === 'div') && hasContentTokens(el);
    const metadataReject = tag !== 'article' && tag !== 'main' && isMetadataClass(el) && !containerWithContent;
    console.log(
      `  [${i}] <${tag}> cls="${cls.slice(0, 60)}" ` +
      `skipSet=${inSkipSet} semanticSkip=${inSemanticSkip} ` +
      `meta=${isMetadataClass(el)} contentToken=${hasContentTokens(el)} containerWithContent=${containerWithContent} metaReject=${metadataReject} ` +
      `skipClass=${shouldSkipByClass(el)} hidden=${isElementHidden(el)} namespace=${isNonHTMLNamespace(el)} textLen=${(el.textContent || '').length}`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
