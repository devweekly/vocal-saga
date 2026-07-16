import * as fs from 'fs';
import { parseHTML } from 'linkedom';
import { collectBlocks } from '../lib/translate/blockExtractor/walker';
import type { TextBlock } from '../lib/translate/blockExtractor/types';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-jerry-devirtualized.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };
const url = 'https://x.com/jerryjliu0/status/2077537847951945742';

const articleView = doc.querySelector('[data-testid="twitterArticleRichTextView"]')!;
const blocks: TextBlock[] = [];
const blockIdRef = { value: 0 };
const seenTexts = new Set<string>();
const counters = collectBlocks(articleView, blocks, blockIdRef, seenTexts, url);
console.log('counters:', counters);
console.log('blocks from articleView:', blocks.length);
blocks.forEach((b, i) => console.log(`[${i}] ${b.tag}: ${b.text.slice(0, 100)}`));

// Try first paragraph only
console.log('\n--- first paragraph ---');
const firstPara = doc.querySelector('.public-DraftStyleDefault-block');
if (firstPara) {
  const blocks2: TextBlock[] = [];
  const seen2 = new Set<string>();
  const counters2 = collectBlocks(firstPara, blocks2, blockIdRef, seen2, url);
  console.log('counters:', counters2);
  console.log('blocks from firstPara:', blocks2.length);
  blocks2.forEach((b, i) => console.log(`[${i}] ${b.tag}: ${b.text.slice(0, 100)}`));
}
