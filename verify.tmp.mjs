/**
 * 端到端验证：把新 pipeline 作用在真实抓取的 /article 页面上，用浏览器量结果。
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { stripDangerousScripts } from './lib/dist/spaGuard.js';
// lib/dist/app.js 是 extensionless ESM，Node 直接 import 会失败，
// 这里只需要 TRANSLATION_CSS 常量，复制一份（值与 lib/app.ts 保持一致）
const TRANSLATION_CSS = [
  '.fanyi-original{display:block!important;position:static!important;float:none!important;',
  'clear:both!important;margin:0!important;padding:0!important;max-width:100%!important;',
  'box-sizing:border-box!important;order:0!important}',
  '.fanyi-translation{display:block!important;position:static!important;float:none!important;',
  'clear:both!important;margin:0!important;padding:.15em .6em 0 0!important;',
  'border-left:0!important;border-left-width:0!important;max-width:100%!important;',
  'box-sizing:border-box!important;order:1!important;margin-top:.3em!important}',
  'img,video,picture,figure,table,iframe{max-width:100%!important}',
  'img,video{height:auto!important}',
].join('');
const injectTranslationCss = (html) =>
  html.includes('</head>')
    ? html.replace('</head>', `<style data-fanyi-css>${TRANSLATION_CSS}</style></head>`)
    : `<style data-fanyi-css>${TRANSLATION_CSS}</style>` + html;
import { applyGlobalNoiseFromUrl } from './lib/dist/translate/contentHelper.js';
import { applySiteDisplayRules } from './lib/dist/translate/displayRules.js';
import { inlineExternalStylesheets } from './lib/dist/translate/cssInliner.js';

const URLS = {
  601: 'https://github.com/anthropics/commerce-agents/',
  585: 'https://x.com/UberEng/status/2093444169037762840/',
  588: 'https://www.oreilly.com/radar/architectural-guardrails-for-ai-generated-code/',
  579: 'https://towardsdatascience.com/8-tips-for-writing-effective-agent-instructions/',
};

async function build(id) {
  const raw = readFileSync(`/tmp/a${id}.html`, 'utf8');
  const url = URLS[id];
  let html = applyGlobalNoiseFromUrl(raw, url);
  html = injectTranslationCss(html);
  html = stripDangerousScripts(html);
  html = applySiteDisplayRules(html, url);
  // 579 额外验证：把死掉的哈希 CSS 换成线上当前版本，再走内联器（模拟重新抓取）
  if (id === 579) {
    html = html.replace(/\/assets\/app-[A-Za-z0-9_-]+\.css/g, '/assets/app-DMCTAuWW.css');
    html = await inlineExternalStylesheets(html, { baseUrl: url });
  }
  const file = `/tmp/fixed-${id}.html`;
  writeFileSync(file, html);
  return file;
}

const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();

for (const id of [601, 585, 588, 579]) {
  const file = await build(id);
  await p.goto('file://' + file, { waitUntil: 'load', timeout: 90000 });
  await p.waitForTimeout(2500);
  const r = await p.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const vis = (el) => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const tr = Array.from(document.querySelectorAll('.fanyi-translation'));
    const pc = document.querySelector('[data-testid="primaryColumn"]');
    const rail = document.querySelector('#right-rail');
    const bigs = Array.from(document.querySelectorAll('img,video,iframe'))
      .filter((e) => e.getBoundingClientRect().width > vw * 0.95).length;
    return {
      translations: tr.length,
      visibleTranslations: tr.filter(vis).length,
      docW: document.documentElement.scrollWidth,
      primaryColumn: pc ? Math.round(pc.getBoundingClientRect().width) : null,
      rightRailHidden: rail ? !vis(rail) : null,
      oversizedMedia: bigs,
      inlinedCss: document.querySelectorAll('style[data-fanyi-inlined-css]').length,
      leftoverLinks: document.querySelectorAll('link[rel*=stylesheet]').length,
    };
  });
  console.log(id, JSON.stringify(r));
}
await b.close();
