import * as fs from 'fs';
import { parseHTML } from 'linkedom';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-origin-raw.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };

const testIds = new Set<string>();
doc.querySelectorAll('[data-testid]').forEach((el) => {
  testIds.add(el.getAttribute('data-testid') || '');
});
console.log('All data-testid values:');
for (const id of Array.from(testIds).sort()) {
  console.log(' ', id);
}

// 看看 tweet 正文和元数据区的 data-testid
console.log('\nTweet text container:');
const tweetText = doc.querySelector('[data-testid="tweetText"]');
if (tweetText) {
  console.log('tag:', tweetText.tagName, 'class:', tweetText.className);
  console.log('text:', tweetText.textContent?.slice(0, 300));
}
