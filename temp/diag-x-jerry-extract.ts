import * as fs from 'fs';
import { parseHTML } from 'linkedom';
import { extractBlocks } from '../lib/translate/blockExtractor';
import { selectBestRoot } from '../lib/translate/extraction/pipeline';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-jerry-devirtualized.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };
const url = 'https://x.com/jerryjliu0/status/2077537847951945742';

console.log('=== extract from selected root ===');
const selection = selectBestRoot(doc, url);
const blocks1 = extractBlocks(selection.root, url);
console.log('blocks:', blocks1.length);
blocks1.forEach((b, i) => console.log(`[${i}] ${b.tag}: ${b.text.slice(0, 100)}`));

console.log('\n=== extract from twitterArticleRichTextView ===');
const articleView = doc.querySelector('[data-testid="twitterArticleRichTextView"]')!;
const blocks2 = extractBlocks(articleView, url);
console.log('blocks:', blocks2.length);
blocks2.forEach((b, i) => console.log(`[${i}] ${b.tag}: ${b.text.slice(0, 100)}`));

console.log('\n=== extract from <article> ===');
const article = doc.querySelector('article')!;
const blocks3 = extractBlocks(article, url);
console.log('blocks:', blocks3.length);
blocks3.forEach((b, i) => console.log(`[${i}] ${b.tag}: ${b.text.slice(0, 100)}`));

console.log('\n=== extract from body ===');
const blocks4 = extractBlocks(doc.body, url);
console.log('blocks:', blocks4.length);
blocks4.forEach((b, i) => console.log(`[${i}] ${b.tag}: ${b.text.slice(0, 100)}`));
