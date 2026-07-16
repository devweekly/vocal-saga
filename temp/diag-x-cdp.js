const CDP = require('chrome-remote-interface');
const fs = require('fs');

const TARGET_URL = 'http://localhost:8787/translate/x.com/NousResearch/status/2077517414464410091';
const OUT_DIR = '/Users/saga/code-repos/vocal-saga/temp';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const targets = await CDP.List({ host: 'localhost', port: 9222 });
  const target = targets.find((t) => t.url === TARGET_URL || t.url.includes('translate/x.com/NousResearch'));
  if (!target) {
    console.error('Target not found');
    console.log(JSON.stringify(targets.map((t) => ({ url: t.url, id: t.id })), null, 2));
    process.exit(1);
  }

  const client = await CDP({ target: target.id, host: 'localhost', port: 9222 });
  const { Page, Runtime, DOM, DOMSnapshot } = client;

  await Page.enable();
  await Runtime.enable();
  await DOM.enable();

  // 等待页面稳定
  await sleep(3000);

  // 截图
  const screenshot = await Page.captureScreenshot({ format: 'png', fullPage: true });
  fs.writeFileSync(`${OUT_DIR}/x-translate-screenshot.png`, Buffer.from(screenshot.data, 'base64'));
  console.log('Screenshot saved');

  // 获取 document outerHTML
  const { root } = await DOM.getDocument({ depth: -1, pierce: false });
  const htmlNode = await DOM.querySelector({ nodeId: root.nodeId, selector: 'html' });
  const html = await DOM.getOuterHTML({ nodeId: htmlNode.nodeId });
  fs.writeFileSync(`${OUT_DIR}/x-translate-outer.html`, html.outerHTML);
  console.log('HTML saved, length:', html.outerHTML.length);

  // 提取关键 DOM 信息：主列、cellInnerDiv 数量、data-fanyi-block-id 数量、图片/视频数量
  const result = await Runtime.evaluate({
    expression: `
      (() => {
        const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
        const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
        const timeline = document.querySelector('[aria-label="Timeline"]');
        const translatedBlocks = document.querySelectorAll('[data-fanyi-block-id]');
        const images = document.querySelectorAll('img');
        const videos = document.querySelectorAll('video');
        const fanyiOriginals = document.querySelectorAll('.fanyi-original');
        const fanyiTranslations = document.querySelectorAll('.fanyi-translation');
        const removed = document.querySelectorAll('[data-fanyi-remove="true"]');
        const lowPriority = document.querySelectorAll('[data-fanyi-low-priority="true"]');
        return {
          url: location.href,
          title: document.title,
          cells: cells.length,
          primaryColumnExists: !!primaryColumn,
          timelineExists: !!timeline,
          translatedBlocks: translatedBlocks.length,
          images: images.length,
          videos: videos.length,
          fanyiOriginals: fanyiOriginals.length,
          fanyiTranslations: fanyiTranslations.length,
          removed: removed.length,
          lowPriority: lowPriority.length,
          bodyChildren: document.body.children.length,
          primaryColumnHtml: primaryColumn ? primaryColumn.outerHTML.slice(0, 5000) : null,
        };
      })()
    `,
    returnByValue: true,
  });

  fs.writeFileSync(`${OUT_DIR}/x-translate-stats.json`, JSON.stringify(result.result.value, null, 2));
  console.log('Stats:', JSON.stringify(result.result.value, null, 2));

  // 抓取第一个 cellInnerDiv 的完整 HTML 用于分析重复图片
  const firstCell = await Runtime.evaluate({
    expression: `
      (() => {
        const cell = document.querySelector('[data-testid="cellInnerDiv"]');
        return cell ? cell.outerHTML : null;
      })()
    `,
    returnByValue: true,
  });
  if (firstCell.result.value) {
    fs.writeFileSync(`${OUT_DIR}/x-translate-first-cell.html`, firstCell.result.value);
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
