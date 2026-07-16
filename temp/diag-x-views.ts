import * as fs from 'fs';
import { parseHTML } from 'linkedom';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-origin-raw.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };

// 找包含 Views 的 a 标签
const el = Array.from(doc.body.querySelectorAll('a')).find((a) =>
  (a.textContent || '').includes('Views')
);
if (el) {
  console.log('href:', el.getAttribute('href'));
  console.log('class:', el.className);
  console.log('text:', el.textContent?.trim());
}

// 找时间戳的 span.contents
const timeSpan = Array.from(doc.body.querySelectorAll('span.contents')).find((s) =>
  (s.textContent || '').includes('22:15')
);
if (timeSpan) {
  console.log('\ntimestamp span class:', timeSpan.className);
  console.log('parent class:', timeSpan.parentElement?.className);
  console.log('text:', timeSpan.textContent?.trim());
}
