import WebSocket from 'ws';
import * as fs from 'fs';
import * as http from 'http';

const TEST_URL = 'http://localhost:8787/x-deedydas-mock-translated.html';
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

async function captureScreenshot(client: CdpClient, name: string) {
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT_DIR}/${name}.png`, Buffer.from(screenshot.data, 'base64'));
  console.log('Screenshot saved:', `${OUT_DIR}/${name}.png`);
}

async function evaluate(client: CdpClient, expression: string): Promise<any> {
  return client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
}

async function scrollBy(client: CdpClient, y: number) {
  await evaluate(client, `window.scrollBy({top: ${y}, behavior: 'instant'}); 'scrolled'`);
}

async function getInfo(client: CdpClient) {
  const res = await evaluate(client, `
    (() => {
      const originals = document.querySelectorAll('.fanyi-original');
      const translations = document.querySelectorAll('.fanyi-translation');
      const translatedBlocks = document.querySelectorAll('[data-fanyi-block-id]');
      return {
        scrollY: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        fanyiOriginals: originals.length,
        fanyiTranslations: translations.length,
        translatedBlocks: translatedBlocks.length,
      };
    })()
  `);
  return res.result.value;
}

async function main() {
  const targets = await fetchJson('/json/list');
  const target = targets.find((t) => t.type === 'page' && !t.parentId);
  if (!target) {
    console.error('No usable page target found');
    process.exit(1);
  }

  const client = await connectWs(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  console.log('Navigating to', TEST_URL);
  await client.send('Page.navigate', { url: TEST_URL });

  let loaded = false;
  client.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Page.loadEventFired') loaded = true;
  });

  for (let i = 0; i < 60; i++) {
    if (loaded) break;
    await sleep(500);
  }
  await sleep(2000);

  await captureScreenshot(client, 'x-mock-initial');
  console.log('Initial:', await getInfo(client));

  await scrollBy(client, 2000);
  await sleep(1000);
  await captureScreenshot(client, 'x-mock-down1');
  console.log('Down 2000:', await getInfo(client));

  await scrollBy(client, 2000);
  await sleep(1000);
  await captureScreenshot(client, 'x-mock-down2');
  console.log('Down 4000:', await getInfo(client));

  await evaluate(client, `window.scrollTo({top: 0, behavior: 'instant'}); 'top'`);
  await sleep(1000);
  await captureScreenshot(client, 'x-mock-back-top');
  console.log('Back top:', await getInfo(client));

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
