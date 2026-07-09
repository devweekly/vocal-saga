import { chromium } from 'playwright';
import fs from 'fs';

const { stripDangerousScripts } = await import('./lib/spaGuard');
const { injectRedirectGuard } = await import('./lib/redirectGuard');

const browser = await chromium.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});

const page = await browser.newPage();

await page.route('https://s.sunxiunan.com/article/301', async (route) => {
  const resp = await route.fetch();
  let body = await resp.text();
  body = stripDangerousScripts(injectRedirectGuard(body));

  // 精准 devirtualize：只改 cellInnerDiv 及其子元素
  const devirtualizeScript = `<script>
(function() {
  function devirtualize() {
    var count = 0;
    // 只处理 cellInnerDiv 及其祖先链中的 absolute 元素
    var cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
    cells.forEach(function(cell) {
      // 向上遍历祖先，把 absolute 改 static
      var el = cell;
      while (el && el !== document.body) {
        var cs = window.getComputedStyle(el);
        if (cs.position === 'absolute' || cs.position === 'fixed') {
          el.style.position = 'static';
          el.style.transform = '';
          el.style.top = '';
          el.style.left = '';
          count++;
        }
        el = el.parentElement;
      }
      // cell 自己也改
      var cellCs = window.getComputedStyle(cell);
      if (cellCs.position === 'absolute' || cellCs.position === 'fixed') {
        cell.style.position = 'static';
        cell.style.transform = '';
        cell.style.top = '';
        cell.style.left = '';
        count++;
      }
    });

    // 也处理带 translateY 的元素（virtual scroll items）
    document.querySelectorAll('[style*="translate"]').forEach(function(el) {
      var s = el.style;
      if (s.transform && s.transform.indexOf('translate') !== -1) {
        s.transform = '';
        if (window.getComputedStyle(el).position === 'absolute') {
          s.position = 'static';
          s.top = '';
          s.left = '';
        }
        count++;
      }
    });

    // 移除 Timeline 容器的固定高度和 overflow
    var timeline = document.querySelector('[aria-label="Timeline"]');
    if (timeline) {
      timeline.style.height = '';
      timeline.style.maxHeight = '';
      timeline.style.overflow = 'visible';
      var parent = timeline.parentElement;
      while (parent && parent !== document.body) {
        var ps = parent.style;
        if (ps.height || ps.maxHeight) {
          ps.height = '';
          ps.maxHeight = '';
        }
        if (window.getComputedStyle(parent).overflow !== 'visible') {
          ps.overflow = 'visible';
        }
        parent = parent.parentElement;
      }
    }

    console.log('[devirtualize] 修改了 ' + count + ' 个元素');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', devirtualize);
  } else {
    devirtualize();
  }
})();
</script>`;
  body = body.replace('</body>', devirtualizeScript + '</body>');
  if (!body.includes(devirtualizeScript)) {
    body = devirtualizeScript + body;
  }

  const headers = {};
  const ct = resp.headers()['content-type'];
  if (ct) (headers as any)['content-type'] = ct;
  await route.fulfill({ status: resp.status(), headers, body });
});

await page.goto('https://s.sunxiunan.com/article/301', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
await page.waitForTimeout(3000);

// 检查可见性
const state = await page.evaluate(() => {
  const body = document.body;
  const bodyText = body ? body.innerText : '';
  const chineseChars = (bodyText.match(/[\u4e00-\u9fa5]/g) || []).length;
  const translations = document.querySelectorAll('.fanyi-translation, .fanyi-inline-translation').length;

  // 检查是否有遮挡层
  const overlays = Array.from(document.querySelectorAll('*')).filter(el => {
    const cs = getComputedStyle(el);
    return cs.position === 'fixed' &&
           cs.zIndex !== 'auto' &&
           parseInt(cs.zIndex) > 100 &&
           cs.display !== 'none' &&
           cs.visibility !== 'hidden';
  }).map(el => ({
    tag: el.tagName,
    class: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
    zIndex: getComputedStyle(el).zIndex,
    bg: getComputedStyle(el).backgroundColor,
  })).slice(0, 5);

  // 检查 body 可见性
  const bodyCs = getComputedStyle(body);
  const bodyInfo = {
    display: bodyCs.display,
    visibility: bodyCs.visibility,
    opacity: bodyCs.opacity,
    overflow: bodyCs.overflow,
    scrollHeight: body.scrollHeight,
    clientHeight: body.clientHeight,
  };

  // 检查第一个可见的文本元素
  const firstVisible = Array.from(document.querySelectorAll('p, span, div')).find(el => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return cs.display !== 'none' &&
           cs.visibility !== 'hidden' &&
           cs.opacity !== '0' &&
           rect.width > 0 &&
           rect.height > 0 &&
           el.innerText.trim().length > 20;
  });

  return {
    chineseChars,
    translations,
    overlays,
    bodyInfo,
    firstVisibleText: firstVisible ? firstVisible.innerText.slice(0, 100) : '(none)',
    viewportHeight: window.innerHeight,
  };
}).catch((e) => ({ error: e.message }));

console.log(JSON.stringify(state, null, 2));

await page.screenshot({ path: '/tmp/poc-devirtualize2.png', fullPage: false });
console.log('截图: /tmp/poc-devirtualize2.png');
console.log('浏览器保持打开，你可以查看页面。');

// 保持打开
await page.waitForTimeout(600000);
