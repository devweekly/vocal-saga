import { fetchPage } from '../lib/translate/urlFetcher';
import { parseHTML } from 'linkedom';
import { stripDangerousScripts } from '../lib/spaGuard';
import { devirtualizeLayout } from '../lib/devirtualize';
import { injectRedirectGuard } from '../lib/redirectGuard';
import { prepareDocument } from '../lib/translate/contentHelper';

const url = 'https://www.technologyreview.com/2026/07/09/1140293/anthropic-found-a-hidden-space-where-claude-puzzles-over-concepts/';

const page = await fetchPage(url);
console.log('fetched', page.html.length, 'bytes');

const { document } = parseHTML(page.html) as unknown as { document: Document };
console.log('parsed title:', document.querySelector('title')?.textContent?.slice(0, 80));
console.log('parsed has critical-css before prep:', document.getElementById('critical-css') !== null);

const prep = prepareDocument(document, page.finalUrl);
console.log('blocks:', prep.blocks.length);
console.log('parsed has critical-css after prep:', document.getElementById('critical-css') !== null);

const html2 = stripDangerousScripts(document.documentElement.outerHTML);
console.log('after stripDangerousScripts has critical-css:', html2.includes('id="critical-css"'));

const html3 = devirtualizeLayout(html2);
console.log('after devirtualizeLayout has critical-css:', html3.includes('id="critical-css"'));

const html4 = injectRedirectGuard(html3);
console.log('after injectRedirectGuard has critical-css:', html4.includes('id="critical-css"'));

const { document: doc2 } = parseHTML(html4) as unknown as { document: Document };
const serialized = '<!doctype html>\n' + doc2.documentElement.outerHTML;
console.log('serialized has critical-css:', serialized.includes('id="critical-css"'));
console.log('serialized style tags:', (serialized.match(/<style\b/gi) || []).length);
console.log('serialized first 300 chars:', serialized.slice(0, 300));
