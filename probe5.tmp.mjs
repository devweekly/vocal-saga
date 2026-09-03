import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();

// 588: O'Reilly 右侧栏
await p.goto('https://s.sunxiunan.com/article/588', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(2500);
const r588 = await p.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const cands = Array.from(document.querySelectorAll('aside,div,section')).filter((e) => {
    const rect = e.getBoundingClientRect();
    return rect.width > 200 && rect.width < 600 && rect.left > vw * 0.55 && rect.height > 300 && getComputedStyle(e).display !== 'none';
  }).map((e) => ({
    t: e.tagName + '.' + String(e.className || '').slice(0, 60),
    id: e.id, l: Math.round(e.getBoundingClientRect().left), w: Math.round(e.getBoundingClientRect().width),
    h: Math.round(e.getBoundingClientRect().height),
    txt: (e.textContent || '').trim().slice(0, 60),
  }));
  return { vw, cands: cands.slice(0, 12) };
});
console.log('=== 588 sidebar candidates', JSON.stringify(r588, null, 1));

// 579: img 属性
await p.goto('https://s.sunxiunan.com/article/579', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(2000);
const r579 = await p.evaluate(() => {
  const big = Array.from(document.querySelectorAll('img')).filter((e) => e.getBoundingClientRect().width > 1500).slice(0, 3);
  return big.map((e) => ({ cls: String(e.className), w: e.getAttribute('width'), h: e.getAttribute('height'), srcset: !!e.getAttribute('srcset'), rect: Math.round(e.getBoundingClientRect().width) }));
});
console.log('=== 579 big imgs', JSON.stringify(r579, null, 1));
await b.close();
