import * as fs from 'fs';
import { parseHTML } from 'linkedom';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-origin-raw.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };

function dump(label: string, text: string) {
  const candidates = Array.from(doc.body.querySelectorAll('a')).filter((a) =>
    (a.textContent || '').trim() === text
  );
  if (candidates.length === 0) {
    console.log(label, 'NOT FOUND');
    return;
  }
  const el = candidates[0];
  console.log('\n---', label, '---');
  console.log('href:', el.getAttribute('href'));
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

dump('author name', 'Nous Research');
dump('author handle', '@NousResearch');
