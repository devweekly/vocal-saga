/**
 * 服务端 URL fetcher：用 linkedom 解析 HTML 成可被 blockExtractor 使用的 Document。
 *
 * 为什么选 linkedom（而不是 jsdom / cheerio）：
 *   - jsdom 拉进旧版 undici，里面引用 `MessagePort` 全局，Cloudflare Workers
 *     运行时没有这个符号，模块加载就 ReferenceError。Workers / Pages 上 URL
 *     翻译功能完全不可用。
 *   - cheerio 用 css-select 模拟 DOM，没有 `createTreeWalker` / `NodeFilter`，
 *     改写 extractBlocks 成本太高。
 *   - linkedom 是纯 JS、triple-linked-list 的 DOM 实现，零 Node 内置依赖，
 *     在 Workers / V8 isolate / Node 都能跑，API 表面（querySelector /
 *     children / dataset / outerHTML 等）和 jsdom 高度一致。
 *
 * 与 fanyi-extension 的 browser 版本区别：
 *   - fetch + 注入 HTML 字符串，而非拿 document
 *   - linkedom 不执行 <script>、不拉外链，省冷启动时间
 *
 * 为什么需要 `injectGlobalWindow(document)`：
 *   - blockExtractor 内仍残留 `window.location.href` / `window.getComputedStyle`
 *     （fanyi-extension 原样移植，没改调用形态）
 *   - linkedom 不挂全局 `window` / `document`，需要手动设一下，
 *     让 server-side 调用和 browser 调用共享同一份规则代码。
 *   - 只在 Node 环境下生效（避免污染 Workers 进程的 isolate globalThis）。
 */
import { parseHTML } from 'linkedom';

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

  const tText = performance.now();
  const html = await response.text();
  console.log(`[PERF]   response.text ${(performance.now() - tText).toFixed(1)}ms (${html.length} bytes)`);

  // linkedom 没有 `url` 选项 —— 自己手动设置 baseURI（影响 a.href 解析）。
  // parseHTML 返回的是 Window-like 对象的 defaultView；.document 拿 Document。
  const tParse = performance.now();
  const { document } = parseHTML(html) as unknown as {
    document: Document;
  };
  console.log(`[PERF]   parseHTML ${(performance.now() - tParse).toFixed(1)}ms`);
  // finalUrl = 跟随重定向后的真实地址（response.url 在 fetch API 里就是这个）
  const finalUrl = response.url || url;
  try {
    // baseURI 改了之后，a / link / form 的相对 URL 解析才能用。
    // linkedom 不一定支持，但设了不报错。
    if (document.documentElement) {
      (document.documentElement as unknown as { baseURI?: string }).baseURI = finalUrl;
    }
  } catch {
    /* ignore */
  }

  return {
    url,
    finalUrl,
    doc: document,
    html,
    status: response.status,
  };
}
