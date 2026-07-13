import { chromium } from 'playwright';
import fs from 'fs';

const browser = await chromium.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});

async function diagnose(url: string, label: string) {
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', (msg) => console.log(`[${label}] console.${msg.type()}: ${msg.text().slice(0, 200)}`));

  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => {
    console.log(`[${label}] goto failed: ${e.message}`);
    return null;
  });

  if (!resp) {
    await context.close();
    return { label, error: 'goto failed' };
  }

  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const body = document.body;
    const result: any = {
      url: location.href,
      title: document.title,
      bodyTextLength: body ? body.innerText.length : 0,
      chineseChars: (body?.innerText.match(/[\u4e00-\u9fa5]/g) || []).length,
      translations: document.querySelectorAll('.fanyi-translation, .fanyi-inline-translation').length,
      styleSheets: document.styleSheets.length,
      inlineStyles: document.querySelectorAll('style').length,
      bodyFontFamily: getComputedStyle(body || document.documentElement).fontFamily,
    };

    // 查找可能的 cookie 弹窗
    const cookieSelectors = [
      '[data-fanyi-remove="true"]',
      '[class*="cookie" i]', '[id*="cookie" i]',
      '[class*="consent" i]', '[id*="consent" i]',
      '[class*="gdpr" i]', '[id*="gdpr" i]',
      '[class*="onetrust" i]', '[id*="onetrust" i]',
      '[class*="cmp" i]', '[id*="cmp" i]',
      '[class*="privacy" i]', '[id*="privacy" i]',
      '[class*="accept" i]', '[id*="accept" i]',
      '[class*="banner" i]', '[id*="banner" i]',
      '[role="dialog"]', 'dialog',
    ];

    const candidates: any[] = [];
    const seen = new Set<Element>();
    cookieSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const text = el.textContent?.slice(0, 80) || '';
        candidates.push({
          tag: el.tagName,
          class: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
          id: (el as HTMLElement).id?.slice(0, 40) || '',
          text: text,
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          position: cs.position,
          zIndex: cs.zIndex,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          dataRemove: el.getAttribute('data-fanyi-remove'),
        });
      });
    });

    // 找出可见的候选（可能是弹窗）
    result.visibleCookieCandidates = candidates
      .filter((c) => c.rect.width > 50 && c.rect.height > 50 && c.display !== 'none' && c.visibility !== 'hidden')
      .slice(0, 10);

    // 所有候选简要
    result.allCandidates = candidates.slice(0, 15).map((c) => ({
      tag: c.tag,
      class: c.class,
      id: c.id,
      text: c.text,
      display: c.display,
      position: c.position,
      zIndex: c.zIndex,
      rect: c.rect,
      dataRemove: c.dataRemove,
    }));

    // 检查头部样式
    const fanyiStyle = Array.from(document.querySelectorAll('style')).find((s) => s.textContent?.includes('data-fanyi-remove'));
    result.hasFanyiCss = !!fanyiStyle;

    // 检查 link css 加载情况
    const cssLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    result.cssLinks = cssLinks.slice(0, 5).map((l) => (l as HTMLLinkElement).href);

    // 检查 body 是否有异常 display
    result.bodyDisplay = getComputedStyle(body || document.documentElement).display;

    return result;
  }).catch((e) => ({ error: e.message }));

  await page.screenshot({ path: `/tmp/diag-${label}.png`, fullPage: false }).catch(() => {});
  console.log(`[${label}] 截图: /tmp/diag-${label}.png`);

  await context.close();
  return { label, info };
}

console.log('=== article/343 ===');
const r343 = await diagnose('https://s.sunxiunan.com/article/343', '343');
console.log(JSON.stringify(r343, null, 2));

console.log('\n=== article/332 ===');
const r332 = await diagnose('https://s.sunxiunan.com/article/332', '332');
console.log(JSON.stringify(r332, null, 2));

fs.writeFileSync('/tmp/diag-cookie-css.json', JSON.stringify({ r343, r332 }, null, 2));
console.log('\n结果已保存到 /tmp/diag-cookie-css.json');

await browser.close();
