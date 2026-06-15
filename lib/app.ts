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
import { translateText, translateUrl } from './translate/pipeline';
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
import { normalizeUrl, cacheKeyUrl } from './urlUtils';
import {
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
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
  getDSApiKey,
  getOpenrouterApiKey,
  getNvidiaApiKey,
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
export function createApp(storage?: StorageAdapter): Hono {
  if (storage) setDefaultStorage(storage);

  // 从环境变量设置 API keys（模块级变量）
  const dsKey = process.env.DEEPSEEK_API_KEY || '';
  const openrouterKey = process.env.OPENROUTER_API_KEY || '';
  const nvidiaKey = process.env.NVIDIA_API_KEY || '';
  if (dsKey) setDSApiKey(dsKey);
  if (openrouterKey) setOpenrouterApiKey(openrouterKey);
  if (nvidiaKey) setNvidiaApiKey(nvidiaKey);

  // 简单的 HTML 转义，防止列表页 title XSS
  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const app = new Hono();
  app.use('*', cors());

  app.get('/', async (c) => {
    const db = (c.env as any)?.DB999;
    const rows: any[] = [];

    if (db) {
      try {
        const result = await db.prepare(
          'SELECT id, url, title, source_lang, target_lang FROM translations ORDER BY id DESC LIMIT 10'
        ).all();
        if (result.results) rows.push(...result.results);
      } catch (e) {
        console.error('[D1] list error:', e);
      }
    }

    // 构建 HTML 列表页
    const items = rows.map((r: any) => {
      const url = `${r.url}`;
      const displayTitle = r.title || r.url;
      const lang = `${r.source_lang || 'en'} → ${r.target_lang || 'zh'}`;
      return `<li style="margin-bottom:16px;line-height:1.6">
        <a href="/${r.id}" style="font-size:16px;text-decoration:none;color:#2563eb;font-weight:500">${escapeHtml(displayTitle)}</a>
        <span style="color:#6b7280;margin-left:8px;font-size:13px">${lang}</span>
        <br><a href="${url}" target="_blank" rel="noopener" style="color:#9ca3af;font-size:12px;text-decoration:none">${r.url}</a>
      </li>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>翻译记录</title>
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
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  });

  // ── GET /<id> — 从 D1 取出第 N 次翻译结果展示 ────────
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^\d+$/.test(id)) return c.notFound();
    const db = (c.env as any)?.DB999;
    if (!db) return c.json({ error: 'D1 not available' }, 500);
    try {
      const row: any = await db.prepare(
        'SELECT html FROM translations WHERE id = ?'
      ).bind(Number(id)).first();
      if (!row) return c.json({ error: 'translation not found' }, 404);
      return new Response(row.html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
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
      if (!CF_ACCOUNT_ID() || !CF_API_TOKEN()) {
        return c.json({ error: 'Cloudflare AI not configured' }, 500);
      }
      targetUrl = `${CF_BASE()}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${CF_API_TOKEN()}`, 'Content-Type': 'application/json' };
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

  // ── POST /fanyi ───────────────────────────────────────
  // fanyi-extension 代理：接收浏览器扩展的翻译请求，直接转发给 DeepSeek API，
  // 不做任何额外处理（不鉴权、不改 prompt、不改参数）。
  // 需要 DEEPSEEK_API_KEY 环境变量或 wrangler secret。
  app.post('/fanyi', async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const { stream, messages } = body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: 'messages is required' }, 400);
    }
    if (!getDSApiKey()) {
      return c.json({ error: 'DeepSeek not configured' }, 500);
    }

    console.log(`[fanyi] stream=${!!stream} msgs=${messages.length}`);

    const startedAt = Date.now();
    try {
      const upstream = await fetch(`${DS_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getDSApiKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const latency = Date.now() - startedAt;

      if (!upstream.ok) {
        const errText = await upstream.text();
        console.error(`[fanyi] status=${upstream.status} latency=${latency}ms err=${errText}`);
        return c.json(
          { error: 'Upstream DeepSeek error', detail: errText },
          upstream.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503
        );
      }

      if (stream && upstream.body) {
        console.log(`[fanyi] status=${upstream.status} latency=${latency}ms stream=started`);
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

      // 非流式：透传完整 JSON 响应
      const data = (await upstream.json()) as Record<string, any>;
      const usage = data.usage;
      console.log(`[fanyi] status=${upstream.status} latency=${latency}ms` +
        (usage ? ` tokens_in=${usage.prompt_tokens} tokens_out=${usage.completion_tokens}` : ''));
      return c.json(data);
    } catch (err) {
      console.error(`[fanyi] error="${(err as Error).message}" latency=${Date.now() - startedAt}ms`);
      return c.json({ error: 'Upstream request failed', detail: (err as Error).message }, 502);
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
    const { text, source, target, glossary } = await c.req.json().catch(() => ({} as any));
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
      });
      console.log(`[translate/text] chunks=${result.chunks} duration=${result.duration_ms}ms`);
      return c.json(result);
    } catch (err) {
      console.error('[translate/text] error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /**
   * 公共翻译 handler，供 /translate/*、/s/*、/force/*、/openrt/*、/nvd/* 使用。
   * @param force 跳过 D1 缓存，强制重新翻译并覆盖写入
   * @param service 翻译服务：'deepseek'（默认）、'openrouter' 或 'nvidia'
   * @param model 可选模型名（用于 NVIDIA 等多模型服务）
   */
  async function handleTranslateRequest(c: any, rawPath: string, force = false, service: 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare' = 'deepseek', model?: string) {
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
    const mode = c.req.query('mode') || 'bilingual';

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
    if (mode !== 'bilingual' && mode !== 'target') {
      return c.json({ error: 'mode must be bilingual or target' }, 400);
    }
    console.log(`[translate/url-page] url=${url} src=${sourceStored} tgt=${targetStored} mode=${mode} force=${force}`);

    // ── D1 去重：同 URL+source+target 已存在则直接返回（force 模式跳过） ──
    // 用 cacheKeyUrl 标准化：www.example.com 和 example.com 命中同一缓存
    const db = (c.env as any)?.DB999;
    const cacheKey = cacheKeyUrl(url);
    if (db && !force) {
      try {
        const existing: any = await db.prepare(
          'SELECT html FROM translations WHERE url = ? AND source_lang = ? AND target_lang = ? LIMIT 1'
        ).bind(cacheKey, sourceStored, targetStored).first();
        if (existing) {
          console.log(`[translate/url-page] D1 cache hit for ${url}`);
          return new Response(existing.html, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=3600',
              'X-Translate-Source': 'd1-cache',
            },
          });
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
        mode: mode as 'bilingual' | 'target',
        service,
        model,
      });
      console.log(`[translate/url-page] blocks=${result.blocks} translated=${result.translatedBlocks} chunks=${result.chunks} duration=${result.duration_ms}ms`);

      // 翻译 0 个 block → 服务端翻译失败，不缓存 D1，返回错误
      if (result.translatedBlocks === 0 && result.blocks > 0) {
        return c.json({
          error: 'Translation produced no results',
          detail: `${result.blocks} blocks extracted but 0 translated — service may be unavailable or prompt was filtered`,
        }, 500);
      }

      // 写入 D1（force 模式用 INSERT OR REPLACE 覆盖已有记录）
      // 用 cacheKey 存储：www 和非 www 共享同一缓存
      if (db) {
        try {
          if (force) {
            // 先删旧记录，再插入新记录（D1 没有 UPSERT，用 REPLACE 模拟）
            await db.prepare(
              'DELETE FROM translations WHERE url = ? AND source_lang = ? AND target_lang = ?'
            ).bind(cacheKey, sourceStored, targetStored).run();
          }
          await db.prepare(
            'INSERT OR IGNORE INTO translations (url, title, source_lang, target_lang, html) VALUES (?, ?, ?, ?, ?)'
          ).bind(cacheKey, result.title || '', sourceStored, targetStored, result.html).run();
        } catch (e) {
          console.error('[D1] save error:', e);
        }
      }
      return new Response(result.html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          // 翻译结果比原页面更"耐用"，给个 1h 客户端缓存
          'Cache-Control': 'public, max-age=3600',
          // 暴露给浏览器方便看耗时 / 命中情况
          'X-Translate-Blocks': String(result.blocks),
          'X-Translate-Chunks': String(result.chunks),
          'X-Translate-Duration-Ms': String(result.duration_ms),
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
   *   - mode: bilingual（默认）| target（仅译）
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
  const FORCE_RATE_LIMIT_MS = 60_000; // 1 分钟

  app.get('/force/*', (c) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const last = forceRateLimit.get(ip) || 0;
    if (now - last < FORCE_RATE_LIMIT_MS) {
      const retryAfter = Math.ceil((FORCE_RATE_LIMIT_MS - (now - last)) / 1000);
      return c.json({ error: `Rate limit: 1 request per minute. Retry after ${retryAfter}s` }, 429);
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
    return handleTranslateRequest(c, raw, /* force */ false, /* service */ 'openrouter');
  });

  // ── NVIDIA 翻译：使用 build.nvidia.com ──────────
  // /nvd/{url} → moonshotai/kimi-k2.6
  // /nvd/deepseek/{url} → deepseek-ai/deepseek-v4-flash
  // /nvd/qwen/{url} → qwen/qwen3-next-80b-a3b-instruct
  app.get('/nvd/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/nvd/'.length));
    let urlPath = raw;
    let model: string | undefined = 'moonshotai/kimi-k2.6';
    if (raw.startsWith('deepseek/')) {
      urlPath = raw.slice('deepseek/'.length);
      model = 'deepseek-ai/deepseek-v4-flash';
    } else if (raw.startsWith('qwen/')) {
      urlPath = raw.slice('qwen/'.length);
      model = 'qwen/qwen3-next-80b-a3b-instruct';
    }
    return handleTranslateRequest(c, urlPath, /* force */ false, /* service */ 'nvidia', model);
  });

  // ── Cloudflare AI 翻译：使用 CF Workers AI 的免费模型 ──────────
  app.get('/cf/*', async (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/cf/'.length));
    const ai = (c.env as any)?.AI999;
    if (!ai) {
      return c.json({ error: 'Cloudflare AI not configured' }, 500);
    }
    // 设置模块级 AI binding
    const { setAI } = await import('./config');
    setAI(ai);
    return handleTranslateRequest(c, raw, /* force */ false, /* service */ 'cloudflare');
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

    try {
      const { parseHTML } = await import('linkedom');
      const { fetchPage } = await import('./translate/urlFetcher');
      const page = await fetchPage(url);

      // 注入 <base> 标签让浏览器原生解析相对 URL（图片、链接等）
      const baseUrl = page.finalUrl.replace(/\/?$/, '/');
      const { document } = parseHTML(page.html) as { document: Document };
      const existingBase = document.querySelector('head > base');
      if (existingBase) {
        existingBase.setAttribute('href', baseUrl);
      } else {
        const base = document.createElement('base');
        base.setAttribute('href', baseUrl);
        const head = document.head;
        if (head) head.insertBefore(base, head.firstChild);
      }

      const html = '<!doctype html>\n' + document.documentElement.outerHTML;
      return new Response(html, {
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
