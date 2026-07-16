import * as fs from 'fs';
import { parseHTML } from 'linkedom';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-origin-raw.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };

function dump(label: string, text: string) {
  const candidates = Array.from(doc.body.querySelectorAll('*')).filter((e) =>
    (e.textContent || '').includes(text)
  );
  if (candidates.length === 0) {
    console.log(label, 'NOT FOUND');
    return;
  }
  const el = candidates.reduce((min, e) =>
    (e.textContent || '').length < (min.textContent || '').length ? e : min
  );
  console.log('\n' + label);
  console.log('found tag:', el.tagName, 'textLen:', (el.textContent || '').length);
  console.log('outerHTML snippet:', el.outerHTML.slice(0, 300));
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur.tagName !== 'HTML' && depth < 6) {
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

dump('Relevant people sidebar', 'Relevant people');
dump('New to X card', 'New to X');
dump('Bottom CTA', "Don't miss");
