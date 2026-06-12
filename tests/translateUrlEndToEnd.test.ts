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
// 注意：vi.fn().mockImplementation() 必须接收 class / function / arrow function，
// vitest 4 不接受普通对象作为构造器。DeepSeek service 只用 .translate() 一个方法。
vi.mock('../lib/translate/service/deepseek', () => ({
  DeepSeekTranslationService: class {
    constructor(_apiKey: string) {}
    // service.translate(jsonContent, sourceLang, targetLang, glossary)
    // chunk.jsonContent 是 string (JSON-stringified [{id,text}, ...])，
    // 真实 service 返回 JSON 字符串 [{id, translated_text}, ...]，pipeline 用
    // processTranslationResult(JSON.parse(...)) 还原成 Map<id, text>。
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

beforeAll(async () => {
  // 模拟 Cloudflare Workers 环境：linkedom 解析 HTML 后 injectGlobalWindow 仅在
  // Node 模式下注入 globalThis.window。CF Workers 没有 Node 全局，window 永远
  // undefined，必须保证 walker / rules / pipeline 在这种情况下也不 throw。
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;

  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('translateUrl — end-to-end with linkedom', () => {
  it('fetches, extracts, translates, and returns bilingual HTML', async () => {
    const result = await translateUrl({
      url: `${baseUrl}/`,
      apiKey: 'sk-test-dummy',
    });

    expect(result.html).toContain('Graph abstractions at Netflix');
    expect(result.html).toContain('[zh]');
    // 双语回填：原始段落应被 .fanyi-translation 包裹
    expect(result.html).toContain('fanyi-translation');
    // script 标签已被移除
    expect(result.html).not.toContain('alert(');
    // 注入了双语显示用的 style
    expect(result.html).toContain('fanyi-bilingual-styles');
    expect(result.blocks).toBeGreaterThan(0);
    expect(result.chunks).toBeGreaterThan(0);
  }, 10_000);

  it('does not throw when window is undefined (CF Workers env)', async () => {
    // 这条用例专门防回归：在没有 globalThis.window 的环境（CF Workers / 严格
    // 隔离的 node）下走完整条链路，验证 getSiteRule 等所有"读 window"路径
    // 都有兜底，不会再 "Cannot read properties of undefined (reading 'href')"。
    const savedWindow = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
    try {
      const result = await translateUrl({ url: `${baseUrl}/`, apiKey: 'sk-test-dummy' });
      expect(result.html).toContain('Graph abstractions at Netflix');
    } finally {
      if (savedWindow !== undefined) (globalThis as { window: unknown }).window = savedWindow;
    }
  }, 10_000);
});
