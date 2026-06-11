/**
 * 服务端 URL fetcher：用 jsdom 解析 HTML 成可被 blockExtractor 使用的 Document。
 *
 * 为什么不直接用 cheerio：
 *   - contentHelper.prepareDocument → blockExtractor.extractBlocks 依赖
 *     document.createTreeWalker / NodeFilter / WeakSet 等真实 DOM API
 *   - cheerio 用 css-select 模拟，TreeWalker 不存在，会重构 extractBlocks
 *   - 翻译核心代码原样从 fanyi-extension 移植 → 保留 jsdom 路径最稳
 *
 * 与 fanyi-extension 的 browser 版本区别：
 *   - fetch + 注入 HTML 字符串，而非拿 document
 *   - jsdom 不执行 <script>（resourceLoader: 'usable' 仍会请求外链，
 *     这里禁掉，节省冷启动 + 避免 timeout）
 */

import { JSDOM, VirtualConsole } from 'jsdom';

export interface FetchedPage {
  url: string;
  finalUrl: string;
  doc: Document;
  html: string;
  status: number;
}

export async function fetchPage(
  url: string,
  opts: { timeoutMs?: number; userAgent?: string } = {}
): Promise<FetchedPage> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const userAgent = opts.userAgent ?? 'VocalSaga/1.0 (+translation)';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${response.status}`);
  }

  const html = await response.text();

  // VirtualConsole: 把 jsdom 的 console.* 桥接到 Node 进程 console，
  // 方便看到 site JS 跑出来的 console.log。
  const virtualConsole = new VirtualConsole();
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    virtualConsole.on(level, (...args) => console[level]('[page]', ...args));
  }

  const dom = new JSDOM(html, {
    url: response.url || url,
    // 不要让 jsdom 拉外链 script/css，节省时间和 Netlify Blobs 配额
    resources: 'usable',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });

  return {
    url,
    finalUrl: response.url || url,
    doc: dom.window.document,
    html,
    status: response.status,
  };
}
