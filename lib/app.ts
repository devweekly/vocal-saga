/**
 * 注入翻译显示所需的 CSS 到 HTML <head> 中。
 * /force/ 和 /translate/ 路径返回的翻译 HTML 包含 .fanyi-original / .fanyi-translation
 * 等 span 元素，但没有扩展端的 <style> 注入，必须由服务端补上。
 */
export const TRANSLATION_CSS = [
  '.fanyi-original{display:block!important;position:static!important;float:none!important;',
  'clear:both!important;margin:0!important;padding:0!important;max-width:100%!important;',
  'box-sizing:border-box!important;order:0!important}',
  '.fanyi-translation{display:block!important;position:static!important;float:none!important;',
  'clear:both!important;margin:0!important;padding:.15em .6em 0 0!important;',
  // 兜底：旧版本注入的 `border-left: 3px solid currentColor` 在多数页面解析为黑色，
  // 表现为中文译文段前的竖黑条。强制覆盖，确保历史缓存也被修正。
  'border-left:0!important;border-left-width:0!important;max-width:100%!important;',
  'box-sizing:border-box!important;order:1!important;margin-top:.3em!important}',
  // 媒体元素兜底约束：原站 CSS 缺失/被拦截时（典型：内容哈希 CSS 404 后
  // Chrome ORB 拦掉整张样式表），`width:100%` 类的布局类全部失效，图片会
  // 按原始像素宽度（2560px）渲染，撑出横向滚动条。这里兜底压回容器内。
  // height:auto 必须同时给，否则只压宽度不压高度会把图片压扁。
  'img,video,picture,figure,table,iframe{max-width:100%!important}',
  'img,video{height:auto!important}',
  // 展示期标记兜底：processTranslationHtml 在渲染 D1 缓存时，会先跑
  // applySiteDisplayRules（removeSelectors 打 data-fanyi-remove）和
  // applyGlobalNoiseFromUrl（标记 sidebar / 分享栏 / 弹窗）。
  // 这些标记依赖下面两组规则才能真正隐藏/弱化元素，但早期版本注入的
  // TRANSLATION_CSS 漏掉了它们，导致：
  //   1) Oreilly 的 #right-rail 被打上 data-fanyi-remove 却仍显示（article/588）；
  //   2) 通用噪声（aside / 浮窗 / 订阅弹窗）被打标却不生效。
  // 这里补齐，与 pipeline.ts 的 fanyi-bilingual-styles 保持一致。
  '[data-fanyi-remove="true"]{display:none!important;visibility:hidden!important;pointer-events:none!important}',
  '[data-fanyi-low-priority="true"]{opacity:.35;filter:grayscale(60%);transition:opacity .2s ease,filter .2s ease}',
  '[data-fanyi-low-priority="true"]:hover{opacity:1;filter:none}',
  // 动态注入的通知/订阅弹窗兜底隐藏（InfoWorld 等站点的 subscribers notification prompt）
  '[class*="notification"],[id*="notification"],[class*="subscribers"],[id*="subscribers"],[class*="push-notification"],[id*="push-notification"]{display:none!important}',
].join('');

export function injectTranslationCss(html: string): string {
  const styleTag = `<style data-fanyi-css>${TRANSLATION_CSS}</style>`;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${styleTag}</head>`);
  }
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>${styleTag}`);
  }
  if (html.includes('<body')) {
    return html.replace(/(<body[^>]*>)/, `$1${styleTag}`);
  }
  if (html.includes('<html')) {
    return html.replace(/(<html[^>]*>)/, `$1${styleTag}`);
  }
  return styleTag + html;
}

/**
 * 平台无关的 Hono 应用工厂。
 *
 * 入口（Netlify Functions / Cloudflare Pages）在启动时构造一个 StorageAdapter
 * （NetlifyBlobsStorage / CloudflareKVStorage / MapStorage），调本工厂拿到 Hono app。
 *
 * Hono 在 Workers 上零开销直接跑，在 Node 端通过 hono/aws-lambda 适配。
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { translateText, translateUrl, translateHtml } from './translate/pipeline';
import { validateTranslationCompleteness } from './translate/translationValidator';
import { simpleHash } from './translate/cacheKey';
import type { PromptStyle } from './translate/service/shared';
import {
  getGlossary,
  addUserTerms,
  removeUserTerm,
  clearUserTerms,
  setDocumentTerms,
  clearDocumentTerms,
} from './translate/glossaryStore';
import { setDefaultStorage, type StorageAdapter } from './storage';
import { requireAuth } from './auth';
import { extractClientInfo, formatClientLabel } from './clientInfo';
import { normalizeUrl, cacheKeyUrl, assertPublicUrl } from './urlUtils';
import { injectRedirectGuard } from './redirectGuard';
import { stripDangerousScripts, stripNavigationScripts } from './spaGuard';
import { devirtualizeLayout } from './devirtualize';
import { applyGlobalNoiseFromUrl } from './translate/contentHelper';
import { applySiteDisplayRules } from './translate/displayRules';
import {
  CF_BASE,
  DS_BASE,
  NVIDIA_BASE,
  OPENROUTER_BASE,
  DS_MODELS,
  resolveModel,
} from './modelResolver';
import {
  setDSApiKey,
  setOpenrouterApiKey,
  setNvidiaApiKey,
  setGeminiApiKey1,
  setGeminiApiKey2,
  setOpencodeApiKey,
  setCfAccountId,
  setCfApiToken,
  setAuthKey,
  getDSApiKey,
  getOpenrouterApiKey,
  getNvidiaApiKey,
  getGeminiApiKey1,
  getGeminiApiKey2,
  getOpencodeApiKey,
  getCfAccountId,
  getCfApiToken,
} from './config';

// ── extractor 懒加载 ────────────────────────────────────────
type Extractor = (text: string) => { document_terms: string[] };
let _extractGlossary: Extractor | null = null;
async function getExtractor(): Promise<Extractor> {
  if (!_extractGlossary) {
    const mod = await import('./translate/glossaryExtractor');
    _extractGlossary = (mod as any).extractGlossaryLocal as Extractor;
  }
  return _extractGlossary;
}

// ── 工厂 ────────────────────────────────────────────────────
export function createApp(env?: Record<string, unknown>, storage?: StorageAdapter): Hono {
  if (storage) setDefaultStorage(storage);

  // 配置注入（单一入口）：优先从 CF env bindings 读取（生产路径），
  // env 缺失时回退 process.env（Node 测试兼容入口）。
  // 注入后所有 service / modelResolver / auth 统一走 config getter，不再直接读 process.env。
  const getEnv = (key: string): string => {
    const fromEnv = env?.[key];
    if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
    return process.env[key] || '';
  };
  const dsKey = getEnv('DEEPSEEK_API_KEY');
  const openrouterKey = getEnv('OPENROUTER_API_KEY');
  const nvidiaKey = getEnv('NVIDIA_API_KEY');
  const geminiKey1 = getEnv('GEMINI_API_KEY');
  const geminiKey2 = getEnv('GEMINI_API_KEY_2');
  const opencodeKey = getEnv('OPENCODE_API_KEY');
  const cfAccountId = getEnv('CLOUDFLARE_ACCOUNT_ID');
  const cfApiToken = getEnv('CLOUDFLARE_API_TOKEN');
  const authKey = getEnv('AUTH_KEY');
  if (dsKey) setDSApiKey(dsKey);
  if (openrouterKey) setOpenrouterApiKey(openrouterKey);
  if (nvidiaKey) setNvidiaApiKey(nvidiaKey);
  if (geminiKey1) setGeminiApiKey1(geminiKey1);
  if (geminiKey2) setGeminiApiKey2(geminiKey2);
  if (opencodeKey) setOpencodeApiKey(opencodeKey);
  if (cfAccountId) setCfAccountId(cfAccountId);
  if (cfApiToken) setCfApiToken(cfApiToken);
  if (authKey) setAuthKey(authKey);

  // 简单的 HTML 转义，防止列表页 title XSS
  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 校验缓存的翻译 HTML 是否结构完整。
   * 旧版 pipeline 曾输出缺少 <html> 标签、<head> 被吞掉的损坏 HTML，
   * 导致页面 CSS 全部丢失。某些损坏缓存虽保留 <html>，但原页面内联
   * 样式被清空，只剩 OneTrust / fanyi 样式，也要视为 miss 重新翻译。
   */
  function isHealthyCachedHtml(html: string): boolean {
    // ── 结构检查（保留原有逻辑） ──
    // 旧版 pipeline 曾输出缺少 <html> 标签、<head> 被吞掉的损坏 HTML，
    // 导致页面 CSS 全部丢失。某些损坏缓存虽保留 <html>，但原页面内联
    // 样式被清空，只剩 OneTrust / fanyi 双语样式，也要视为 miss 重新翻译。
    if (!/<html\b/i.test(html)) return false;

    let structurallyHealthy = false;
    // 有外联样式表 → 健康
    if (/<link\b[^>]*\brel\s*=\s*["']stylesheet["']/i.test(html)) {
      structurallyHealthy = true;
    } else {
      // 有原页面内联样式（非 OneTrust、非 fanyi 双语样式）→ 健康
      const styleBlocks = html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || [];
      structurallyHealthy = styleBlocks.some((block) => {
        const contentStart = block.slice(block.indexOf('>') + 1).trimStart();
        return (
          !contentStart.startsWith('#onetrust-banner-sdk') &&
          !contentStart.startsWith('/* 双语对照样式')
        );
      });
    }
    if (!structurallyHealthy) return false;

    // ── <base> 位置检查 ──
    // 旧缓存里 <base> 可能位于相对 CSS 之后，浏览器会用代理域解析这些资源，
    // 导致 arxiv / ar5iv 等页面的 CSS 404、排版全乱。若 <head> 中任何相对路径
    // stylesheet 出现在 <base> 之前，视为损坏并触发重新翻译。
    const headMatch = html.match(/<head\b[^>]*>[\s\S]*?<\/head>/i);
    if (headMatch) {
      const headSection = headMatch[0];
      const baseMatch = headSection.match(/<base\b/i);
      if (baseMatch && baseMatch.index !== undefined) {
        const beforeBase = headSection.slice(0, baseMatch.index);
        const linkMatches = beforeBase.match(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi) || [];
        if (linkMatches.some((link) => /\shref\s*=\s*["']\/[^"']*["']/i.test(link))) {
          console.warn('[isHealthyCachedHtml] <base> appears after relative stylesheet, treating as unhealthy');
          return false;
        }
      }
    }

    // ── 翻译完整性校验（S7 新增） ──
    // 原有检查只看 HTML 结构 + 样式表，不检查翻译是否完整。
    // 调用 validateTranslationCompleteness 校验翻译标记存在 + 内容非空。
    const validation = validateTranslationCompleteness(html);
    if (!validation.healthy) {
      console.warn(`[isHealthyCachedHtml] translation validation failed: ${validation.reason}`);
      return false;
    }

    // ── 外联样式表存活性 ──
    // 缓存里引用的是抓取当时的哈希文件名，原站一发版就 404。此时页面结构
    // 完好、译文也完整，但样式全丢（Tailwind 布局类失效、图片按原尺寸渲染），
    // 用户看到的就是"样式乱了"。探针确认死链后判为不健康，让上层重新翻译；
    // 重新翻译时会走 cssInliner 把样式内联，之后就再也不会烂。
    return true;
  }

  const app = new Hono();
  app.use('*', cors());

  /**
   * 翻译 HTML 处理 pipeline：导航清理 → 去虚拟化 → 注入 CSS → 注入守卫。
   *
   * 接受可选 pageUrl：
   *   - 提供时，对白名单 host（x.com / twitter.com）重新应用全局噪声标记，
   *     修复早期翻译时规则尚未完善导致 .fanyi-remove 缺失的历史缓存；
   *   - 不提供则不重新应用（原始翻译 pipeline 已自带 markGlobalNoise）。
   *
   * 应用对象：所有缓存 HTML 路径（/article/:id 等）。
   *
   * 最后一步应用站点展示期规则（去侧边栏 / 加宽等）。它放在最末是因为
   * 可能追加 <script>，不能被前面的脚本清理步骤误删；也因为历史缓存是
   * 在这些规则写出来之前翻译的，只有展示期补得上。
   *
   * 注意：这里**不做**外联样式表内联 —— 那是抓取期（cssInliner）的职责，
   * 放到渲染路径上会给每次 /article/:id 增加若干个网络往返。
   */
  const processTranslationHtml = (html: string, pageUrl?: string): string => {
    const reread = pageUrl ? applyGlobalNoiseFromUrl(html, pageUrl) : html;
    const processed = injectRedirectGuard(
      injectTranslationCss(devirtualizeLayout(stripDangerousScripts(reread))),
    );
    return pageUrl ? applySiteDisplayRules(processed, pageUrl) : processed;
  };

  // 原始 HTML 处理 pipeline：仅导航清理 → 注入守卫
  const processOriginalHtml = (html: string) =>
    injectRedirectGuard(stripNavigationScripts(html));

  /**
   * 把任意错误信息清理成可放进 HTTP header 的安全字符串：
   * - 去掉控制字符 / 换行（header 不允许 \r\n）
   * - 截断到 200 字符，避免 header 过长
   * - 兜底空字符串
   *
   * 用于 X-Translate-Warning header，让扩展端能程序化感知 D1 save 失败。
   */
  const sanitizeHeaderValue = (msg: string): string =>
    (msg || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);

  /**
   * 在翻译结果 HTML 的 <body> 起始处注入一个小尺寸警告条：
   * - 仅在 D1 save 失败时调用，让前端（扩展双语视图 + 浏览器直访）都能看到
   * - 固定在右上角、12px 字号、琥珀色配色，避免大面积红色干扰阅读
   * - 纯内联样式 + <details> 原生折叠，不依赖 JS，与已有重定向守卫脚本无冲突
   *
   * @param html 已经过 processTranslationHtml 处理的最终 HTML
   * @param message 来自 catch (e) 的原始错误信息（会被转义 + 截断）
   */
  const injectSaveWarningBanner = (html: string, message: string): string => {
    // 转义 < > & 防止错误信息破坏 HTML 结构
    const safe = (message || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .slice(0, 200)
      .trim();
    const banner =
      '<details data-vs-save-warning open style="position:fixed;top:8px;right:8px;z-index:99999;' +
      'max-width:360px;margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;">' +
      '<summary style="padding:6px 10px;font-size:12px;line-height:1.4;cursor:pointer;' +
      'background:#fef3c7;color:#92400e;border:1px solid #f59e0b;border-radius:4px;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.15);list-style:none;">' +
      '译文已生成，但服务端缓存失败（点击折叠）' +
      '</summary>' +
      '<div style="margin-top:4px;padding:6px 10px;font-size:11px;line-height:1.5;' +
      'background:#fffbeb;color:#78350f;border:1px solid #fde68a;border-radius:4px;' +
      'word-break:break-all;max-height:120px;overflow:auto;">' + safe + '</div>' +
      '</details>';
    // 注入到 <body ...> 之后；若无 <body>，附加到开头
    if (/<body[^>]*>/i.test(html)) {
      return html.replace(/<body[^>]*>/i, (m) => m + banner);
    }
    return banner + html;
  };

  // 每页记录数
  const PAGE_SIZE = 30;

  /**
   * 渲染翻译记录列表页（带分页导航）。
   * 供 GET / 和 GET /page/:page 共用。
   *
   * @param page 当前页码（从 1 开始）
   * @param rows 当前页的记录数组
   * @param total 总记录数（用于计算总页数）
   */
  function renderListPage(page: number, rows: any[], total: number): Response {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), totalPages);

    // 构建 HTML 列表页
    const items = rows.map((r: any) => {
      const url = `${r.url}`;
      const displayTitle = r.title || r.url;
      return `<li style="margin-bottom:16px;line-height:1.6">
        <a href="/article/${r.id}" style="font-size:16px;text-decoration:none;color:#2563eb;font-weight:500">${escapeHtml(displayTitle)}</a>
        <br><a href="${url}" target="_blank" rel="noopener" style="color:#9ca3af;font-size:12px;text-decoration:none">${r.url}</a>
      </li>`;
    }).join('\n');

    // 分页导航：上一页 / 页码 / 下一页
    const prevLink = safePage > 1
      ? `<a href="/page/${safePage - 1}" style="margin:0 6px;text-decoration:none;color:#2563eb">← 上一页</a>`
      : `<span style="margin:0 6px;color:#d1d5db">← 上一页</span>`;
    const nextLink = safePage < totalPages
      ? `<a href="/page/${safePage + 1}" style="margin:0 6px;text-decoration:none;color:#2563eb">下一页 →</a>`
      : `<span style="margin:0 6px;color:#d1d5db">下一页 →</span>`;
    const pager = total > 0
      ? `<div style="margin-top:32px;text-align:center;font-size:14px">${prevLink}<span style="margin:0 6px;color:#6b7280">${safePage} / ${totalPages}</span>${nextLink}</div>`
      : '';

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>翻译记录${safePage > 1 ? ` · 第 ${safePage} 页` : ''}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1f2937; }
  h1 { font-size: 24px; margin-bottom: 24px; }
  ul { list-style: none; padding: 0; }
  a:hover { text-decoration: underline !important; }
  .empty { color: #9ca3af; font-size: 15px; }
</style>
</head>
<body>
<h1>翻译记录</h1>
${items ? `<ul>${items}</ul>` : '<p class="empty">暂无翻译记录</p>'}
${pager}
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  /**
   * 从 D1 查询指定页的记录 + 总数。
   * 返回 { rows, total }，查询失败时 rows 为空数组。
   */
  async function fetchListPage(db: any, page: number): Promise<{ rows: any[]; total: number }> {
    if (!db) return { rows: [], total: 0 };
    const offset = (page - 1) * PAGE_SIZE;
    try {
      const [dataResult, countResult] = await Promise.all([
        db.prepare(
          'SELECT id, url, title, source_lang, target_lang FROM translations ORDER BY id DESC LIMIT ? OFFSET ?'
        ).bind(PAGE_SIZE, offset).all(),
        db.prepare('SELECT COUNT(*) as total FROM translations').first(),
      ]);
      return {
        rows: dataResult.results || [],
        total: countResult?.total || 0,
      };
    } catch (e) {
      console.error('[D1] list error:', e);
      return { rows: [], total: 0 };
    }
  }

  // ── GET / — 首页，渲染第 1 页 ────────────────────────
  app.get('/', async (c) => {
    const db = (c.env as any)?.DB999;
    const { rows, total } = await fetchListPage(db, 1);
    return renderListPage(1, rows, total);
  });

  // ── GET /page/:page — 分页列表 ──────────────────────
  // 必须在 /:id 之前注册，否则 /page/1 会被 :id 捕获
  app.get('/page/:page', async (c) => {
    const pageStr = c.req.param('page');
    const page = parseInt(pageStr, 10);
    if (!Number.isFinite(page) || page < 1) return c.notFound();
    const db = (c.env as any)?.DB999;
    const { rows, total } = await fetchListPage(db, page);
    return renderListPage(page, rows, total);
  });

  // ── GET /article/:id — 从 D1 取出第 N 次翻译结果展示 ────────
  app.get('/article/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^\d+$/.test(id)) return c.notFound();
    const db = (c.env as any)?.DB999;
    if (!db) return c.json({ error: 'D1 not available' }, 500);
    try {
      const row: any = await db.prepare(
        'SELECT url, source_lang, target_lang, html FROM translations WHERE id = ?'
      ).bind(Number(id)).first();
      if (!row) return c.json({ error: 'translation not found' }, 404);

      // 若当前记录健康，直接返回（保持 /article/:id 的语义）
      if (isHealthyCachedHtml(row.html)) {
        // 传入 row.url：对白名单 host 重新应用全局噪声标记，修复旧缓存里
        // .fanyi-remove 缺失导致侧边栏不隐藏的问题（典型：x.com 文章页）。
        return new Response(processTranslationHtml(row.html, row.url || ''), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // 当前记录损坏时，先查同一 URL+语言是否有更新的健康缓存。
      // 典型场景：/fanyi/page 保存了带 content_hash 的记录（id=432），而
      // /translate/* 后来保存了 URL 级记录（id=433），后者应能被 /article/:id 使用。
      const latest: any = await db.prepare(
        'SELECT html FROM translations WHERE url = ? AND source_lang = ? AND target_lang = ? ORDER BY created_at DESC LIMIT 1'
      ).bind(row.url, row.source_lang, row.target_lang).first();
      if (latest && isHealthyCachedHtml(latest.html)) {
        console.log(`[D1] article/${id} found newer healthy cache for same URL, serving it`);
        return new Response(processTranslationHtml(latest.html, row.url || ''), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // 没有可用缓存时重定向到重新翻译，避免展示无 CSS 的畸形页面
      console.warn(`[D1] article/${id} cached HTML is unhealthy, redirecting to re-translate`);
      if (row.url) {
        return c.redirect(`/translate/${encodeURIComponent(row.url.replace(/^https?:\/\//i, ''))}`);
      }
      return c.json({ error: 'cached translation is corrupted' }, 500);
    } catch (e) {
      console.error('[D1] fetch error:', e);
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ── POST /api/v1/chat/completions ─────────────────────
  app.post('/api/v1/chat/completions', requireAuth, async (c) => {

    const body = await c.req.json().catch(() => ({} as any));
    const { stream, _backend } = body;
    const resolved = resolveModel(body?.model, _backend);
    if (resolved.error) {
      return c.json({ error: resolved.error }, 400);
    }
    const updated = { ...body, model: resolved.model };
    const backend = resolved.backend;

    if (backend !== 'deepseek' && !updated.model) {
      return c.json({ error: 'model is required for this backend', backend }, 400);
    }

    console.log(`[req] model=${resolved.model} backend=${backend} stream=${!!stream} msgs=${updated.messages?.length ?? 0}`);

    if (backend === 'deepseek') {
      if (updated.thinking === undefined) {
        updated.thinking = { type: 'disabled' };
      }
      if (updated.temperature === undefined) {
        updated.temperature = 0.1;
      }
      if (updated.user_id === undefined && !updated.user) {
        updated.user_id = 'vocal-saga';
      }
    }

    let targetUrl: string, headers: Record<string, string>;

    if (backend === 'cloudflare') {
      if (!getCfAccountId() || !getCfApiToken()) {
        return c.json({ error: 'Cloudflare AI not configured' }, 500);
      }
      targetUrl = `${CF_BASE()}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${getCfApiToken()}`, 'Content-Type': 'application/json' };
    } else if (backend === 'nvidia') {
      if (!getNvidiaApiKey()) {
        return c.json({ error: 'NVIDIA Build not configured' }, 500);
      }
      targetUrl = `${NVIDIA_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${getNvidiaApiKey()}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
    } else if (backend === 'openrouter') {
      if (!getOpenrouterApiKey()) {
        return c.json({ error: 'OpenRouter not configured' }, 500);
      }
      targetUrl = `${OPENROUTER_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${getOpenrouterApiKey()}`, 'Content-Type': 'application/json' };
    } else {
      if (!getDSApiKey()) {
        return c.json({ error: 'DeepSeek not configured' }, 500);
      }
      targetUrl = `${DS_BASE}/v1/chat/completions`;
      headers = { Authorization: `Bearer ${getDSApiKey()}`, 'Content-Type': 'application/json' };
    }

    const startedAt = Date.now();
    try {
      const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(updated),
      });

      const latency = Date.now() - startedAt;

      if (!upstream.ok) {
        const errData = await upstream.json();
        console.error(`[resp] status=${upstream.status} latency=${latency}ms error=${JSON.stringify(errData)}`);
        return c.json(errData, upstream.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503);
      }

      if (stream && upstream.body) {
        console.log(`[resp] status=${upstream.status} latency=${latency}ms stream=started`);
        // 把上游 ReadableStream 直接透传
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      const data = (await upstream.json()) as Record<string, any>;
      const usage = data.usage;
      console.log(`[resp] status=${upstream.status} latency=${latency}ms` +
        (usage ? ` tokens_in=${usage.prompt_tokens} tokens_out=${usage.completion_tokens}` : ''));
      return c.json({ ...data, _backend: backend });
    } catch (err) {
      console.error(`[resp] error="${(err as Error).message}" latency=${Date.now() - startedAt}ms`);
      return c.json({ error: 'Upstream request failed', detail: (err as Error).message }, 502);
    }
  });

  // ── GET /fanyi/page/check ────────────────────────────
  // 浏览器扩展代理：先查询服务端是否已有该 URL 的翻译缓存，
  // 命中则直接返回缓存的 bilingual HTML，未命中返回 204。
  // 这样扩展端在 cache 命中时可以避免本地 prepareHtmlForServer 等重计算。
  app.get('/fanyi/page/check', async (c) => {
    const url = c.req.query('url');
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    // 单次翻译会话标识（扩展端 check→page 共享），用于关联整条链路日志。
    const sid = c.req.header('x-session-id') || '-';

    const source = c.req.query('source') || 'en';
    const target = c.req.query('target') || 'zh';
    // 可选：客户端传来的内容哈希，用于检测页面内容是否已更新
    const clientContentHash = c.req.query('contentHash');

    const VALID_LANG_RE = /^(auto|[a-zA-Z]{2,3})(-[a-zA-Z]{2,3})?$/;
    const sourceStored = source && VALID_LANG_RE.test(source) ? source : 'en';
    const targetStored = VALID_LANG_RE.test(target) ? target : 'zh';

    const db = (c.env as any)?.DB999;
    if (db) {
      try {
        // 按 url+lang 取最新一条，在代码中比对 content_hash
        // （向后兼容：旧记录 content_hash 为 NULL 或空，无法比对时直接返回缓存）
        const existing: any = await db
          .prepare(
            'SELECT html, content_hash FROM translations WHERE url = ? AND source_lang = ? AND target_lang = ? ORDER BY created_at DESC LIMIT 1',
          )
          .bind(cacheKeyUrl(url), sourceStored, targetStored)
          .first();
        if (existing && isHealthyCachedHtml(existing.html)) {
          // 命中但客户端传了 contentHash 且缓存有有效 content_hash 且不匹配 → 410（内容已变，客户端应重新 POST）
          // 注意：/fanyi/page 接收扩展端预标记 HTML，block ID 由扩展端 walker 分配。
          // /translate/url-page（浏览器直访）存的缓存 content_hash 为空串，其 block ID 是服务端
          // 自行分配的，与扩展端 walker 的编号体系不同。若把这种缓存当命中返回，
          // 扩展端按自己的 b1/b2/... 去查服务端缓存的 b1/b2/... → 译文错位到错误的 DOM 元素。
          // 因此：空 content_hash 在 /fanyi/page 路径下必须视为未命中（强制走完整 pipeline）。
          const hashValid = existing.content_hash && existing.content_hash !== '';
          if (
            clientContentHash &&
            hashValid &&
            clientContentHash !== existing.content_hash
          ) {
            console.log(`[fanyi/page/check] D1 cache stale for ${url} (content_hash mismatch) sid=${sid}`);
            return new Response(null, { status: 410 });
          }
          if (hashValid) {
            console.log(`[fanyi/page/check] D1 cache hit for ${url} sid=${sid}`);
            return new Response(processTranslationHtml(existing.html, url), {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=3600',
              'X-Translate-Source': 'd1-cache',
            },
          });
          }
          // hashValid=false（content_hash 为空/NULL）：来自 /translate/url-page 等非预标记路径的缓存，
          // block ID 编号体系与扩展端 walker 不同，不能当命中返回。视为未命中，走 204 让扩展端 POST。
        }
        if (existing) {
          console.warn(`[fanyi/page/check] D1 cache for ${url} is unhealthy, treating as miss sid=${sid}`);
        }
      } catch (e) {
        console.error('[D1] lookup error:', e);
        // 查询失败不阻塞翻译，让扩展端 fallback 到 POST /fanyi/page
      }
    }

    return new Response(null, { status: 204 });
  });

  // ── POST /fanyi/page ─────────────────────────────────
  // 浏览器扩展代理：接收扩展传来的预标记 HTML，返回 bilingual 双语对照 HTML。
  // provider 可选 deepseek / openrouter / nvidia / cloudflare：
  //   - 选择 deepseek 时，必须提供 apiKey，服务端用此 Key 调用 DeepSeek；
  //   - 选择其他 provider 时，使用服务端配置的对应 Key。
  // 用于绕过 Cloudflare Challenge 等反爬场景——扩展在真实浏览器中拿到 HTML，
  // 传给服务端翻译，服务端不再直接 fetch 目标 URL。
  app.post('/fanyi/page', async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const { html, url } = body;

    // 客户端浏览器信息：优先用扩展端带来的精确 client 对象，缺失时由 UA header 推导。
    // 用于错误日志定位「某浏览器失败」类问题（如 Firefox Android vs Chrome）。
    const clientInfo = extractClientInfo({
      client: body.client,
      userAgentHeader: c.req.header('user-agent'),
    });
    const clientLabel = formatClientLabel(clientInfo);
    // 单次翻译会话标识（扩展端 check→page 共享），用于关联整条链路日志。
    const sid = c.req.header('x-session-id') || body.sessionId || '-';

    if (!html || typeof html !== 'string' || html.length === 0) {
      return c.json({ error: 'html is required' }, 400);
    }
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    // /fanyi/page 固定为 bilingual 模式
    const mode = 'bilingual' as const;

    // 翻译文风：从 body 读取，不传时下游默认 'default'（向后兼容）
    const promptStyle = body.promptStyle as PromptStyle | undefined;

    // provider 字段统一命名（扩展端 / 服务端一致），避免与 TranslationService 类混淆
    const provider = body.provider || c.req.query('provider') || 'deepseek';
    const VALID_PROVIDERS = ['deepseek', 'openrouter', 'nvidia', 'cloudflare', 'gemini', 'opencode'];
    if (!VALID_PROVIDERS.includes(provider)) {
      return c.json({ error: 'provider must be one of deepseek, openrouter, nvidia, cloudflare, gemini, opencode' }, 400);
    }

    // deepseek 必须提供 apiKey（客户端 Key），其他 provider 使用服务端 Key
    const apiKey = body.apiKey;
    if (provider === 'deepseek' && (!apiKey || typeof apiKey !== 'string')) {
      return c.json({ error: 'apiKey is required' }, 400);
    }

    const source = body.source || c.req.query('source');
    const target = body.target || c.req.query('target') || 'zh';

    const VALID_LANG_RE = /^(auto|[a-zA-Z]{2,3})(-[a-zA-Z]{2,3})?$/;
    const sourceStored = source && VALID_LANG_RE.test(source) ? source : 'en';
    const targetStored = VALID_LANG_RE.test(target) ? target : 'zh';

    console.log(`[fanyi/page] url=${url} src=${sourceStored} tgt=${targetStored} mode=${mode} provider=${provider} html=${html.length} bytes client=${clientLabel} sid=${sid}`);

    // ── D1 缓存：同 URL+source+target 已存在且 content_hash 匹配则直接返回 ──
    // 计算 contentHash：用于检测页面内容是否已更新（同一 URL 内容变了应重新翻译）
    const contentHash = String(simpleHash(html));
    const db = (c.env as any)?.DB999;
    const cacheKey = cacheKeyUrl(url);
    if (db) {
      try {
        const existing: any = await db.prepare(
          'SELECT html, content_hash FROM translations WHERE url = ? AND source_lang = ? AND target_lang = ? ORDER BY created_at DESC LIMIT 1'
        ).bind(cacheKey, sourceStored, targetStored).first();
        if (existing && isHealthyCachedHtml(existing.html)) {
          // /fanyi/page 接收扩展端预标记 HTML，block ID 由扩展端 walker 分配。
          // /translate/url-page 等路径存的缓存 content_hash 为空串，其 block ID 是服务端
          // 自行分配的，与扩展端 walker 编号体系不同。空 content_hash 必须视为未命中，
          // 否则扩展端按自己的 b1/b2 查服务端缓存的 b1/b2 → 译文错位。
          const hashValid = existing.content_hash && existing.content_hash !== '';
          if (hashValid && existing.content_hash !== contentHash) {
            console.log(`[fanyi/page] D1 cache stale for ${url} (content_hash mismatch), re-translating sid=${sid}`);
            // fall through to translate
          } else if (hashValid) {
            console.log(`[fanyi/page] D1 cache hit for ${url} sid=${sid}`);
            return new Response(processTranslationHtml(existing.html, url), {
              status: 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=3600',
                'X-Translate-Source': 'd1-cache',
              },
            });
          }
          // hashValid=false（content_hash 空/NULL）：非预标记路径的旧缓存，block ID 与扩展端不兼容，
          // 视为未命中，fall through 走完整 pipeline。
        }
        else if (existing) {
          console.warn(`[fanyi/page] D1 cache for ${url} is unhealthy, treating as miss`);
        }
      } catch (e) {
        console.error('[D1] lookup error:', e);
        // 查询失败不阻塞翻译，继续走正常流程
      }
    }

    try {
      const result = await translateHtml({
        html,
        url,
        source: sourceStored,
        target: targetStored,
        mode,
        provider,
        apiKey,
        promptStyle,
      });

      // 翻译 0 个 block → 不缓存 D1，直接返回错误
      if (result.translatedBlocks === 0 && result.blocks > 0) {
        return c.json({
          error: 'Translation produced no results',
          detail: `${result.blocks} blocks extracted but 0 translated — provider may be unavailable or prompt was filtered`,
        }, 500);
      }

      // 写入 D1：SQLite UPSERT，www 和非 www 共享同一缓存
      // content_hash 纳入 UNIQUE 约束：内容变化时插入新行，内容不变时更新已有行
      // save 失败不阻塞翻译返回，但要把错误 surface 给前端（header + HTML banner），
      // 否则前端拿不到任何信号、下次访问会重复翻译却无人察觉
      let saveError: string | null = null;
      if (db) {
        try {
          await db.prepare(`
            INSERT INTO translations (url, title, source_lang, target_lang, html, content_hash)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(url, source_lang, target_lang, content_hash)
            DO UPDATE SET
              title = excluded.title,
              html = excluded.html,
              created_at = CURRENT_TIMESTAMP
          `).bind(cacheKey, result.title || '', sourceStored, targetStored, result.html, contentHash).run();
        } catch (e) {
          saveError = (e as Error)?.message || String(e);
          console.error('[D1] save error:', e);
        }
      }

      const finalHtml = saveError
        ? injectSaveWarningBanner(processTranslationHtml(result.html), saveError)
        : processTranslationHtml(result.html);

      return new Response(finalHtml, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Translate-Blocks': String(result.blocks),
          'X-Translate-Chunks': String(result.chunks),
          'X-Translate-Duration-Ms': String(result.duration_ms),
          // save 失败时透出错误信息，让扩展端能 toast 提示
          ...(saveError ? { 'X-Translate-Warning': sanitizeHeaderValue(saveError) } : {}),
        },
      });
    } catch (err) {
      console.error(`[fanyi/page] error: ${(err as Error).message} | client=${clientLabel} sid=${sid}`);
      return c.json({ error: (err as Error).message, client: clientInfo, sessionId: sid }, 500);
    }
  });

  // ── GET /api/v1/models ────────────────────────────────
  app.get('/api/v1/models', (c) => {
    const models: any[] = [];
    if (getDSApiKey()) {
      for (const id of DS_MODELS) {
        models.push({ id, object: 'model', owned_by: 'deepseek' });
      }
    }
    return c.json({ object: 'list', data: models });
  });

  // ── GET /api/hello ────────────────────────────────────
  app.get('/api/hello', (c) => {
    const name = c.req.query('name') || 'world';
    return c.json({ message: `Hello, ${name}!`, timestamp: new Date().toISOString() });
  });

  // ── 翻译代理 ──────────────────────────────────────────
  app.post('/api/translate/text', async (c) => {
    const { text, source, target, glossary, promptStyle } = await c.req.json().catch(() => ({} as any));
    if (!text || typeof text !== 'string') {
      return c.json({ error: 'text is required' }, 400);
    }
    console.log(`[translate/text] chars=${text.length} src=${source || 'en'} tgt=${target || 'zh'}`);
    try {
      const result = await translateText({
        text,
        source,
        target,
        glossary,
        promptStyle: promptStyle as PromptStyle | undefined,
      });
      console.log(`[translate/text] chunks=${result.chunks} duration=${result.duration_ms}ms`);
      return c.json(result);
    } catch (err) {
      console.error('[translate/text] error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /**
   * 公共翻译 handler，供 /translate/*、/s/*、/force/*、/openrt/*、/nvd/*、/gemini/*、/oc/* 使用。
   * @param force 跳过 D1 缓存，强制重新翻译并覆盖写入
   * @param provider LLM 提供方：'deepseek'（默认）、'openrouter'、'nvidia'、'cloudflare'、'mimo'、'gemini'、'opencode'
   * @param model 可选模型名（用于 NVIDIA / Gemini 等多模型服务）
   */
  async function handleTranslateRequest(c: any, rawPath: string, force = false, provider: 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare' | 'mimo' | 'gemini' | 'opencode' = 'deepseek', model?: string) {
    if (!rawPath) {
      return c.json({ error: 'target url is required in path' }, 400);
    }

    const normalized = normalizeUrl(rawPath);
    if (!normalized) {
      return c.json({ error: 'target url is empty after normalization' }, 400);
    }
    const url = `https://${normalized}`;

    const source = c.req.query('source');
    const target = c.req.query('target') || 'zh';
    // 全局只支持双语对照模式
    const mode = 'bilingual' as const;

    // 翻译文风：从 query param `style` 读取，不传时下游默认 'default'（向后兼容）
    const promptStyle = c.req.query('style') as PromptStyle | undefined;

    // source / target 必须是合法语言代码（auto、ISO 639-1/2 字母码、或带区域子标签）
    const VALID_LANG_RE = /^(auto|[a-zA-Z]{2,3})(-[a-zA-Z]{2,3})?$/;
    const sourceStored = source && VALID_LANG_RE.test(source) ? source : 'en';
    const targetStored = VALID_LANG_RE.test(target) ? target : 'zh';

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return c.json({ error: 'url is not a valid URL' }, 400);
    }
    if (parsed.protocol !== 'https:') {
      // 强制 https（用户输入 http:// 也强制升 https，避免明文抓取）
      return c.json({ error: 'url must be https' }, 400);
    }
    // SSRF 防护：拒绝私网/保留/链路本地地址，防止服务端被用作内网探测代理
    try {
      assertPublicUrl(url);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    console.log(`[translate/url-page] url=${url} src=${sourceStored} tgt=${targetStored} mode=${mode} force=${force}`);

    // ── D1 去重：同 URL+source+target 已存在则直接返回（force 模式跳过） ──
    // 用 cacheKeyUrl 标准化：www.example.com 和 example.com 命中同一缓存
    const db = (c.env as any)?.DB999;
    const cacheKey = cacheKeyUrl(url);
    if (db && !force) {
      try {
        const existing: any = await db.prepare(
          'SELECT html FROM translations WHERE url = ? AND source_lang = ? AND target_lang = ? ORDER BY created_at DESC LIMIT 1'
        ).bind(cacheKey, sourceStored, targetStored).first();
        if (existing && isHealthyCachedHtml(existing.html)) {
          console.log(`[translate/url-page] D1 cache hit for ${url}`);
          return new Response(processTranslationHtml(existing.html, url), {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=3600',
              'X-Translate-Source': 'd1-cache',
            },
          });
        }
        if (existing) {
          console.warn(`[translate/url-page] D1 cache for ${url} is unhealthy, treating as miss`);
        }
      } catch (e) {
        console.error('[D1] lookup error:', e);
        // 查询失败不阻塞翻译，继续走正常流程
      }
    }

    try {
      const result = await translateUrl({
        url,
        source,
        target,
        mode,
        provider,
        model,
        promptStyle,
        skipCache: force,
      });
      console.log(`[translate/url-page] blocks=${result.blocks} translated=${result.translatedBlocks} chunks=${result.chunks} duration=${result.duration_ms}ms`);

      // 翻译 0 个 block → 服务端翻译失败，不缓存 D1，返回错误
      if (result.translatedBlocks === 0 && result.blocks > 0) {
        return c.json({
          error: 'Translation produced no results',
          detail: `${result.blocks} blocks extracted but 0 translated — service may be unavailable or prompt was filtered`,
        }, 500);
      }

      // 写入 D1：SQLite UPSERT（ON CONFLICT DO UPDATE），不再需要 force 时先 DELETE
      // 用 cacheKey 存储：www 和非 www 共享同一缓存
      // URL 翻译不跟踪输入内容哈希，content_hash 用空串占位（UNIQUE 约束要求非 NULL 才能触发冲突更新）
      // save 失败不阻塞翻译返回，但要把错误 surface 给前端（header + HTML banner），
      // 否则用户直访该 URL 时无法察觉缓存失效、每次访问都重复翻译
      let saveError: string | null = null;
      if (db) {
        try {
          await db.prepare(`
            INSERT INTO translations (url, title, source_lang, target_lang, html, content_hash)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(url, source_lang, target_lang, content_hash)
            DO UPDATE SET
              title = excluded.title,
              html = excluded.html,
              created_at = CURRENT_TIMESTAMP
          `).bind(cacheKey, result.title || '', sourceStored, targetStored, result.html, '').run();
        } catch (e) {
          saveError = (e as Error)?.message || String(e);
          console.error('[D1] save error:', e);
        }
      }
      const finalHtml = saveError
        ? injectSaveWarningBanner(processTranslationHtml(result.html), saveError)
        : processTranslationHtml(result.html);
      return new Response(finalHtml, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          // 翻译结果比原页面更"耐用"，给个 1h 客户端缓存
          'Cache-Control': 'public, max-age=3600',
          // 暴露给浏览器方便看耗时 / 命中情况
          'X-Translate-Blocks': String(result.blocks),
          'X-Translate-Chunks': String(result.chunks),
          'X-Translate-Duration-Ms': String(result.duration_ms),
          // save 失败时透出错误信息，前端可程序化感知
          ...(saveError ? { 'X-Translate-Warning': sanitizeHeaderValue(saveError) } : {}),
        },
      });
    } catch (err) {
      console.error('[translate/url-page] error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  /**
   * 把 /s/<domain-or-shorthand>/<path> 转成完整 URL。
   * 规则：
   *   - 单单词无点号 → www.<word>.com（如 /s/medium/article → https://www.medium.com/article）
   *   - 含点号则当完整域名用（如 /s/example.com/xxx → https://example.com/xxx）
   */
  app.get('/s/*', async (c) => {
    let raw = decodeURIComponent(c.req.path.slice('/s/'.length));
    if (!raw) {
      return c.json({ error: 'target is required after /s/' }, 400);
    }

    // 剥离 scheme（兼容 /s/https://github.com/... 和 /s/github.com/...）
    raw = raw.replace(/^https?:\/\//i, '');

    const slashIdx = raw.indexOf('/');
    const firstSeg = slashIdx < 0 ? raw : raw.slice(0, slashIdx);
    const rest = slashIdx < 0 ? '' : raw.slice(slashIdx + 1);

    // 单单词无点号 → 自动补成 www.<word>.com
    const host = firstSeg.includes('.') ? firstSeg : `www.${firstSeg}.com`;

    const resolved = rest ? `https://${host}/${rest}` : `https://${host}`;
    return handleTranslateRequest(c, resolved);
  });

  /**
   * GET /translate/<target-without-scheme>
   *
   * 浏览器直访入口：把目标 URL 抓下来 + 翻译 + 双语回填，返回渲染好的 HTML。
   * 路径里的 `target` 是去掉 `https://` 后的剩余部分（如 `example.com/foo`），
   * 浏览器地址栏直接拼就能用，不需要带 Authorization header。
   *
   * 路径格式：
   *   - /translate/example.com              → https://example.com
   *   - /translate/example.com/foo/bar      → https://example.com/foo/bar
   *   - /translate/https%3A%2F%2Fx.com%2Fy  → https://x.com/y （含 scheme 的 URL 自动剥）
   *
   * Query params（可选）：
 *   - source / target: ISO 代码，默认 auto / zh
 *   - mode: 已废弃，全局固定为 bilingual
 *
   * Auth: 故意不校验。原因：浏览器直访是核心使用场景，Authorization header
   *       没法在地址栏导航时附带。这个端点等同于「公开代理」，信任部署在
   *       自己域上、需要谨慎开放（建议加 Cloudflare Access / WAF 限流）。
   */
  app.get('/translate/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/translate/'.length));
    return handleTranslateRequest(c, raw);
  });

  // ── 强制翻译：跳过 D1 缓存，强制重新抓取+翻译 ──────────
  // 流量限制：每 IP 每分钟最多 1 次（防滥用）
  const forceRateLimit = new Map<string, number>();
  const FORCE_RATE_LIMIT_MS = 30_000; //

  app.get('/force/*', (c) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const last = forceRateLimit.get(ip) || 0;
    if (now - last < FORCE_RATE_LIMIT_MS) {
      const retryAfter = Math.ceil((FORCE_RATE_LIMIT_MS - (now - last)) / 1000);
      return c.json({ error: `Rate limit: 1 request per 30s. Retry after ${retryAfter}s` }, 429);
    }
    forceRateLimit.set(ip, now);
    // 清理过期条目（防止内存泄漏）
    if (forceRateLimit.size > 1000) {
      for (const [key, ts] of forceRateLimit) {
        if (now - ts > FORCE_RATE_LIMIT_MS) forceRateLimit.delete(key);
      }
    }
    const raw = decodeURIComponent(c.req.path.slice('/force/'.length));
    return handleTranslateRequest(c, raw, /* force */ true);
  });

  // ── OpenRouter 免费模型翻译：使用 openrouter/free ──────────
  app.get('/openrt/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/openrt/'.length));
    return handleTranslateRequest(c, raw, /* force */ false, /* provider */ 'openrouter');
  });

  // ── NVIDIA 翻译：使用 build.nvidia.com ──────────
  // /nvd/{url} → moonshotai/kimi-k2.6
  // /nvd/deepseek/{url} → deepseek-ai/deepseek-v4-flash
  // /nvd/qwen/{url} → qwen/qwen3-next-80b-a3b-instruct
  app.get('/nvd/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/nvd/'.length));
    let urlPath = raw;
    let model: string | undefined = 'stepfun-ai/step-3.7-flash';
    if (raw.startsWith('deepseek/')) {
      urlPath = raw.slice('deepseek/'.length);
      model = 'deepseek-ai/deepseek-v4-flash';
    } else if (raw.startsWith('qwen/')) {
      urlPath = raw.slice('qwen/'.length);
      model = 'qwen/qwen3-next-80b-a3b-instruct';
    }
    return handleTranslateRequest(c, urlPath, /* force */ false, /* provider */ 'nvidia', model);
  });

  // ── MiMo 翻译：使用 MiMo Auto 免费 API ──────────
  app.get('/mimo/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/mimo/'.length));
    return handleTranslateRequest(c, raw, /* force */ false, /* provider */ 'mimo');
  });

  // ── Gemini 翻译：使用 Google Gemini 原生 API ──────────
  // /gemini/{url} → gemini-3.1-flash-lite
  app.get('/gemini/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/gemini/'.length));
    return handleTranslateRequest(c, raw, /* force */ false, /* provider */ 'gemini', 'gemini-3.1-flash-lite');
  });

  // ── OpenCode 翻译：使用 opencode.ai/zen OpenAI 兼容 API ──────────
  // /oc/{url} → big-pickle 模型
  app.get('/oc/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/oc/'.length));
    return handleTranslateRequest(c, raw, /* force */ false, /* provider */ 'opencode');
  });

  // ── Cloudflare AI 翻译：通过 CF REST API 调用 Workers AI ──────────
  app.get('/cf/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/cf/'.length));
    return handleTranslateRequest(c, raw, /* force */ false, /* provider */ 'cloudflare');
  });

  // ── 原始页面：抓取 URL 并返回原始 HTML，不做翻译 ──────────
  // /original/{url} 和 /o/{url} 是别名
  // 使用 <base> 标签让浏览器原生解析相对 URL
  async function handleOriginalRequest(c: any, rawPath: string) {
    if (!rawPath) {
      return c.json({ error: 'target url is required' }, 400);
    }
    const normalized = normalizeUrl(rawPath);
    if (!normalized) {
      return c.json({ error: 'target url is empty after normalization' }, 400);
    }
    const url = `https://${normalized}`;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return c.json({ error: 'url is not a valid URL' }, 400);
    }
    // SSRF 防护：拒绝私网/保留/链路本地地址
    try {
      assertPublicUrl(url);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    try {
      const { parseHTML } = await import('linkedom');
      const { fetchPage } = await import('./translate/urlFetcher');
      const page = await fetchPage(url);

      // 注入 <base> 标签让浏览器原生解析相对 URL（图片、链接等）。
      // 原页面若把 <base> 放在相对 CSS/JS 之后，必须移到 <head> 最前面，
      // 否则浏览器仍用当前页面地址解析这些资源（如 arxiv / ar5iv）。
      const baseUrl = page.finalUrl.replace(/\/?$/, '/');
      const { document } = parseHTML(page.html) as { document: Document };
      const head = document.head;
      const existingBase = document.querySelector('head > base');
      if (existingBase) {
        existingBase.setAttribute('href', baseUrl);
        if (head && head.firstChild !== existingBase) {
          head.insertBefore(existingBase, head.firstChild);
        }
      } else {
        const base = document.createElement('base');
        base.setAttribute('href', baseUrl);
        if (head) head.insertBefore(base, head.firstChild);
      }

      const html = '<!doctype html>\n' + document.documentElement.outerHTML;
      return new Response(processOriginalHtml(html), {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Original-Url': page.finalUrl,
        },
      });
    } catch (err) {
      console.error('[original] error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  app.get('/original/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/original/'.length));
    return handleOriginalRequest(c, raw);
  });

  app.get('/o/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/o/'.length));
    return handleOriginalRequest(c, raw);
  });

  // ── 术语表管理（持久层由 setDefaultStorage 注入） ─────
  app.get('/api/glossary', async (c) => {
    try {
      return c.json(await getGlossary());
    } catch (err) {
      console.error('[glossary] get error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/glossary', async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const terms = body?.terms;
    if (!Array.isArray(terms) || terms.some((t: unknown) => typeof t !== 'string')) {
      return c.json({ error: 'terms: string[] required' }, 400);
    }
    try {
      return c.json(await addUserTerms(terms));
    } catch (err) {
      console.error('[glossary] add error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.delete('/api/glossary', async (c) => {
    try {
      return c.json(await clearUserTerms());
    } catch (err) {
      console.error('[glossary] clear error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.delete('/api/glossary/:term', requireAuth, async (c) => {
    const term = decodeURIComponent(c.req.param('term'));
    try {
      return c.json(await removeUserTerm(term));
    } catch (err) {
      console.error('[glossary] remove error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/glossary/extract', async (c) => {
    const { text } = await c.req.json().catch(() => ({} as any));
    if (!text || typeof text !== 'string') {
      return c.json({ error: 'text is required' }, 400);
    }
    try {
      const extract = await getExtractor();
      const result = extract(text);
      const merge = c.req.query('merge') === 'true';
      if (merge) {
        const g = await addUserTerms(result.document_terms);
        console.log(`[glossary/extract] text=${text.length}ch → ${result.document_terms.length} terms (merged)`);
        return c.json(g);
      } else {
        const g = await setDocumentTerms(result.document_terms);
        console.log(`[glossary/extract] text=${text.length}ch → ${result.document_terms.length} terms`);
        return c.json(g);
      }
    } catch (err) {
      console.error('[glossary/extract] error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.put('/api/glossary/document', async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const terms = body?.terms;
    if (!Array.isArray(terms) || terms.some((t: unknown) => typeof t !== 'string')) {
      return c.json({ error: 'terms: string[] required' }, 400);
    }
    try {
      return c.json(await setDocumentTerms(terms));
    } catch (err) {
      console.error('[glossary/document] put error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.delete('/api/glossary/document', requireAuth, async (c) => {
    try {
      return c.json(await clearDocumentTerms());
    } catch (err) {
      console.error('[glossary/document] clear error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  return app;
}
