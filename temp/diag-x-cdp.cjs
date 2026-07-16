const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');

const TARGET_URL = 'http://localhost:8787/translate/x.com/NousResearch/status/2077517414464410091';
const OUT_DIR = '/Users/saga/code-repos/vocal-saga/temp';
const CDP_PORT = 9222;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: CDP_PORT, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;

    ws.on('open', () => {
      const client = {
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        on(event, handler) {
          ws.on(event, handler);
        },
        close() {
          ws.close();
        },
      };
      resolve(client);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });

    ws.on('error', reject);
  });
}

async function main() {
  const targets = await fetchJson('/json/list');
  const target = targets.find((t) => t.url.includes('translate/x.com/NousResearch') || t.url.includes('chromewebdata'));
  if (!target) {
    console.error('Target not found');
    console.log(JSON.stringify(targets.map((t) => ({ url: t.url, id: t.id })), null, 2));
    process.exit(1);
  }

  const client = await connectWs(target.webSocketDebuggerUrl);

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');

  // 导航到目标 URL
  console.log('Navigating to', TARGET_URL);
  await client.send('Page.navigate', { url: TARGET_URL });

  // 等待加载完成
  let loaded = false;
  client.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Page.loadEventFired') loaded = true;
  });

  // 最多等 30s
  for (let i = 0; i < 60; i++) {
    if (loaded) break;
    await sleep(500);
  }
  await sleep(2000); // 额外等渲染稳定

  // 截图
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT_DIR}/x-translate-screenshot.png`, Buffer.from(screenshot.data, 'base64'));
  console.log('Screenshot saved');

  // DOM outerHTML
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: false });
  const { nodeId: htmlNodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'html' });
  const html = await client.send('DOM.getOuterHTML', { nodeId: htmlNodeId });
  fs.writeFileSync(`${OUT_DIR}/x-translate-outer.html`, html.outerHTML);
  console.log('HTML saved, length:', html.outerHTML.length);

  // 统计
  const stats = await client.send('Runtime.evaluate', {
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
          primaryColumnText: primaryColumn ? (primaryColumn.textContent || '').slice(0, 800) : null,
        };
      })()
    `,
    returnByValue: true,
  });

  fs.writeFileSync(`${OUT_DIR}/x-translate-stats.json`, JSON.stringify(stats.result.value, null, 2));
  console.log('Stats:', JSON.stringify(stats.result.value, null, 2));

  // 第一个 cellInnerDiv 的 HTML
  const firstCell = await client.send('Runtime.evaluate', {
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
    console.log('First cell saved');
  }

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
