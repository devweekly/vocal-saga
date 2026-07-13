import { chromium } from 'playwright';
import fs from 'fs';

const { stripDangerousScripts } = await import('../lib/spaGuard');
const { injectRedirectGuard } = await import('../lib/redirectGuard');

const browser = await chromium.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});

const page = await browser.newPage();

// 拦截响应，应用新两层 guard
await page.route('https://s.sunxiunan.com/article/301', async (route) => {
  const resp = await route.fetch();
  let body = await resp.text();
  body = stripDangerousScripts(injectRedirectGuard(body));
  const headers = {};
  const ct = resp.headers()['content-type'];
  if (ct) (headers as any)['content-type'] = ct;
  await route.fulfill({ status: resp.status(), headers, body });
});

await page.goto('https://s.sunxiunan.com/article/301', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

await page.waitForTimeout(5000);

// 用户建议的诊断
const diag = await page.evaluate(() => {
  return {
    // 检查是否还有 abs.twimg.com 脚本
    twimgScripts: document.querySelectorAll("script[src*='abs.twimg.com']").length,
    totalScripts: document.querySelectorAll('script').length,
    // CSS 检查
    styleSheetsCount: document.styleSheets.length,
    inlineStyles: document.querySelectorAll('style').length,
    bodyFontFamily: getComputedStyle(document.body).fontFamily,
    // DOM 重复检查
    tweetNodes: document.querySelectorAll("[data-testid='tweet']").length,
    // 检查所有 script src
    scriptSrcs: Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src') || '').slice(0, 20),
    // 检查重叠的元素
    bodyChildren: document.body.children.length,
    // 检查 fanyi 翻译节点
    fanyiTranslations: document.querySelectorAll('.fanyi-translation, .fanyi-inline-translation').length,
    // body HTML 长度
    bodyHtmlLength: document.body.innerHTML.length,
  };
}).catch((e) => ({ error: e.message }));

console.log('=== 诊断结果 ===\n');
console.log(JSON.stringify(diag, null, 2));

// 截图
await page.screenshot({ path: '/tmp/diag-301-visual.png', fullPage: false });

await browser.close();
