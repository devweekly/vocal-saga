import { chromium } from 'playwright';
import fs from 'fs';

// 导入新的 pipeline 函数
const { stripDangerousScripts } = await import('../lib/spaGuard');
const { injectRedirectGuard } = await import('../lib/redirectGuard');
const { devirtualizeLayout } = await import('../lib/devirtualize');

const browser = await chromium.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});

async function checkPage(url: string, label: string) {
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleMsgs: any[] = [];
  const navigations: any[] = [];

  page.on('console', (msg) => consoleMsgs.push({ type: msg.type(), text: msg.text() }));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push({ url: frame.url() });
  });

  // 拦截响应，应用完整的翻译 pipeline（与 app.ts 一致）
  await page.route(url, async (route) => {
    const resp = await route.fetch();
    let body = await resp.text();
    // 与 app.ts processTranslationHtml 一致
    body = injectRedirectGuard(devirtualizeLayout(stripDangerousScripts(body)));
    const headers = {};
    const ct = resp.headers()['content-type'];
    if (ct) (headers as any)['content-type'] = ct;
    await route.fulfill({ status: resp.status(), headers, body });
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (e) {
    console.log(`  [${label}] goto: ${(e as Error).message.slice(0, 100)}`);
  }

  const state1 = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const chineseChars = (bodyText.match(/[\u4e00-\u9fa5]/g) || []).length;
    const translations = document.querySelectorAll('.fanyi-translation, .fanyi-inline-translation').length;
    // 检查 virtual 定位是否被移除
    const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
    const cellPositions: string[] = [];
    cells.forEach((c, i) => {
      if (i < 3) {
        const cs = getComputedStyle(c);
        cellPositions.push(`${cs.position}/${cs.transform.slice(0, 30)}`);
      }
    });
    return { chineseChars, translations, cellCount: cells.length, cellPositions };
  }).catch(() => ({ error: 'eval failed' }));
  console.log(`  [${label}] State1:`, JSON.stringify(state1));

  await page.waitForTimeout(8000).catch(() => {});

  const state2 = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const chineseChars = (bodyText.match(/[\u4e00-\u9fa5]/g) || []).length;
    const translations = document.querySelectorAll('.fanyi-translation, .fanyi-inline-translation').length;
    return { chineseChars, translations, bodyHeight: document.body?.scrollHeight };
  }).catch(() => ({ error: 'eval failed (navigated)' }));
  console.log(`  [${label}] State2:`, JSON.stringify(state2));

  const errors = consoleMsgs.filter((m) => m.type === 'error');
  const guardMsgs = consoleMsgs.filter((m) => m.text.includes('[vocal-saga]') || m.text.includes('[devirtualize]'));

  await page.screenshot({ path: `/tmp/final-${label}.png`, fullPage: false }).catch(() => {});
  await context.close();

  return {
    label,
    navigations: navigations.length,
    state1: state1 as any,
    state2: state2 as any,
    errorCount: errors.length,
    guardMsgs: guardMsgs.slice(0, 5).map((m) => m.text.slice(0, 150)),
  };
}

console.log('=== 最终验证 article/301 (X/Twitter) ===\n');
const r301 = await checkPage('https://s.sunxiunan.com/article/301', '301');

console.log('\n=== 最终验证 article/281 (Next.js) ===\n');
const r281 = await checkPage('https://s.sunxiunan.com/article/281', '281');

console.log('\n=== 结果汇总 ===\n');
console.log('                    article/301 (X/Twitter)    article/281 (Next.js)');
console.log(`  Navigations:      ${r301.navigations}                              ${r281.navigations}`);
console.log(`  State1 chars:     ${r301.state1.chineseChars}                              ${r281.state1.chineseChars}`);
console.log(`  State2 chars:     ${r301.state2.chineseChars ?? r301.state2.error}                              ${r281.state2.chineseChars ?? r281.state2.error}`);
console.log(`  State1 trans:     ${r301.state1.translations}                               ${r281.state1.translations}`);
console.log(`  State2 trans:     ${r301.state2.translations ?? 0}                               ${r281.state2.translations ?? 0}`);
console.log(`  Errors:           ${r301.errorCount}                              ${r281.errorCount}`);

if (r301.state1.cellPositions) {
  console.log(`\narticle/301 cell positions:`);
  r301.state1.cellPositions.forEach((p: string, i: number) => console.log(`  cell ${i}: ${p}`));
}

console.log('\narticle/301 logs:');
r301.guardMsgs.forEach((m) => console.log('  ' + m));
console.log('\narticle/281 logs:');
r281.guardMsgs.forEach((m) => console.log('  ' + m));

fs.writeFileSync('/tmp/final-results.json', JSON.stringify({ r301, r281 }, null, 2));

await browser.close();
