import { fetchPage } from '../lib/translate/urlFetcher';
import { parseHTML } from 'linkedom';
import { stripDangerousScripts } from '../lib/spaGuard';
import { devirtualizeLayout } from '../lib/devirtualize';
import { injectRedirectGuard } from '../lib/redirectGuard';

const url = 'https://www.technologyreview.com/2026/07/09/1140293/anthropic-found-a-hidden-space-where-claude-puzzles-over-concepts/';

const page = await fetchPage(url);
console.log('fetched', page.html.length, 'bytes');
console.log('original has critical-css:', page.html.includes('id="critical-css"'));
console.log('original style tags:', (page.html.match(/<style\b/gi) || []).length);

const html2 = stripDangerousScripts(page.html);
console.log('after stripDangerousScripts has critical-css:', html2.includes('id="critical-css"'));
console.log('after stripDangerousScripts style tags:', (html2.match(/<style\b/gi) || []).length);

const html3 = devirtualizeLayout(html2);
console.log('after devirtualizeLayout has critical-css:', html3.includes('id="critical-css"'));
console.log('after devirtualizeLayout style tags:', (html3.match(/<style\b/gi) || []).length);

const html4 = injectRedirectGuard(html3);
console.log('after injectRedirectGuard has critical-css:', html4.includes('id="critical-css"'));
console.log('after injectRedirectGuard style tags:', (html4.match(/<style\b/gi) || []).length);

// Parse with linkedom and serialize to mimic pipeline output
const { document } = parseHTML(html4) as unknown as { document: Document };
const serialized = '<!doctype html>\n' + document.documentElement.outerHTML;
console.log('serialized has critical-css:', serialized.includes('id="critical-css"'));
console.log('serialized style tags:', (serialized.match(/<style\b/gi) || []).length);
console.log('serialized first 300 chars:', serialized.slice(0, 300));
