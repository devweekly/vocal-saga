import { describe, it, expect } from 'vitest';
import { chromium } from 'playwright';

describe('601 结构完整性', () => {
  it('JS 全剥离后正文/代码/目录仍完整', async () => {
    const b = await chromium.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
    const p = await ctx.newPage();
    await p.goto('file:///tmp/fixed-601.html', { waitUntil: 'load', timeout: 90000 });
    await p.waitForTimeout(2000);
    const r = await p.evaluate(() => {
      const art = document.querySelector('article.markdown-body');
      const header = document.querySelector('header');
      const w = (s: string) => {
        const e = document.querySelector(s);
        return e ? Math.round(e.getBoundingClientRect().width) : null;
      };
      return {
        articleTextLen: (art?.textContent || '').length,
        articleWidth: art ? Math.round(art.getBoundingClientRect().width) : null,
        headers: document.querySelectorAll('article h1,article h2,article h3').length,
        codeBlocks: document.querySelectorAll('article pre').length,
        links: document.querySelectorAll('article a').length,
        headerVisible: header ? header.getBoundingClientRect().height > 0 : null,
        container: w('.prc-PageLayout-PageLayoutRoot--KH-d'),
      };
    });
    console.log(JSON.stringify(r));
    expect(r.articleTextLen).toBeGreaterThan(3000);
    expect(r.articleWidth).toBeGreaterThan(600);
    expect(r.headers).toBeGreaterThan(5);
    await b.close();
  }, 120000);
});
