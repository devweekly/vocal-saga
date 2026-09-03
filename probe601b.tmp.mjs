import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';

const base = readFileSync('/tmp/a601.html', 'utf8');

const variants = {
  A_asis: base,
  B_no_embedded_data: base.replace(
    /<script\b[^>]*data-target="react-partial\.embeddedData"[^>]*>[\s\S]*?<\/script>/gi, ''),
  C_no_ghassets_js: base.replace(
    /<script\b[^>]*\bsrc="[^"]*githubassets\.com\/assets\/[^"]*\.js"[^>]*><\/script>/gi, ''),
  D_no_embedded_and_modules: base
    .replace(/<script\b[^>]*data-target="react-partial\.embeddedData"[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\btype="module"[^>]*>[\s\S]*?<\/script>/gi, ''),
};

const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
for (const [name, html] of Object.entries(variants)) {
  const file = `/tmp/v-${name}.html`;
  writeFileSync(file, html);
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await ctx.newPage();
  await p.goto('file://' + file, { waitUntil: 'load', timeout: 90000 }).catch(() => {});
  await p.waitForTimeout(3000);
  const r = await p.evaluate(() => ({
    tr: document.querySelectorAll('.fanyi-translation').length,
    art: (document.querySelector('article.markdown-body')?.textContent || '').trim().slice(0, 60),
  }));
  console.log(name.padEnd(28), JSON.stringify(r));
  await ctx.close();
}
await b.close();
