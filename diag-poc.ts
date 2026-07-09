import { chromium } from 'playwright';
import fs from 'fs';

const { stripDangerousScripts } = await import('./lib/spaGuard');
const { injectRedirectGuard } = await import('./lib/redirectGuard');

const browser = await chromium.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});

const page = await browser.newPage();

// 拦截响应，应用两层 guard + devirtualize
await page.route('https://s.sunxiunan.com/article/301', async (route) => {
  const resp = await route.fetch();
  let body = await resp.text();
  body = stripDangerousScripts(injectRedirectGuard(body));

  // POC: 在 HTML 中注入 devirtualize 脚本（服务端 DOM rewrite 的客户端等价物）
  const devirtualizeScript = `<script>
(function() {
  // 等待 DOM 解析完成
  function devirtualize() {
    // 把所有带 position:absolute 的元素改成 static，删除 transform/top/left
    var count = 0;
    document.querySelectorAll('[style]').forEach(function(el) {
      var cs = window.getComputedStyle(el);
      if (cs.position === 'absolute') {
        el.style.position = 'static';
        el.style.transform = '';
        el.style.top = '';
        el.style.left = '';
        el.style.height = '';
        el.style.width = el.style.width || '100%';
        count++;
      }
    });
    // 把带 transform 的元素也清理
    document.querySelectorAll('[style*="transform"]').forEach(function(el) {
      if (el.style.transform && el.style.transform !== 'none') {
        el.style.transform = '';
        count++;
      }
    });
    console.log('[devirtualize] 修改了 ' + count + ' 个元素');
  }
  // DOMContentLoaded 后执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', devirtualize);
  } else {
    devirtualize();
  }
})();
</script>`;
  // 注入到 </body> 前
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

// 等待 devirtualize 脚本执行
await page.waitForTimeout(3000);

// 收集状态
const state = await page.evaluate(() => {
  const body = document.body;
  const bodyText = body ? body.innerText : '';
  const chineseChars = (bodyText.match(/[\u4e00-\u9fa5]/g) || []).length;
  const translations = document.querySelectorAll('.fanyi-translation, .fanyi-inline-translation').length;
  const tweets = document.querySelectorAll('[data-testid="tweet"]').length;
  const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');

  // 检查 cellInnerDiv 现在的 position
  const cellPositions = [];
  cells.forEach((c, i) => {
    if (i < 5) {
      const cs = getComputedStyle(c);
      cellPositions.push({
        index: i,
        position: cs.position,
        transform: cs.transform.slice(0, 50),
        top: cs.top,
      });
    }
  });

  // 检查是否还有 absolute 元素
  let absoluteCount = 0;
  document.querySelectorAll('[style]').forEach(el => {
    if (getComputedStyle(el).position === 'absolute') absoluteCount++;
  });

  return {
    chineseChars,
    translations,
    tweets,
    cellCount: cells.length,
    cellPositions,
    absoluteCount,
    bodyHeight: document.body.scrollHeight,
  };
}).catch((e) => ({ error: e.message }));

console.log('=== POC Devirtualize 结果 ===\n');
console.log(JSON.stringify(state, null, 2));

// 截图
await page.screenshot({ path: '/tmp/poc-devirtualize.png', fullPage: false });
console.log('\n截图: /tmp/poc-devirtualize.png');
console.log('浏览器保持打开，你可以查看页面。按 Ctrl+C 关闭。');

// 保持浏览器打开
await page.waitForTimeout(600000);
