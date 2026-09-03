import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { chromium } from 'playwright';
import { stripDangerousScripts } from '../lib/spaGuard';
import { TRANSLATION_CSS, injectTranslationCss } from '../lib/app';
import { applyGlobalNoiseFromUrl } from '../lib/translate/contentHelper';
import { applySiteDisplayRules } from '../lib/translate/displayRules';
import { inlineExternalStylesheets } from '../lib/translate/cssInliner';

const URLS: Record<string, string> = {
  '601': 'https://github.com/anthropics/commerce-agents/',
  '585': 'https://x.com/UberEng/status/2093444169037762840/',
  '588': 'https://www.oreilly.com/radar/architectural-guardrails-for-ai-generated-code/',
  '579': 'https://towardsdatascience.com/8-tips-for-writing-effective-agent-instructions/',
};

async function build(id: string): Promise<string> {
  const raw = readFileSync(`/tmp/a${id}.html`, 'utf8');
  const url = URLS[id];
  let html = applyGlobalNoiseFromUrl(raw, url);
  html = injectTranslationCss(html);
  html = stripDangerousScripts(html);
  html = applySiteDisplayRules(html, url);
  if (id === '579') {
    html = html.replace(/\/assets\/app-[A-Za-z0-9_-]+\.css/g, '/assets/app-DMCTAuWW.css');
    html = await inlineExternalStylesheets(html, { baseUrl: url });
  }
  const file = `/tmp/fixed-${id}.html`;
  writeFileSync(file, html);
  return file;
}

describe('端到端渲染验证', () => {
  it('renders', async () => {
    expect(TRANSLATION_CSS).toContain('max-width:100%!important}');
    const b = await chromium.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
    const p = await ctx.newPage();
    for (const id of ['601', '585', '588', '579']) {
      const file = await build(id);
      await p.goto('file://' + file, { waitUntil: 'load', timeout: 90000 });
      await p.waitForTimeout(2500);
      const r = await p.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const vis = (el: Element) => {
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
          visible: tr.filter(vis).length,
          docW: document.documentElement.scrollWidth,
          primaryColumn: pc ? Math.round(pc.getBoundingClientRect().width) : null,
          rightRailHidden: rail ? !vis(rail) : null,
          oversizedMedia: bigs,
          inlinedCss: document.querySelectorAll('style[data-fanyi-inlined-css]').length,
          leftoverLinks: document.querySelectorAll('link[rel*=stylesheet]').length,
        };
      });
      console.log(id, JSON.stringify(r));
      await p.screenshot({ path: `/tmp/fixed-${id}.png` });
    }
    await b.close();
  }, 180000);
});
