import WebSocket from 'ws';
import * as fs from 'fs';
import * as http from 'http';
import { devirtualizeLayout } from '../lib/devirtualize';
import { stripDangerousScripts } from '../lib/spaGuard';
import { prepareDocument } from '../lib/translate/contentHelper';
import { parseHTML } from 'linkedom';

const ORIGIN_URL = 'https://x.com/NousResearch/status/2077517414464410091';
const OUT_DIR = '/Users/saga/code-repos/vocal-saga/temp';
const CDP_PORT = 9222;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchJson(path: string): Promise<any[]> {
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

interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, handler: (data: Buffer) => void): void;
  close(): void;
}

function connectWs(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let id = 0;

    ws.on('open', () => {
      const client: CdpClient = {
        send(method: string, params: Record<string, unknown> = {}) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        on(event: string, handler: (data: Buffer) => void) {
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
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });

    ws.on('error', reject);
  });
}

function analyzeHtml(html: string, label: string) {
  const { document: doc } = parseHTML(html) as unknown as { document: Document };
  const cells = doc.querySelectorAll('[data-testid="cellInnerDiv"]');
  const primaryColumn = doc.querySelector('[data-testid="primaryColumn"]');
  const timeline = doc.querySelector('[aria-label="Timeline"]');
  const images = doc.querySelectorAll('img');
  const videos = doc.querySelectorAll('video');

  let virtualStyles = 0;
  doc.querySelectorAll('[style]').forEach((el) => {
    const style = el.getAttribute('style') || '';
    if (/position\s*:\s*(absolute|fixed)/i.test(style) || /translate/i.test(style)) {
      virtualStyles++;
    }
  });

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
  // 优先找已打开的 X 页面；否则连接任意顶层 page 标签页再导航
  let target = targets.find((t) => t.type === 'page' && !t.parentId && t.url.includes('x.com/NousResearch'));
  if (!target) {
    target = targets.find((t) => t.type === 'page' && !t.parentId);
  }
  if (!target) {
    console.error('No usable page target found');
    console.log(JSON.stringify(targets.map((t) => ({ url: t.url, id: t.id, type: t.type })), null, 2));
    process.exit(1);
  }

  const client = await connectWs(target.webSocketDebuggerUrl);

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');

  console.log('Navigating to', ORIGIN_URL);
  await client.send('Page.navigate', { url: ORIGIN_URL });

  let loaded = false;
  client.on('message', (data: Buffer) => {
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

  const stripped = stripDangerousScripts(rawHtml);
  fs.writeFileSync(`${OUT_DIR}/x-origin-stripped.html`, stripped);
  analyzeHtml(stripped, 'stripped');

  const devirtualized = devirtualizeLayout(stripped);
  fs.writeFileSync(`${OUT_DIR}/x-origin-devirtualized.html`, devirtualized);
  analyzeHtml(devirtualized, 'devirtualized');

  try {
    const { document: doc } = parseHTML(devirtualized) as unknown as { document: Document };
    const prep = prepareDocument(doc, ORIGIN_URL);
    fs.writeFileSync(`${OUT_DIR}/x-origin-prepared.html`, '<!doctype html>\n' + doc.documentElement.outerHTML);
    console.log('\n[prepareDocument] blocks:', prep.blocks.length, 'chunks:', prep.chunks.length, 'strategy:', prep.report.strategy, 'quality:', prep.report.extractionQuality);
    prep.blocks.slice(0, 10).forEach((b, i) => {
      console.log(`  [${i}] ${b.tag}: ${b.text.slice(0, 80).replace(/\n/g, ' ')}`);
    });
    analyzeHtml(doc.documentElement.outerHTML, 'prepared');
  } catch (err) {
    console.error('prepareDocument failed:', (err as Error).message);
  }

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
