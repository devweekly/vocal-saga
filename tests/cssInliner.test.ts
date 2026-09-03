/**
 * cssInliner 单测 —— 外联样式表内联化。
 *
 * 用本地 HTTP server 提供真实 CSS，验证：
 *   - 正常内联、相对路径解析、media 属性保留
 *   - 404 / HTML 兜底页 / 非 CSS content-type 一律跳过（保留原 <link>）
 *   - SSRF 校验：页面里的 <link href> 指向内网时被拦下
 *   - CSS 里的 </style 必须转义，否则会提前闭合标签
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { inlineExternalStylesheets } from '../lib/translate/cssInliner';
import { assertPublicUrl } from '../lib/urlUtils';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/app.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('.a{color:red}');
      return;
    }
    if (url === '/print.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('.p{color:blue}');
      return;
    }
    if (url === '/evil.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('.e{content:"</style><script>alert(1)</script>"}');
      return;
    }
    if (url === '/gone.css') {
      // 模拟原站发版后哈希文件 404（返回 HTML 错误页）
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html>Not Found</html>');
      return;
    }
    if (url === '/spa-fallback.css') {
      // SPA 兜底路由：任何路径都返回 200 + HTML
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html>app shell</html>');
      return;
    }
    if (url === '/octet.css') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('.o{}');
      return;
    }
    res.writeHead(404);
    res.end('');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

/** 本地测试用的 SSRF guard：放行本机测试端口，其余走公共规则 */
const localGuard = (url: string): void => {
  const u = new URL(url);
  if (u.hostname === '127.0.0.1' && u.port === new URL(base).port) return;
  assertPublicUrl(url);
};

const run = (html: string, overrides: Record<string, unknown> = {}) =>
  inlineExternalStylesheets(html, {
    baseUrl: base,
    ssrfGuard: localGuard,
    ...overrides,
  });

describe('inlineExternalStylesheets', () => {
  it('把外联样式表内联成 <style>，并移除原 <link>', async () => {
    const html = `<html><head><link rel="stylesheet" href="/app.css"></head><body><p class="a">x</p></body></html>`;
    const out = await run(html);
    expect(out).not.toContain('<link');
    expect(out).toContain('<style data-fanyi-inlined-css="' + base + '/app.css">');
    expect(out).toContain('.a{color:red}');
  });

  it('没有外联样式表时原样返回（不解析 DOM、不发请求）', async () => {
    const html = `<html><head><style>.a{}</style></head><body>x</body></html>`;
    const out = await run(html, {
      fetchFn: () => {
        throw new Error('should not fetch');
      },
    });
    expect(out).toBe(html);
  });

  it('保留 media 属性并用 @media 包裹，语义不变', async () => {
    const html = `<html><head><link rel="stylesheet" href="/print.css" media="print"></head><body>x</body></html>`;
    const out = await run(html);
    // 不断言属性顺序（linkedom 的输出顺序不保证）
    expect(out).toMatch(/<style\b[^>]*data-fanyi-inlined-css="[^"]*\/print\.css"[^>]*>/);
    expect(out).toMatch(/<style\b[^>]*media="print"[^>]*>/);
    expect(out).toContain('@media print{.p{color:blue}}');
  });

  it('media="all" / "screen" 不额外包裹', async () => {
    const html = `<html><head><link rel="stylesheet" href="/app.css" media="all"></head><body>x</body></html>`;
    const out = await run(html);
    expect(out).not.toContain('@media');
  });

  it('404 的样式表保留原 <link>（不内联、不删）', async () => {
    const html = `<html><head><link rel="stylesheet" href="/gone.css"></head><body>x</body></html>`;
    const out = await run(html, { onError: () => {} });
    expect(out).toContain('<link rel="stylesheet" href="/gone.css">');
    expect(out).not.toContain('Not Found');
  });

  it('200 但返回 HTML 的样式表（SPA 兜底路由）不内联', async () => {
    const html = `<html><head><link rel="stylesheet" href="/spa-fallback.css"></head><body>x</body></html>`;
    const out = await run(html, { onError: () => {} });
    expect(out).toContain('/spa-fallback.css');
    expect(out).not.toContain('app shell');
  });

  it('非 CSS content-type 不内联', async () => {
    const html = `<html><head><link rel="stylesheet" href="/octet.css"></head><body>x</body></html>`;
    const out = await run(html, { onError: () => {} });
    expect(out).toContain('/octet.css');
    expect(out).not.toContain('.o{}');
  });

  it('CSS 里的 </style 被转义，不会提前闭合标签', async () => {
    const html = `<html><head><link rel="stylesheet" href="/evil.css"></head><body><p>after</p></body></html>`;
    const out = await run(html);
    // 不能出现能闭合标签的字面序列
    expect(out).not.toContain('</style><script>');
    expect(out).toContain('<\\/style>');
    // 转义后结构仍然完整，body 内容没被吞
    expect(out).toContain('<p>after</p>');
  });

  it('超出单张字节上限时不内联', async () => {
    const html = `<html><head><link rel="stylesheet" href="/app.css"></head><body>x</body></html>`;
    const out = await run(html, { maxBytesPerSheet: 3, onError: () => {} });
    expect(out).toContain('/app.css"');
    expect(out).not.toContain('color:red');
  });

  it('超出总预算时停止内联后续样式表', async () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/app.css">
      <link rel="stylesheet" href="/print.css">
    </head><body>x</body></html>`;
    // 两张表各 12 字节：预算 15 只够放第一张，第二张整张跳过
    const out = await run(html, { maxBytesTotal: 15, onError: () => {} });
    expect(out).toContain('.a{color:red}');
    expect(out).not.toContain('.p{color:blue}');
  });

  it('超过 maxSheets 的样式表保留外链', async () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/app.css">
      <link rel="stylesheet" href="/print.css">
    </head><body>x</body></html>`;
    const out = await run(html, { maxSheets: 1, onError: () => {} });
    expect(out).toContain('.a{color:red}');
    expect(out).toContain('<link rel="stylesheet" href="/print.css">');
  });

  it('跳过 data: / javascript: 等非网络协议', async () => {
    const html = `<html><head><link rel="stylesheet" href="data:text/css,.x{}"></head><body>x</body></html>`;
    const out = await run(html, {
      fetchFn: () => {
        throw new Error('should not fetch');
      },
    });
    expect(out).toContain('data:text/css');
  });

  it('SSRF：页面里的 <link> 指向内网时被拦下', async () => {
    const html = `<html><head><link rel="stylesheet" href="http://169.254.169.254/latest/meta-data/"></head><body>x</body></html>`;
    const reasons: string[] = [];
    const out = await run(html, {
      onError: (_u: string, reason: string) => reasons.push(reason),
    });
    expect(out).toContain('169.254.169.254');
    expect(reasons.join('|')).toMatch(/blocked/);
  });

  it('rel 含多个值（preload stylesheet）也算样式表', async () => {
    const html = `<html><head><link rel="preload stylesheet" href="/app.css"></head><body>x</body></html>`;
    const out = await run(html);
    expect(out).toContain('.a{color:red}');
  });

  it('网络异常时保留原 <link>，不抛错', async () => {
    const html = `<html><head><link rel="stylesheet" href="/app.css"></head><body>x</body></html>`;
    const out = await run(html, {
      fetchFn: async () => {
        throw new Error('boom');
      },
      onError: () => {},
    });
    expect(out).toContain('<link rel="stylesheet" href="/app.css">');
  });

  it('HTML 无法解析时原样返回', async () => {
    const broken = '<html><head><link rel="stylesheet" href="/app.css">';
    // linkedom 容错很强，这里主要验证不抛错
    const out = await run(broken);
    expect(typeof out).toBe('string');
  });
});
