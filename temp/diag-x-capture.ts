import WebSocket from 'ws';
import * as fs from 'fs';
import * as http from 'http';

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

async function main() {
  const targets = await fetchJson('/json/list');
  const target = targets.find((t) => t.type === 'page' && !t.parentId && t.url.includes('x.com/deedydas'));
  if (!target) {
    console.error('deedydas page not found');
    process.exit(1);
  }

  const client = await connectWs(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');

  // 等待页面稳定
  await sleep(2000);

  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT_DIR}/x-deedydas-initial.png`, Buffer.from(screenshot.data, 'base64'));

  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: false });
  const { nodeId: htmlNodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'html' });
  const htmlResult = await client.send('DOM.getOuterHTML', { nodeId: htmlNodeId });
  const rawHtml = htmlResult.outerHTML;
  fs.writeFileSync(`${OUT_DIR}/x-deedydas-raw.html`, rawHtml);
  console.log('Saved x-deedydas-raw.html length:', rawHtml.length);

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
