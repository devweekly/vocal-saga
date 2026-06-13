import { parseHTML } from 'linkedom';
import { extractBlocks } from '/Users/saga/code-repos/vocal-saga/lib/dist/translate/blockExtractor/index.js';
import fs from 'fs';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/original.html', 'utf-8');
const { document } = parseHTML(html);

const blog = document.querySelector('.u-rich-text-blog');
console.log('Blog nodeType:', blog?.nodeType, 'className:', blog?.className?.slice(0, 60));
const root = blog || document.body;
console.log('Using root:', root === blog ? '.u-rich-text-blog' : 'body');

const blocks = extractBlocks(root, 'https://claude.com/blog/test');
console.log('Blocks found:', blocks.length);
for (const b of blocks) {
  const tag = b.tag || '?';
  const text = (b.text || '').slice(0, 80);
  console.log('  ' + b.id + ' <' + tag + '> ' + text.replace(/\n/g, '\\n'));
}
