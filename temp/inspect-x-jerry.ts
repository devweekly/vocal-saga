import * as fs from 'fs';
import { parseHTML } from 'linkedom';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-jerry-raw.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };

function summarize(el: Element, depth = 0): string {
  const tag = el.tagName.toLowerCase();
  const testid = el.getAttribute('data-testid') || '';
  const cls = (el.getAttribute('class') || '').split(' ').slice(0, 3).join(' ');
  const text = (el.textContent || '').slice(0, 120).replace(/\s+/g, ' ');
  const id = el.getAttribute('id') || '';
  const attrs = [testid && `testid=${testid}`, cls && `class=${cls}`, id && `id=${id}`].filter(Boolean).join(' ');
  return `${'  '.repeat(depth)}<${tag}>${attrs ? ' ' + attrs : ''}${text ? ' | ' + text : ''}`;
}

console.log('=== twitterArticleRichTextView ===');
const articleView = doc.querySelector('[data-testid="twitterArticleRichTextView"]');
if (articleView) {
  console.log('Found twitterArticleRichTextView');
  console.log(summarize(articleView));
  let i = 0;
  for (const child of Array.from(articleView.children).slice(0, 30)) {
    console.log(summarize(child, 1));
    for (const c2 of Array.from(child.children).slice(0, 10)) {
      console.log(summarize(c2, 2));
    }
    if (++i > 15) break;
  }
} else {
  console.log('NOT FOUND twitterArticleRichTextView');
}

console.log('\n=== tweetText ===');
const tweetText = doc.querySelector('[data-testid="tweetText"]');
if (tweetText) {
  console.log('Found tweetText');
  console.log(summarize(tweetText));
  for (const child of Array.from(tweetText.children).slice(0, 20)) {
    console.log(summarize(child, 1));
  }
} else {
  console.log('NOT FOUND tweetText');
}

console.log('\n=== all public-DraftStyleDefault-block paragraphs ===');
const blocks = doc.querySelectorAll('.public-DraftStyleDefault-block');
console.log('count:', blocks.length);
for (const b of Array.from(blocks).slice(0, 20)) {
  console.log('---');
  console.log(summarize(b));
  for (const c of Array.from(b.children).slice(0, 5)) {
    console.log(summarize(c, 1));
  }
}
