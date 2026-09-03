import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();

// ── 585: x.com 宽度 ──
await p.goto('https://s.sunxiunan.com/article/585', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(2500);
const x = await p.evaluate(() => {
  const pick = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { sel, w: Math.round(r.width), maxW: cs.maxWidth, minW: cs.minWidth, display: cs.display };
  };
  const out = ['main', '[data-testid="primaryColumn"]', '[data-testid="sidebarColumn"]',
    '[aria-label="时间轴：帖子"]', 'article[data-testid="tweet"]', 'body'].map(pick).filter(Boolean);
  // 所有宽度 > 900 的容器
  const wide = Array.from(document.querySelectorAll('div,main,section'))
    .map((e) => ({ t: e.tagName + '.' + String(e.className || '').slice(0, 30), w: Math.round(e.getBoundingClientRect().width) }))
    .filter((o) => o.w > 700 && o.w < 1440).slice(0, 12);
  return { out, wide, docW: document.documentElement.scrollWidth };
});
console.log('=== 585', JSON.stringify(x, null, 1));

// ── 579: TDS 溢出 & 图片 ──
await p.goto('https://s.sunxiunan.com/article/579', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(2500);
const t = await p.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const imgs = Array.from(document.querySelectorAll('img')).map((e) => {
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), nat: e.naturalWidth, src: (e.getAttribute('src') || '').slice(0, 60) };
  }).filter((o) => o.w > vw * 0.8);
  const overflow = Array.from(document.querySelectorAll('*')).map((e) => {
    const r = e.getBoundingClientRect();
    return { t: e.tagName + '.' + String(e.className || '').slice(0, 40), right: Math.round(r.right), w: Math.round(r.width) };
  }).filter((o) => o.right > vw + 30).slice(0, 15);
  return { vw, docW: document.documentElement.scrollWidth, bigImgs: imgs, overflow };
});
console.log('=== 579', JSON.stringify(t, null, 1));
await b.close();
