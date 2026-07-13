/**
 * urlFetcher.fetchPage 单测。
 *
 * 用 Node 内置 http 起一个本地服务器（无需联网），覆盖：
 *   - 正常 GET 拿到 html + Document
 *   - 重定向 finalUrl 更新
 *   - 4xx/5xx 抛错
 *   - 超时（AbortController）
 *   - 收到 html 后能用 querySelector 解析
 *
 * 不在 CF 跑（import jsdom 会因 MessagePort 失败），但单测在 Node 下能完整覆盖。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchPage } from '../lib/translate/urlFetcher';

let server: http.Server;
let baseUrl: string;
let lastHeaders: http.IncomingHttpHeaders | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/ok') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <h1 id="title">Hello</h1>
        <p class="msg">World</p>
      </body></html>`);
      return;
    }

    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/ok' });
      res.end();
      return;
    }

    if (url.pathname === '/404') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    if (url.pathname === '/slow') {
      // 不响应，让 fetchPage 撞 timeout
      return;
    }

    res.writeHead(418, { 'Content-Type': 'text/plain' });
    res.end("I'm a teapot");
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetchPage', () => {
  it('fetches HTML and returns a jsdom Document', async () => {
    const result = await fetchPage(`${baseUrl}/ok`);
    expect(result.status).toBe(200);
    expect(result.html).toContain('Hello');
    expect(result.doc).toBeTruthy();
    expect(result.doc.querySelector('#title')?.textContent).toBe('Hello');
    expect(result.doc.querySelector('.msg')?.textContent).toBe('World');
  });

  it('follows redirects and updates finalUrl', async () => {
    const result = await fetchPage(`${baseUrl}/redirect`);
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe(`${baseUrl}/ok`);
  });

  it('throws on 4xx', async () => {
    await expect(fetchPage(`${baseUrl}/404`)).rejects.toThrow(/HTTP 404/);
  });

  it('throws on 5xx / 4xx alike', async () => {
    await expect(fetchPage(`${baseUrl}/teapot`)).rejects.toThrow(/HTTP 418/);
  });

  it('aborts on timeout', async () => {
    await expect(
      fetchPage(`${baseUrl}/slow`, { timeoutMs: 200 })
    ).rejects.toThrow();
  }, 5_000);

  it('preserves requested url in result.url', async () => {
    const result = await fetchPage(`${baseUrl}/ok`);
    expect(result.url).toBe(`${baseUrl}/ok`);
  });

  it('sends browser-like Client Hints headers', async () => {
    await fetchPage(`${baseUrl}/ok`);
    expect(lastHeaders?.['sec-ch-ua']).toContain('Chromium');
    expect(lastHeaders?.['sec-ch-ua-mobile']).toBe('?0');
    expect(lastHeaders?.['sec-ch-ua-platform']).toBe('"macOS"');
  });
});
