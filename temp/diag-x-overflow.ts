import * as fs from 'fs';
import { parseHTML } from 'linkedom';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-origin-raw.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };

const containers = doc.body.querySelectorAll('div.overflow-hidden.flex-col.items-start.gap-0');
console.log('found', containers.length, 'containers');
for (const c of Array.from(containers)) {
  console.log('\ntext:', JSON.stringify(c.textContent?.trim().slice(0, 200)));
  console.log('children tags:', Array.from(c.children).map((e) => e.tagName.toLowerCase()).join(', '));
}
