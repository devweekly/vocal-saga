import * as fs from 'fs';
import { parseHTML } from 'linkedom';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-origin-raw.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };

const targetText = 'For our Accelerated Business Hackathon';
const candidates = Array.from(doc.querySelectorAll('*')).filter((e) =>
  (e.textContent || '').includes(targetText)
);
if (candidates.length === 0) {
  console.log('not found');
  process.exit(1);
}
// 取包含目标文本的最小元素（textContent 最短）
const el = candidates.reduce((min, e) =>
  (e.textContent || '').length < (min.textContent || '').length ? e : min
);
console.log('candidates count:', candidates.length);
console.log('selected text length:', el.textContent?.length);

let cur: Element | null = el;
const chain: string[] = [];
while (cur && cur.tagName !== 'HTML') {
  const id = cur.id ? '#' + cur.id : '';
  const cls = cur.className
    ? '.' +
      cur.className
        .toString()
        .split(/\s+/)
        .slice(0, 3)
        .join('.')
    : '';
  chain.unshift(cur.tagName.toLowerCase() + id + cls);
  cur = cur.parentElement;
}
console.log('ancestor chain:', chain.join(' > '));
console.log('\nouterHTML snippet:');
console.log(el.outerHTML.slice(0, 3000));
