import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

async function run(javaScriptEnabled) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, javaScriptEnabled });
  const p = await ctx.newPage();
  await p.goto('https://s.sunxiunan.com/article/601', { waitUntil: 'load', timeout: 90000 });
  await p.waitForTimeout(3000);
  const r = await p.evaluate(() => {
    const tr = document.querySelectorAll('.fanyi-translation').length;
    const bid = document.querySelectorAll('[data-fanyi-block-id]').length;
    const art = document.querySelector('article.markdown-body');
    return {
      tr, bid,
      articleText: art ? art.textContent.trim().slice(0, 120) : null,
      scripts: document.querySelectorAll('script').length,
      reactRoot: !!document.querySelector('[data-reactroot], #__primerPortalRoot__, react-app'),
    };
  });
  console.log('js=' + javaScriptEnabled, JSON.stringify(r));
  await ctx.close();
}
await run(false);
await run(true);
await b.close();
