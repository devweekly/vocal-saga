import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();

const X_CSS = `
[data-testid="primaryColumn"]{max-width:980px!important;min-width:0!important;flex-grow:1!important}
main[role="main"]{justify-content:center!important}
`;
const IMG_CSS = `
img,video,iframe,picture,figure,table{max-width:100%!important}
img,video{height:auto!important}
`;

async function measure(url, css, label) {
  await p.goto(url, { waitUntil: 'load', timeout: 90000 });
  await p.waitForTimeout(2200);
  if (css) await p.addStyleTag({ content: css });
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const pc = document.querySelector('[data-testid="primaryColumn"]');
    const bigs = Array.from(document.querySelectorAll('img,video,iframe'))
      .filter((e) => e.getBoundingClientRect().width > vw * 0.95).length;
    return {
      docW: document.documentElement.scrollWidth, vw,
      primaryColumn: pc ? Math.round(pc.getBoundingClientRect().width) : null,
      oversizedMedia: bigs,
    };
  });
  console.log(label.padEnd(22), JSON.stringify(r));
}

await measure('https://s.sunxiunan.com/article/585', null, '585 before');
await measure('https://s.sunxiunan.com/article/585', X_CSS, '585 +X css');
await measure('https://s.sunxiunan.com/article/579', null, '579 before');
await measure('https://s.sunxiunan.com/article/579', IMG_CSS, '579 +img css');
await measure('https://s.sunxiunan.com/article/588', null, '588 before');
await b.close();
