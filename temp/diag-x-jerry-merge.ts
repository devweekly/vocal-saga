import * as fs from 'fs';
import { parseHTML } from 'linkedom';
import { extractBlocks } from '../lib/translate/blockExtractor';
import { prepareDocument } from '../lib/translate/contentHelper';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-jerry-devirtualized.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };
const url = 'https://x.com/jerryjliu0/status/2077537847951945742';

const beforeMerge = extractBlocks(doc.body, url);
console.log('before merge:', beforeMerge.length);
beforeMerge.slice(0, 20).forEach((b: any, i: number) => console.log(`[${i}] ${b.tag}: ${b.text.slice(0, 80)}`));

const prep = prepareDocument(doc, url);
console.log('\nafter merge:', prep.blocks.length);
prep.blocks.slice(0, 20).forEach((b: any, i: number) => console.log(`[${i}] ${b.tag}: ${b.text.slice(0, 80)}`));
