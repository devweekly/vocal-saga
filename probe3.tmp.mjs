import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();
await p.goto('https://s.sunxiunan.com/article/579', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(2500);
const r = await p.evaluate(() => {
  const big = Array.from(document.querySelectorAll('img')).find((e) => e.getBoundingClientRect().width > 2000);
  const chain = [];
  let a = big;
  while (a && chain.length < 12) {
    const cs = getComputedStyle(a);
    const rect = a.getBoundingClientRect();
    chain.push(a.tagName + '.' + String(a.className || '').slice(0, 45) +
      ' w=' + Math.round(rect.width) + ' maxW=' + cs.maxWidth + ' disp=' + cs.display + ' gtc=' + cs.gridTemplateColumns.slice(0, 40));
    a = a.parentElement;
  }
  // 正文容器
  const art = document.querySelector('article');
  const main = document.querySelector('main');
  return {
    chain,
    art: art ? art.tagName + '.' + String(art.className).slice(0, 50) + ' w=' + Math.round(art.getBoundingClientRect().width) : null,
    main: main ? main.tagName + '.' + String(main.className).slice(0, 50) + ' w=' + Math.round(main.getBoundingClientRect().width) + ' maxW=' + getComputedStyle(main).maxWidth : null,
  };
});
console.log(JSON.stringify(r, null, 1));
await b.close();
