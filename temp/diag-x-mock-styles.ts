import WebSocket from 'ws';
import * as http from 'http';

const TEST_URL = 'http://localhost:8787/x-deedydas-mock-translated.html';
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
  const target = targets.find((t) => t.type === 'page' && !t.parentId);
  if (!target) {
    console.error('No usable page target found');
    process.exit(1);
  }

  const client = await connectWs(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: TEST_URL });
  await sleep(3000);

  const res = await client.send('Runtime.evaluate', {
    expression: `
      (() => {
        const cells = Array.from(document.querySelectorAll('[data-testid="cellInnerDiv"]'));
        const first = cells.find((el) => el.getBoundingClientRect().top >= 0);
        if (!first) return 'no cell';
        const style = window.getComputedStyle(first);
        return {
          tag: first.tagName,
          classes: first.className,
          position: style.position,
          transform: style.transform,
          top: style.top,
          left: style.left,
          display: style.display,
          overflow: style.overflow,
          visibility: style.visibility,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(res.result.value, null, 2));

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
