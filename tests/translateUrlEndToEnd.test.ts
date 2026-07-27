/**
 * pipeline.translateUrl 端到端单测。
 *
 * 这次是 linkedom 迁移后第一次真打通整条链路：
 *   1. urlFetcher.fetchPage → linkedom 解析 HTML（不在 vitest jsdom env 走）
 *   2. blockExtractor.extractBlocks → 递归 walk 抽块
 *   3. DeepSeek service mock → 返回翻译结果
 *   4. applyBlockTranslation → linkedom Document 写回 + 序列化
 *   5. 验证最终 HTML 含 .fanyi-translation 双语 span
 *
 * 之前是 jsdom；现在 urlFetcher 改 linkedom，这条用例是唯一覆盖真实生产路径的。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// mock 必须在被测模块 import 之前 —— mock 掉 DeepSeek service 的 HTTP 调用
vi.mock('../lib/translate/service/deepseek', () => ({
  DeepSeekTranslationService: class {
    async translate(jsonContent: string) {
      const blocks = JSON.parse(jsonContent) as Array<{ id: string; text: string }>;
      return JSON.stringify(
        blocks.map((b) => ({ id: b.id, translated_text: `${b.text} [zh]` })),
      );
    }
  },
}));

import { translateUrl } from '../lib/translate/pipeline';

let server: http.Server;
let baseUrl: string;

/** 本地 HTTP server，根据 path 返回不同 HTML */
function startServer(): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      switch (req.url) {
        case '/no-base':
          res.end(`<!doctype html>
<html>
  <head><title>No base</title></head>
  <body><p>Hello</p><img src="/relative.jpg"><script>void 0</script></body>
</html>`);
          break;
        case '/has-base':
          res.end(`<!doctype html>
<html>
  <head><base href="https://old-origin.com/"><title>Has base</title></head>
  <body><p>Hello</p></body>
</html>`);
          break;
        case '/base-no-href':
          res.end(`<!doctype html>
<html>
  <head><base target="_blank"><title>Base target only</title></head>
  <body><p>Hello</p></body>
</html>`);
          break;
        case '/base-after-css':
          // arxiv / ar5iv 真实结构：<base> 放在相对 CSS 之后，翻译后必须移到最前面
          res.end(`<!doctype html>
<html>
  <head>
    <title>Base after CSS</title>
    <link href="/static/style.css" rel="stylesheet" type="text/css">
    <base href="/old/">
  </head>
  <body><article><p>Hello from base after CSS</p></article></body>
</html>`);
          break;
        case '/article.html':
          res.end(`<!doctype html>
<html>
  <head><title>Article with extension</title><link rel="stylesheet" href="style.css"></head>
  <body><article><p>Hello from article</p></article></body>
</html>`);
          break;
        default:
          res.end(`<!doctype html>
<html>
  <head><title>Sample article</title></head>
  <body>
    <article>
      <h1>Graph abstractions at Netflix</h1>
      <p>This is a substantive paragraph that should be extracted as a translatable block by the walker.</p>
      <p>A second paragraph follows to verify the walker recurses into the article element correctly.</p>
    </article>
    <script>alert('xss')</script>
  </body>
</html>`);
      }
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      resolve({ server: srv, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function baseHref(html: string): string | null {
  const m = html.match(/<base\s[^>]*href="([^"]+)"/i);
  return m ? m[1] : null;
}

function baseTarget(html: string): string | null {
  const m = html.match(/<base\s[^>]*target="([^"]+)"/i);
  return m ? m[1] : null;
}

beforeAll(async () => {
  // 模拟 Cloudflare Workers 环境：linkedom 解析 HTML 后 injectGlobalWindow 仅在
  // Node 模式下注入 globalThis.window。CF Workers 没有 Node 全局，window 永远
  // undefined，必须保证 walker / rules / pipeline 在这种情况下也不 throw。
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;

  const result = await startServer();
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('translateUrl — end-to-end with linkedom', () => {
  it('fetches, extracts, translates, and returns bilingual HTML', async () => {
    const result = await translateUrl({
      url: `${baseUrl}/`,
    });

    expect(result.html).toContain('Graph abstractions at Netflix');
    expect(result.html).toContain('[zh]');
    // 双语回填：原始段落应被 .fanyi-translation 包裹
    expect(result.html).toContain('fanyi-translation');
    // script 全部保留（页面 CSS 变量依赖内联 JS）
    expect(result.html).toContain('<script>alert');
    // 注入了双语显示用的 style
    expect(result.html).toContain('fanyi-bilingual-styles');
    expect(result.blocks).toBeGreaterThan(0);
    expect(result.chunks).toBeGreaterThan(0);
  }, 10_000);

  it('injects <base href> when none exists', async () => {
      const result = await translateUrl({ url: `${baseUrl}/no-base` });
    // base href 为页面目录 URL（含路径）
    expect(baseHref(result.html)).toBe(`${baseUrl}/no-base/`);
  });

  it('updates existing <base href>', async () => {
    const result = await translateUrl({ url: `${baseUrl}/has-base` });
    expect(baseHref(result.html)).toBe(`${baseUrl}/has-base/`);
    expect(result.html).not.toContain('old-origin.com');
  });

  it('preserves <base target> when adding href', async () => {
    const result = await translateUrl({ url: `${baseUrl}/base-no-href` });
    expect(baseTarget(result.html)).toBe('_blank');
    expect(baseHref(result.html)).toBe(`${baseUrl}/base-no-href/`);
  });

  it('moves existing <base> to the start of <head> when it appears after relative CSS', async () => {
    const result = await translateUrl({ url: `${baseUrl}/base-after-css` });
    expect(baseHref(result.html)).toBe(`${baseUrl}/base-after-css/`);
    const headMatch = result.html.match(/<head[^>]*>[\s\S]*?<\/head>/i);
    expect(headMatch).toBeTruthy();
    const head = headMatch![0];
    const baseIndex = head.indexOf('<base');
    const linkIndex = head.indexOf('<link');
    expect(baseIndex).toBeGreaterThanOrEqual(0);
    expect(linkIndex).toBeGreaterThanOrEqual(0);
    expect(baseIndex).toBeLessThan(linkIndex);
  });

  it('uses parent directory for .html file URLs to fix relative CSS paths', async () => {
    const result = await translateUrl({ url: `${baseUrl}/article.html` });
    // .html 文件应视为文件而非目录，base 指向父目录，
    // 这样相对路径 style.css 会被解析为 /style.css 而不是 /article.html/style.css
    expect(baseHref(result.html)).toBe(`${baseUrl}/`);
  });

  it('does not throw when window is undefined (CF Workers env)', async () => {
    const savedWindow = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
    try {
      const result = await translateUrl({ url: `${baseUrl}/` });
      expect(result.html).toContain('Graph abstractions at Netflix');
    } finally {
      if (savedWindow !== undefined) (globalThis as { window: unknown }).window = savedWindow;
    }
  }, 10_000);
});
