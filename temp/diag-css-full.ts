import { fetchPage } from '../lib/translate/urlFetcher';
import { parseHTML } from 'linkedom';
import { stripDangerousScripts } from '../lib/spaGuard';
import { devirtualizeLayout } from '../lib/devirtualize';
import { injectRedirectGuard } from '../lib/redirectGuard';
import { prepareDocument } from '../lib/translate/contentHelper';

const url = 'https://www.technologyreview.com/2026/07/09/1140293/anthropic-found-a-hidden-space-where-claude-puzzles-over-concepts/';

const page = await fetchPage(url);
const { document } = parseHTML(page.html) as unknown as { document: Document };

console.log('before prep title:', document.querySelector('title')?.textContent?.slice(0, 60));
console.log('before prep has critical-css:', document.getElementById('critical-css') !== null);
console.log('before prep html starts:', document.documentElement.outerHTML.slice(0, 100));

const prep = prepareDocument(document, page.finalUrl);
console.log('blocks:', prep.blocks.length);

// Fake translations: identity
const { applyBlockTranslation, applyInlineTranslation } = await import('../lib/translate/translationDisplay');
const blockMap = new Map<string, Element>();
document.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
  const id = el.getAttribute('data-fanyi-block-id');
  if (id) blockMap.set(id, el);
});
for (const block of prep.blocks) {
  const el = blockMap.get(block.id);
  if (el && (el as Node).nodeType === 1) {
    const htmlEl = el as unknown as HTMLElement;
    applyBlockTranslation(htmlEl, `[译文] ${block.text}`, 'bilingual');
  }
}

// Set base like pipeline does
const cleanUrl = page.finalUrl.split('?')[0].split('#')[0];
let baseUrl: string;
if (cleanUrl.endsWith('/')) {
  baseUrl = cleanUrl;
} else if (/\.[a-zA-Z0-9]{1,10}$/.test(cleanUrl)) {
  baseUrl = new URL('.', cleanUrl).href;
} else {
  baseUrl = cleanUrl + '/';
}
const existingBase = document.querySelector('head > base');
if (existingBase) {
  existingBase.setAttribute('href', baseUrl);
} else {
  const base = document.createElement('base');
  base.setAttribute('href', baseUrl);
  const head = document.head;
  if (head) head.insertBefore(base, head.firstChild);
}

// Add fanyi styles like pipeline
const head = document.head;
if (head && !head.querySelector('#fanyi-bilingual-styles')) {
  const style = document.createElement('style');
  style.id = 'fanyi-bilingual-styles';
  style.textContent = '.fanyi-translation { display: block; }';
  head.appendChild(style);
}

const raw = '<!doctype html>\n' + document.documentElement.outerHTML;
console.log('raw after translate has critical-css:', raw.includes('id="critical-css"'));
console.log('raw after translate style tags:', (raw.match(/<style\b/gi) || []).length);
console.log('raw after translate first 200 chars:', raw.slice(0, 200));

const html2 = stripDangerousScripts(raw);
const html3 = devirtualizeLayout(html2);
const html4 = injectRedirectGuard(html3);
console.log('final has critical-css:', html4.includes('id="critical-css"'));
console.log('final style tags:', (html4.match(/<style\b/gi) || []).length);
console.log('final first 200 chars:', html4.slice(0, 200));
