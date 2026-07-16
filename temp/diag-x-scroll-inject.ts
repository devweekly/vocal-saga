import WebSocket from 'ws';
import * as fs from 'fs';
import * as http from 'http';

const ORIGIN_URL = 'https://x.com/deedydas/status/2076894544596177204';
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

  // 给每个 tweetText 注入一个模拟翻译节点
  const injectResult = await evaluate(client, `
    (() => {
      const tweetTexts = document.querySelectorAll('[data-testid="tweetText"]');
      let injected = 0;
      tweetTexts.forEach((el, idx) => {
        // 跳过已注入的
        if (el.querySelector('.fanyi-injected')) return;
        const translation = document.createElement('div');
        translation.className = 'fanyi-injected';
        translation.style.cssText = 'display:block; margin: 8px 0; padding: 4px 8px; border-left: 3px solid #1d9bf0; color: #1d9bf0; font-size: 14px;';
        translation.textContent = '【模拟译文】' + (idx + 1);
        el.appendChild(translation);
        injected++;
      });
      return { injected, total: tweetTexts.length };
    })()
  `);
  console.log('Injected translations:', injectResult.result.value);

  await sleep(500);
  await captureScreenshot(client, 'x-scroll-inject-initial');

  // 向下滚动
  await scrollBy(client, 2000);
  await sleep(1500);
  await captureScreenshot(client, 'x-scroll-inject-down1');

  // 再向下滚动
  await scrollBy(client, 2000);
  await sleep(1500);
  await captureScreenshot(client, 'x-scroll-inject-down2');

  // 向上滚动回到接近顶部
  await evaluate(client, `window.scrollTo({top: 0, behavior: 'instant'}); 'scrolled to top'`);
  await sleep(1500);
  await captureScreenshot(client, 'x-scroll-inject-back-top');

  // 统计注入节点数量
  const finalInfo = await evaluate(client, `
    (() => {
      const injected = document.querySelectorAll('.fanyi-injected');
      const tweetTexts = document.querySelectorAll('[data-testid="tweetText"]');
      return {
        injectedCount: injected.length,
        tweetTextCount: tweetTexts.length,
        scrollY: window.scrollY,
      };
    })()
  `);
  console.log('Final after scroll back to top:', finalInfo.result.value);

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
