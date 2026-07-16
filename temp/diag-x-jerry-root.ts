import * as fs from 'fs';
import { parseHTML } from 'linkedom';
import { selectBestRoot } from '../lib/translate/extraction/pipeline';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-jerry-devirtualized.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };
const url = 'https://x.com/jerryjliu0/status/2077537847951945742';

const ctx: any = {};
const selection = selectBestRoot(doc, url, ctx);
console.log('selected root:', selection.root.tagName, selection.root.className?.toString()?.slice(0, 100));
console.log('strategy:', selection.strategy);
console.log('confidence:', selection.confidence);
console.log('root text length:', selection.root.textContent?.length);

const articleView = doc.querySelector('[data-testid="twitterArticleRichTextView"]');
console.log('\narticleView found:', !!articleView);
if (articleView) {
  console.log('articleView contains selected root?', articleView.contains(selection.root));
  console.log('selected root contains articleView?', selection.root.contains(articleView));
  console.log('articleView text length:', articleView.textContent?.length);
}

const article = doc.querySelector('article');
console.log('\n<article> found:', !!article);
if (article) {
  console.log('article contains selected root?', article.contains(selection.root));
  console.log('selected root contains article?', selection.root.contains(article));
  console.log('article text length:', article.textContent?.length);
}

// Check ancestors of articleView
if (articleView) {
  console.log('\nancestors of articleView:');
  let cur: Element | null = articleView;
  let depth = 0;
  while (cur && depth < 20) {
    console.log('  '.repeat(depth) + cur.tagName + (cur.className ? '.' + cur.className.toString().split(' ').slice(0, 2).join('.') : '') + (cur.getAttribute('data-testid') ? ' testid=' + cur.getAttribute('data-testid') : ''));
    cur = cur.parentElement;
    depth++;
  }
}
