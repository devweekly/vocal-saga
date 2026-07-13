import { chromium } from 'playwright';

const { stripDangerousScripts } = await import('../lib/spaGuard');
const { injectRedirectGuard } = await import('../lib/redirectGuard');

const browser = await chromium.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});

const page = await browser.newPage();

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
await page.waitForTimeout(3000);

// 检查 tweet 元素的 inline style
const diag = await page.evaluate(() => {
  const tweets = document.querySelectorAll('[data-testid="tweet"]');
  const tweetStyles: string[] = [];
  tweets.forEach((t, i) => {
    if (i < 5) {
      const cs = getComputedStyle(t);
      const parent = t.parentElement;
      const parentStyle = parent ? getComputedStyle(parent) : null;
      tweetStyles.push({
        index: i,
        inlineStyle: t.getAttribute('style') || '(none)',
        computedPosition: cs.position,
        computedTransform: cs.transform,
        computedTop: cs.top,
        parentTag: parent?.tagName,
        parentInlineStyle: parent?.getAttribute('style') || '(none)',
        parentComputedPosition: parentStyle?.position,
        parentComputedTransform: parentStyle?.transform,
      });
    }
  });

  // 检查所有 position:absolute 的元素
  const absoluteEls: string[] = [];
  document.querySelectorAll('[style]').forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.position === 'absolute') {
      const testid = el.getAttribute('data-testid') || '';
      const cls = el.className || '';
      absoluteEls.push({
        tag: el.tagName,
        testid,
        class: typeof cls === 'string' ? cls.slice(0, 80) : '',
        style: (el.getAttribute('style') || '').slice(0, 150),
        transform: cs.transform.slice(0, 80),
        top: cs.top,
      });
    }
  });

  // 检查 Timeline 容器
  const timeline = document.querySelector('[aria-label="Timeline"]');
  const timelineInfo = timeline ? {
    tag: timeline.tagName,
    style: (timeline.getAttribute('style') || '').slice(0, 200),
    computedHeight: getComputedStyle(timeline).height,
    computedOverflow: getComputedStyle(timeline).overflow,
    computedPosition: getComputedStyle(timeline).position,
    childrenCount: timeline.children.length,
  } : null;

  // 检查 cellInnerDiv
  const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
  const cellStyles: string[] = [];
  cells.forEach((c, i) => {
    if (i < 5) {
      const cs = getComputedStyle(c);
      cellStyles.push({
        index: i,
        inlineStyle: (c.getAttribute('style') || '').slice(0, 150),
        position: cs.position,
        transform: cs.transform.slice(0, 80),
        top: cs.top,
      });
    }
  });

  return {
    tweetCount: tweets.length,
    tweetStyles,
    absoluteCount: absoluteEls.length,
    absoluteSample: absoluteEls.slice(0, 10),
    timeline: timelineInfo,
    cellCount: cells.length,
    cellStyles,
  };
}).catch((e) => ({ error: e.message }));

console.log(JSON.stringify(diag, null, 2));

// 实验验证：把一个 tweet 的 position 改成 static，看是否恢复
const experiment = await page.evaluate(() => {
  const allAbsolute = Array.from(document.querySelectorAll('[style]')).filter(el => 
    getComputedStyle(el).position === 'absolute'
  );
  if (allAbsolute.length === 0) return { found: 0, result: 'no absolute elements' };

  // 把前 10 个 absolute 元素改成 static
  let changed = 0;
  allAbsolute.slice(0, 10).forEach(el => {
    const htmlEl = el as HTMLElement;
    htmlEl.style.position = 'static';
    htmlEl.style.transform = '';
    htmlEl.style.top = '';
    htmlEl.style.left = '';
    changed++;
  });

  return { found: allAbsolute.length, changed, result: 'applied static to first 10' };
}).catch((e) => ({ error: e.message }));

console.log('\n=== 实验：把 absolute 改 static ===');
console.log(JSON.stringify(experiment, null, 2));

await page.screenshot({ path: '/tmp/devirtualize-experiment.png' }).catch(() => {});

await browser.close();
