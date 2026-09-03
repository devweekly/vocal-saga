/**
 * 外联样式表内联化 —— 让翻译结果页自包含，不再依赖原站资源。
 *
 * ## 背景（为什么必须做）
 *
 * 翻译结果页是原站 HTML 的原样拷贝，其中的 `<link rel="stylesheet">` 指向原站的
 * **内容哈希文件名**（如 `/assets/app-DYZF6iLK.css`）。原站一发版，旧哈希文件就
 * 404。此时会发生两件事，叠加起来让页面彻底崩坏：
 *
 *   1. 404 响应体是 HTML，浏览器 ORB（Opaque Response Blocking）直接拦掉样式表；
 *   2. Tailwind / CSS Modules 的布局类全部失效 → 容器塌成内容宽度、
 *      `w-full` 的图片按原始 2560px 渲染 → 横向溢出 + 图片超大
 *      （典型：towardsdatascience 的 article/579）。
 *
 * 只要 CSS 是外链的，任何缓存页迟早都会烂掉，重翻也只是换个哈希再烂一次。
 * 把 CSS 抓下来内联进 `<style>`，缓存页才真正自包含。
 *
 * ## 相对 URL 为什么仍然正确
 *
 * CSS 里的 `url(...)` 相对路径按**文档 base URL** 解析。翻译结果页的 `<head>`
 * 里已经注入了指向原站的 `<base href>`，所以内联后的 `url(/fonts/x.woff2)`
 * 依然会去原站取，行为与外链时一致。
 */

import { parseHTML } from 'linkedom';
import { assertPublicUrl } from '../urlUtils';

export interface InlineCssOptions {
  /** 解析相对 href 的基准 URL（重定向后的最终 URL） */
  baseUrl: string;
  /** 单个样式表的字节上限，超出则放弃内联（保留原 <link>）。默认 512KB */
  maxBytesPerSheet?: number;
  /** 本次总共允许内联的字节上限，超出则停止内联后续样式表。默认 1MB */
  maxBytesTotal?: number;
  /** 单次请求超时（毫秒）。默认 8000 */
  timeoutMs?: number;
  /** 最多内联几个样式表，超出的保留原 <link>。默认 6 */
  maxSheets?: number;
  /** 可注入的 fetch 实现（测试用） */
  fetchFn?: (url: string, signal: AbortSignal) => Promise<Response>;
  /** 单张样式表内联失败时的回调（默认 console.warn） */
  onError?: (url: string, reason: string) => void;
  /**
   * SSRF 校验钩子，抓取前对每个样式表 URL 调用。
   *
   * 这些 URL 来自被翻译页面的 HTML，属于**不可信输入**：页面作者可以写
   * `<link rel="stylesheet" href="http://169.254.169.254/...">` 借我们的
   * Worker 探测内网。因此必须逐条校验，且不能有"不传就不校验"的失效路径。
   */
  ssrfGuard?: (url: string) => void;
}

const DEFAULT_MAX_BYTES_PER_SHEET = 512 * 1024;
const DEFAULT_MAX_BYTES_TOTAL = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_SHEETS = 6;

/** 快速判断：没有外联样式表就直接返回，避免无谓的 DOM 解析 */
const STYLESHEET_LINK_RE = /<link\b[^>]*\brel\s*=\s*["'][^"']*stylesheet/i;

export async function inlineExternalStylesheets(
  html: string,
  options: InlineCssOptions,
): Promise<string> {
  if (!STYLESHEET_LINK_RE.test(html)) return html;

  const maxBytesPerSheet = options.maxBytesPerSheet ?? DEFAULT_MAX_BYTES_PER_SHEET;
  const maxBytesTotal = options.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSheets = options.maxSheets ?? DEFAULT_MAX_SHEETS;
  const doFetch = options.fetchFn ?? defaultFetch;
  const onError = options.onError ?? defaultOnError;

  let document: Document;
  try {
    ({ document } = parseHTML(html) as unknown as { document: Document });
  } catch {
    return html;
  }
  if (!document.documentElement) return html;

  const links = collectStylesheetLinks(document, maxSheets);
  if (links.length === 0) return html;

  // 并发抓取：样式表之间无依赖，串行会把首字节延迟累加到秒级
  const fetched = await Promise.all(
    links.map(async (link) => {
      const absolute = resolveStylesheetHref(link.href, options.baseUrl);
      if (!absolute) return null;
      // 样式表 URL 来自被翻译页面，逐条过 SSRF 校验（默认 assertPublicUrl）
      try {
        (options.ssrfGuard ?? assertPublicUrl)(absolute);
      } catch (e) {
        onError(absolute, `blocked: ${(e as Error).message}`);
        return null;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(absolute, controller.signal);
        if (!response.ok) {
          onError(absolute, `HTTP ${response.status}`);
          return null;
        }
        if (!isCssResponse(response)) {
          onError(absolute, `not css: ${response.headers.get('content-type') ?? 'unknown'}`);
          return null;
        }
        const css = await response.text();
        // 兜底：有些站点 404 时仍返回 200 + text/css，但内容是 HTML 错误页
        if (css.trimStart().startsWith('<')) {
          onError(absolute, 'looks like html, not css');
          return null;
        }
        if (css.length > maxBytesPerSheet) {
          onError(absolute, `too large: ${css.length} bytes`);
          return null;
        }
        return { link, absolute, css };
      } catch (e) {
        onError(absolute, (e as Error)?.message ?? String(e));
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  let total = 0;
  let inlined = 0;
  for (const item of fetched) {
    if (!item) continue;
    if (total + item.css.length > maxBytesTotal) {
      onError(item.absolute, 'total budget exceeded');
      continue;
    }
    total += item.css.length;
    replaceLinkWithStyle(document, item.link, item.absolute, item.css);
    inlined += 1;
  }

  if (inlined === 0) return html;
  return '<!doctype html>\n' + document.documentElement.outerHTML;
}

function defaultFetch(url: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, { signal, headers: { Accept: 'text/css,*/*;q=0.1' } });
}

function defaultOnError(url: string, reason: string): void {
  console.warn(`[cssInliner] skip ${url}: ${reason}`);
}

interface SheetLink {
  el: Element;
  href: string;
  media: string;
}

/**
 * 收集需要内联的外联样式表节点。
 *
 * 跳过条件：
 *   - 无 href / 协议非 http(s)（如 data:、blob:）
 *   - 超过 maxSheets（后面的保留外链，避免无界抓取）
 */
function collectStylesheetLinks(doc: Document, maxSheets: number): SheetLink[] {
  const out: SheetLink[] = [];
  for (const el of Array.from(doc.querySelectorAll('link'))) {
    const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) continue;
    const href = (el.getAttribute('href') || '').trim();
    if (!href || /^(?:data|blob|javascript):/i.test(href)) continue;
    if (out.length >= maxSheets) break;
    out.push({ el, href, media: (el.getAttribute('media') || '').trim() });
  }
  return out;
}

function resolveStylesheetHref(href: string, baseUrl: string): string | null {
  let resolved: URL;
  try {
    resolved = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  return resolved.href;
}

/**
 * 校验响应确实是 CSS。
 * 缺失 content-type 时放行（部分 CDN 不返回），后续还有内容兜底检查。
 */
function isCssResponse(response: Response): boolean {
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  if (!ct) return true;
  const mime = ct.split(';')[0].trim();
  return mime === 'text/css' || mime.endsWith('+css') || mime === 'text/plain';
}

/**
 * 用 `<style>` 替换 `<link>`。
 *
 * - `</style` 需转义，否则 CSS 里的这个字符序列会提前关闭标签、并把后面的
 *   内容当成 HTML 文本渲染出来（样式表就此中断）。`\/` 在 CSS 里是合法的
 *   `/` 转义，不影响解析结果。
 * - `<link media="print">` 之类的条件样式表不能直接内联成全局样式，
 *   用 `@media` 包一层保留原语义。
 */
function replaceLinkWithStyle(doc: Document, link: SheetLink, absolute: string, css: string): void {
  const style = doc.createElement('style');
  style.setAttribute('data-fanyi-inlined-css', absolute);
  if (link.media) style.setAttribute('media', link.media);
  const body = css.replace(/<\/style/gi, '<\\/style');
  style.textContent = needsMediaWrap(link.media) ? `@media ${link.media}{${body}}` : body;
  link.el.replaceWith(style);
}

function needsMediaWrap(media: string): boolean {
  if (!media) return false;
  const normalized = media.trim().toLowerCase();
  return normalized !== 'all' && normalized !== 'screen';
}
