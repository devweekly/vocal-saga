import { chromium } from 'playwright';
const ids = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
for (const id of ids) {
  await p.goto(`https://s.sunxiunan.com/article/${id}`, { waitUntil: 'load', timeout: 90000 });
  await p.waitForTimeout(2500);
  const info = await p.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const tr = Array.from(document.querySelectorAll('.fanyi-translation'));
    const visible = tr.filter(vis).length;
    const hidden = tr.filter((e) => !vis(e)).slice(0, 4).map((e) => {
      const r = e.getBoundingClientRect();
      let anc = e; const chain = [];
      while (anc && chain.length < 6) {
        const cs = getComputedStyle(anc);
        chain.push(anc.tagName + '.' + String(anc.className || '').slice(0, 40) +
          '{d=' + cs.display + ',o=' + cs.overflow + ',h=' + Math.round(anc.getBoundingClientRect().height) + '}');
        anc = anc.parentElement;
      }
      return { text: (e.textContent || '').trim().slice(0, 30), rect: [Math.round(r.width), Math.round(r.height)], chain };
    });
    return { total: tr.length, visible, hidden, docW: document.documentElement.scrollWidth, winW: window.innerWidth };
  });
  console.log('=== ' + id + ' ' + JSON.stringify(info, null, 1));
  await p.screenshot({ path: '/tmp/shot-' + id + '.png', fullPage: false });
}
await b.close();
