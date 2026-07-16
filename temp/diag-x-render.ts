import WebSocket from 'ws';
import * as fs from 'fs';
import * as http from 'http';
import { devirtualizeLayout } from '../lib/devirtualize';
import { stripDangerousScripts } from '../lib/spaGuard';
import { prepareDocument, type TextBlock } from '../lib/translate/contentHelper';
import { parseHTML } from 'linkedom';
import { applyBlockTranslation, applyInlineTranslation } from '../lib/translate/translationDisplay';

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

function mockTranslate(blocks: TextBlock[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of blocks) {
    // 模拟中文翻译，保留部分原文特征便于定位
    map.set(b.id, `【译文】${b.text.slice(0, 60)}`);
  }
  return map;
}

function injectBilingualStyles(doc: Document) {
  const head = doc.head;
  if (!head || head.querySelector('#fanyi-bilingual-styles')) return;
  const style = doc.createElement('style');
  style.id = 'fanyi-bilingual-styles';
  style.textContent = `
    .fanyi-translation {
      display: block;
      margin: 0.2em 0 0.4em 0;
      padding: 0.15em 0.6em;
      border-left: 3px solid currentColor;
    }
    .fanyi-inline-translation {
      opacity: 0.75;
      font-size: 0.9em;
      margin-left: 0.3em;
      white-space: normal;
    }
    [data-fanyi-low-priority="true"] {
      opacity: 0.35;
      filter: grayscale(60%);
    }
    [data-fanyi-remove="true"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  head.appendChild(style);
}

async function buildMockTranslatedHtml(): Promise<string> {
  const rawHtml = fs.readFileSync(`${OUT_DIR}/x-origin-raw.html`, 'utf-8');
  const stripped = stripDangerousScripts(rawHtml);
  const devirtualized = devirtualizeLayout(stripped);

  const { document: doc } = parseHTML(devirtualized) as unknown as { document: Document };
  doc.documentElement.setAttribute('baseURI', ORIGIN_URL);

  const prep = prepareDocument(doc, ORIGIN_URL);
  console.log(`[prepareDocument] blocks=${prep.blocks.length}, chunks=${prep.chunks.length}, strategy=${prep.report.strategy}`);

  const translations = mockTranslate(prep.blocks);

  const blockMap = new Map<string, Element>();
  doc.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
    const id = el.getAttribute('data-fanyi-block-id');
    if (id) blockMap.set(id, el);
  });

  for (const block of prep.blocks) {
    const translated = translations.get(block.id);
    if (!translated) continue;
    const el = blockMap.get(block.id);
    if (!el || el.nodeType !== 1) continue;
    const htmlEl = el as unknown as HTMLElement;
    const shouldInline =
      block.renderHint?.inlineCandidate === true &&
      translated.length <= 40 &&
      translated.split(/\s+/).length <= 12;
    if (shouldInline) {
      applyInlineTranslation(htmlEl, translated, 'bilingual');
    } else {
      applyBlockTranslation(htmlEl, translated, 'bilingual');
    }
  }

  injectBilingualStyles(doc);

  // 注入 base 标签
  const cleanUrl = ORIGIN_URL.split('?')[0].split('#')[0];
  const baseUrl = cleanUrl.endsWith('/') ? cleanUrl : cleanUrl + '/';
  const existingBase = doc.querySelector('head > base');
  if (existingBase) {
    existingBase.setAttribute('href', baseUrl);
  } else {
    const base = doc.createElement('base');
    base.setAttribute('href', baseUrl);
    const h = doc.head;
    if (h) h.insertBefore(base, h.firstChild);
  }

  const html = '<!doctype html>\n' + doc.documentElement.outerHTML;
  const outPath = `${OUT_DIR}/x-translate-mock.html`;
  fs.writeFileSync(outPath, html);
  console.log('Mock translated HTML saved:', outPath, `(${html.length} bytes)`);
  return outPath;
}

async function main() {
  const outPath = await buildMockTranslatedHtml();
  const fileUrl = 'file://' + outPath;

  const targets = await fetchJson('/json/list');
  // 找一个普通 page 标签页连接，避免连到 iframe/worker
  const target = targets.find((t) => t.type === 'page' && !t.parentId);
  if (!target) {
    console.error('No usable page target found');
    process.exit(1);
  }

  const client = await connectWs(target.webSocketDebuggerUrl);
  await client.send('Page.enable');

  console.log('Opening mock translated page:', fileUrl);
  await client.send('Page.navigate', { url: fileUrl });

  let loaded = false;
  client.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Page.loadEventFired') loaded = true;
  });

  for (let i = 0; i < 60; i++) {
    if (loaded) break;
    await sleep(500);
  }
  await sleep(2000); // 等待图片/字体加载

  const screenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(`${OUT_DIR}/x-translate-mock-screenshot.png`, Buffer.from(screenshot.data, 'base64'));
  console.log('Mock translated screenshot saved:', `${OUT_DIR}/x-translate-mock-screenshot.png`);

  // 同时截一张固定 viewport 的图便于对比
  const viewportScreenshot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT_DIR}/x-translate-mock-viewport.png`, Buffer.from(viewportScreenshot.data, 'base64'));
  console.log('Mock translated viewport screenshot saved:', `${OUT_DIR}/x-translate-mock-viewport.png`);

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
