const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ORIGIN_URL = 'https://x.com/NousResearch/status/2077517414464410091';
const OUT_DIR = '/Users/saga/code-repos/vocal-saga/temp';
const CDP_PORT = 9222;

const { devirtualizeLayout } = require('../lib/dist/devirtualize');
const { stripDangerousScripts } = require('../lib/dist/spaGuard');
const { prepareDocument } = require('../lib/dist/translate/contentHelper');
const { parseHTML } = require('linkedom');

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

function analyzeHtml(html, label) {
  const { document: doc } = parseHTML(html);
  const cells = doc.querySelectorAll('[data-testid="cellInnerDiv"]');
  const primaryColumn = doc.querySelector('[data-testid="primaryColumn"]');
  const timeline = doc.querySelector('[aria-label="Timeline"]');
  const images = doc.querySelectorAll('img');
  const videos = doc.querySelectorAll('video');

  // 检查是否还有 virtual 定位残留
  let virtualStyles = 0;
  doc.querySelectorAll('[style]').forEach((el) => {
    const style = el.getAttribute('style') || '';
    if (/position\s*:\s*(absolute|fixed)/i.test(style) || /translate/i.test(style)) {
      virtualStyles++;
    }
  });

  // 检查 translated blocks（如果有）
  const translatedBlocks = doc.querySelectorAll('[data-fanyi-block-id]');
  const fanyiOriginals = doc.querySelectorAll('.fanyi-original');
  const fanyiTranslations = doc.querySelectorAll('.fanyi-translation');
  const removed = doc.querySelectorAll('[data-fanyi-remove="true"]');
  const lowPriority = doc.querySelectorAll('[data-fanyi-low-priority="true"]');

  console.log(`\n[${label}] Analysis:`);
  console.log('  cells:', cells.length);
  console.log('  primaryColumn:', !!primaryColumn);
  console.log('  timeline:', !!timeline);
  console.log('  images:', images.length);
  console.log('  videos:', videos.length);
  console.log('  virtual style residues:', virtualStyles);
  console.log('  translatedBlocks:', translatedBlocks.length);
  console.log('  fanyiOriginals:', fanyiOriginals.length);
  console.log('  fanyiTranslations:', fanyiTranslations.length);
  console.log('  removed:', removed.length);
  console.log('  lowPriority:', lowPriority.length);

  return {
    cells: cells.length,
    primaryColumn: !!primaryColumn,
    timeline: !!timeline,
    images: images.length,
    videos: videos.length,
    virtualStyles,
    translatedBlocks: translatedBlocks.length,
    fanyiOriginals: fanyiOriginals.length,
    fanyiTranslations: fanyiTranslations.length,
    removed: removed.length,
    lowPriority: lowPriority.length,
  };
}

async function main() {
  const targets = await fetchJson('/json/list');
  const target = targets.find((t) => t.url.includes('x.com/NousResearch') || t.url.includes('chromewebdata'));
  if (!target) {
    console.error('Target not found');
    console.log(JSON.stringify(targets.map((t) => ({ url: t.url, id: t.id })), null, 2));
    process.exit(1);
  }

  const client = await connectWs(target.webSocketDebuggerUrl);

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');

  console.log('Navigating to', ORIGIN_URL);
  await client.send('Page.navigate', { url: ORIGIN_URL });

  let loaded = false;
  client.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Page.loadEventFired') loaded = true;
  });

  for (let i = 0; i < 60; i++) {
    if (loaded) break;
    await sleep(500);
  }
  await sleep(3000);

  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT_DIR}/x-origin-screenshot.png`, Buffer.from(screenshot.data, 'base64'));
  console.log('Origin screenshot saved');

  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: false });
  const { nodeId: htmlNodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'html' });
  const htmlResult = await client.send('DOM.getOuterHTML', { nodeId: htmlNodeId });
  const rawHtml = htmlResult.outerHTML;
  fs.writeFileSync(`${OUT_DIR}/x-origin-raw.html`, rawHtml);
  console.log('Origin HTML saved, length:', rawHtml.length);

  analyzeHtml(rawHtml, 'raw origin');

  // 1. 仅 stripDangerousScripts
  const stripped = stripDangerousScripts(rawHtml);
  fs.writeFileSync(`${OUT_DIR}/x-origin-stripped.html`, stripped);
  analyzeHtml(stripped, 'stripped');

  // 2. strip + devirtualize
  const devirtualized = devirtualizeLayout(stripped);
  fs.writeFileSync(`${OUT_DIR}/x-origin-devirtualized.html`, devirtualized);
  const devStats = analyzeHtml(devirtualized, 'devirtualized');

  // 3. 准备翻译提取
  try {
    const { document: doc } = parseHTML(devirtualized);
    const prep = prepareDocument(doc, ORIGIN_URL);
    fs.writeFileSync(`${OUT_DIR}/x-origin-prepared.html`, '<!doctype html>\n' + doc.documentElement.outerHTML);
    console.log('\n[prepareDocument] blocks:', prep.blocks.length, 'chunks:', prep.chunks.length, 'strategy:', prep.report.strategy, 'quality:', prep.report.extractionQuality);
    prep.blocks.slice(0, 10).forEach((b, i) => {
      console.log(`  [${i}] ${b.tag}: ${b.text.slice(0, 80).replace(/\n/g, ' ')}`);
    });
    analyzeHtml(doc.documentElement.outerHTML, 'prepared');
  } catch (err) {
    console.error('prepareDocument failed:', err.message);
  }

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
