import * as fs from 'fs';
import { parseHTML } from 'linkedom';
import { stripDangerousScripts } from '../lib/spaGuard';
import { devirtualizeLayout } from '../lib/devirtualize';
import { injectRedirectGuard } from '../lib/redirectGuard';
import { prepareDocument } from '../lib/translate/contentHelper';
import { applyBlockTranslation } from '../lib/translate/translationDisplay';

const URL = 'https://x.com/deedydas/status/2076894544596177204';
const OUT_DIR = '/Users/saga/code-repos/vocal-saga/temp';

const raw = fs.readFileSync(`${OUT_DIR}/x-deedydas-raw.html`, 'utf-8');
console.log('Raw scripts:', (raw.match(/<script\b/gi) || []).length);

const stripped = stripDangerousScripts(raw);
console.log('After stripDangerousScripts scripts:', (stripped.match(/<script\b/gi) || []).length);

const devirtualized = devirtualizeLayout(stripped);
console.log('After devirtualize');

// 解析并 mock 翻译
const { document: doc } = parseHTML(devirtualized) as unknown as { document: Document };
const prep = prepareDocument(doc, URL);
console.log('blocks:', prep.blocks.length, 'chunks:', prep.chunks.length, 'strategy:', prep.report.strategy);

for (const block of prep.blocks) {
  const el = doc.querySelector(`[data-fanyi-block-id="${block.id}"]`) as HTMLElement | null;
  if (!el) continue;
  const translated = '【译文】' + block.text.slice(0, 60);
  applyBlockTranslation(el, translated, 'bilingual');
}

let html = '<!doctype html>\n' + doc.documentElement.outerHTML;
html = injectRedirectGuard(html);

fs.writeFileSync(`${OUT_DIR}/x-deedydas-mock-translated.html`, html);
console.log('Saved x-deedydas-mock-translated.html length:', html.length);

// 列出剩余 script src
const srcMatches = html.match(/<script\b[^>]*\bsrc="([^"]*)"[^>]*>/gi) || [];
console.log('Remaining script tags with src:', srcMatches.length);
srcMatches.slice(0, 20).forEach((s) => console.log('  ', s.replace(/[\s\S]*src="([^"]*)"[\s\S]*/, '$1')));

const inlineMatches = html.match(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || [];
console.log('Remaining inline script tags:', inlineMatches.length);
