import * as fs from 'fs';
import { parseHTML } from 'linkedom';
import {
  isElementHidden,
  shouldSkipByClass,
  shouldSkipBySiteRules,
  isMetadataClass,
  isOverlayElement,
  isLowPriorityElement,
  isValidText,
  isInsideArticle,
  hasBlockLevelParent,
} from '../lib/translate/blockExtractor/rules';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-jerry-devirtualized.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };
const url = 'https://x.com/jerryjliu0/status/2077537847951945742';

const blocks = doc.querySelectorAll('.public-DraftStyleDefault-block');
console.log('total .public-DraftStyleDefault-block:', blocks.length);

for (const b of Array.from(blocks)) {
  const text = b.textContent || '';
  const trimmed = text.trim();
  console.log('\n--- block ---');
  console.log('text:', trimmed.slice(0, 120));
  console.log('  hidden:', isElementHidden(b));
  console.log('  skipByClass:', shouldSkipByClass(b));
  console.log('  skipBySiteRules:', shouldSkipBySiteRules(b, url));
  console.log('  metadataClass:', isMetadataClass(b));
  console.log('  overlay:', isOverlayElement(b));
  console.log('  lowPriority:', isLowPriorityElement(b));
  console.log('  validText:', isValidText(text, url));
  console.log('  insideArticle:', isInsideArticle(b));
  console.log('  hasBlockLevelParent:', hasBlockLevelParent(b));
  console.log('  children:', Array.from(b.children).map((c) => c.tagName.toLowerCase()).join(', '));
}
