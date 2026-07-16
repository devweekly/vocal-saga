import * as fs from 'fs';
import { parseHTML } from 'linkedom';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-origin-raw.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };

// 模拟 walker 提取的关键文本
const targets = [
  '01:03',
  '22:15',
  '3.1万',
  'Views',
  'Read 30 replies',
];

for (const text of targets) {
  const candidates = Array.from(doc.body.querySelectorAll('*')).filter((e) =>
    (e.textContent || '').trim() === text || (e.textContent || '').includes(text)
  );
  if (candidates.length === 0) {
    console.log('\n', text, 'NOT FOUND');
    continue;
  }
  const el = candidates.reduce((min, e) =>
    (e.textContent || '').length < (min.textContent || '').length ? e : min
  );
  console.log('\n---', text, '---');
  console.log('tag:', el.tagName, 'text:', JSON.stringify(el.textContent?.trim()));
  console.log('class:', el.className);
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur.tagName !== 'HTML' && depth < 8) {
    console.log(
      '  '.repeat(depth) +
        cur.tagName.toLowerCase() +
        '#' +
        cur.id +
        '.' +
        (cur.className || '').toString().split(/\s+/).slice(0, 4).join('.')
    );
    cur = cur.parentElement;
    depth++;
  }
}
