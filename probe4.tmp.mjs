import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();
const failed = [];
p.on('requestfailed', (r) => failed.push(r.url().slice(0, 110) + ' :: ' + (r.failure()?.errorText || '')));
p.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url().slice(0, 110)); });
await p.goto('https://s.sunxiunan.com/article/579', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(3000);
const r = await p.evaluate(() => ({
  sheets: Array.from(document.styleSheets).map((s) => {
    let n = 0; try { n = s.cssRules.length; } catch { n = -1; }
    return (s.href || 'inline') + ' rules=' + n;
  }),
  links: Array.from(document.querySelectorAll('link[rel=stylesheet]')).map((l) => l.getAttribute('href')),
}));
console.log(JSON.stringify(r, null, 1));
console.log('--- failed/codes ---');
console.log(failed.slice(0, 25).join('\n'));
await b.close();
