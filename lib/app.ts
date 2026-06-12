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

/**
 * 实际请求处理时再读 AUTH_KEY，不在模块加载时校验：
 *   - CF Workers 模块在 isolate 启动期 eager 加载，shim 的 env 绑定
 *     要等请求来才可用，模块顶层就 process.env 读不到。
 *   - 改成"首次请求时 warn 但不 throw"，等调用方需要鉴权时再校验。
 * 鉴权逻辑封装在 lib/auth.ts 的 `requireAuth` middleware，路由直接挂上即可。
 */

// ── LLM 代理上游配置 ────────────────────────────────────────
// 必须 lazy 读 process.env：CF Workers 启动期 wrangler 还没把 .dev.vars 注入
// process.env（只在 fetch handler 的 env 参数里给），所以模块顶层 const 会读到空串。
// src/worker.ts 的 injectEnv() 在首个请求时把 env → process.env 同步一次，之后
// 这些 getter 就能拿到真值。和 AUTH_KEY 一样 per-request 拿，不要放回顶层 const。
const CF_ACCOUNT_ID      = (): string => process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CF_API_TOKEN       = (): string => process.env.CLOUDFLARE_API_TOKEN || '';
const DS_API_KEY         = (): string => process.env.DEEPSEEK_API_KEY || '';
const NVIDIA_API_KEY     = (): string => process.env.NVIDIA_API_KEY || '';
const OPENROUTER_API_KEY = (): string => process.env.OPENROUTER_API_KEY || '';

// CF_BASE 也得是函数，因为依赖 CF_ACCOUNT_ID()（lazy 读 env）
const CF_BASE         = (): string => `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID()}/ai`;
const DS_BASE         = 'https://api.deepseek.com';
const NVIDIA_BASE     = 'https://integrate.api.nvidia.com';
const OPENROUTER_BASE = 'https://openrouter.ai/api';

const DS_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const BACKENDS  = new Set(['deepseek', 'cloudflare', 'nvidia', 'openrouter']);

function resolveModel(model: string | undefined, backendHint: string | undefined) {
  if (backendHint) {
    if (!BACKENDS.has(backendHint)) {
      return { error: `unknown _backend: ${backendHint}` };
    }
    if (backendHint === 'deepseek') {
      return { backend: 'deepseek', model: DS_MODELS.has(model ?? '') ? model! : 'deepseek-v4-flash' };
    }
    return { backend: backendHint, model: model! };
  }
  if (model && model.startsWith('nvidia/')) return { backend: 'nvidia',     model };
  if (model && model.includes(':'))        return { backend: 'openrouter', model };
  if (model && model.includes('/'))        return { backend: 'cloudflare', model };
  if (model && DS_MODELS.has(model))       return { backend: 'deepseek',   model };
  return { backend: 'deepseek', model: 'deepseek-v4-flash' };
}

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

  const app = new Hono();
  app.use('*', cors());

  // ── 上一次翻译的结果缓存（瞬态，仅当前 isolate 内） ──
  // 每次 /translate/* 或 /s/* 成功后写入，/ 路由读取并展示。
  let lastTranslatedHtml: string | null = null;

  // ── GET / — 展示最新一次翻译结果 ──────────────────────
  app.get('/', async (c) => {
    // 1) 内存快速路径（同一 isolate 内刚翻译过）
    if (lastTranslatedHtml) {
      return new Response(lastTranslatedHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    // 2) D1 持久化：取最新记录
    const db = (c.env as any)?.DB999;
    if (db) {
      try {
        const row: any = await db.prepare(
          'SELECT html FROM translations ORDER BY id DESC LIMIT 1'
        ).first();
        if (row) {
          lastTranslatedHtml = row.html;
          return new Response(row.html, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
      } catch (e) {
        console.error('[D1] latest fetch error:', e);
      }
    }
    // 3) 没有任何翻译记录，跳转到帮助页面
    return c.redirect('/help', 302);
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
      if (!NVIDIA_API_KEY()) {
        return c.json({ error: 'NVIDIA Build not configured' }, 500);
      }
      targetUrl = `${NVIDIA_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${NVIDIA_API_KEY()}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
    } else if (backend === 'openrouter') {
      if (!OPENROUTER_API_KEY()) {
        return c.json({ error: 'OpenRouter not configured' }, 500);
      }
      targetUrl = `${OPENROUTER_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${OPENROUTER_API_KEY()}`, 'Content-Type': 'application/json' };
    } else {
      if (!DS_API_KEY()) {
        return c.json({ error: 'DeepSeek not configured' }, 500);
      }
      targetUrl = `${DS_BASE}/v1/chat/completions`;
      headers = { Authorization: `Bearer ${DS_API_KEY()}`, 'Content-Type': 'application/json' };
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

  // ── GET /api/v1/models ────────────────────────────────
  app.get('/api/v1/models', (c) => {
    const models: any[] = [];
    if (DS_API_KEY()) {
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
    if (!DS_API_KEY()) {
      return c.json({ error: 'DeepSeek not configured' }, 500);
    }
    console.log(`[translate/text] chars=${text.length} src=${source || 'en'} tgt=${target || 'zh'}`);
    try {
      const result = await translateText({
        text,
        source,
        target,
        apiKey: DS_API_KEY(),
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
   * 公共翻译 handler，供 /translate/* 和 /s/* 使用。
   */
  async function handleTranslateRequest(c: any, rawPath: string) {
    if (!rawPath) {
      return c.json({ error: 'target url is required in path' }, 400);
    }

    // 剥 scheme（兼容用户传过来时含/不含 https:// 的两种写法）
    const stripped = rawPath.replace(/^https?:\/\//i, '');
    if (!stripped) {
      return c.json({ error: 'target url is empty after stripping scheme' }, 400);
    }
    const url = `https://${stripped}`;

    const source = c.req.query('source');
    const target = c.req.query('target') || 'zh';
    const mode = c.req.query('mode') || 'bilingual';

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
    if (!DS_API_KEY()) {
      return c.json({ error: 'DeepSeek not configured' }, 500);
    }

    console.log(`[translate/url-page] url=${url} src=${source || 'en'} tgt=${target} mode=${mode}`);

    // ── D1 去重：同 URL+source+target 已存在则直接返回 ──
    const db = (c.env as any)?.DB999;
    const sourceStored = source || 'en';
    if (db) {
      try {
        const existing: any = await db.prepare(
          'SELECT html FROM translations WHERE url = ? AND source_lang = ? AND target_lang = ? LIMIT 1'
        ).bind(url, sourceStored, target).first();
        if (existing) {
          console.log(`[translate/url-page] D1 cache hit for ${url}`);
          lastTranslatedHtml = existing.html;
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
      // CF Workers HTTP 请求无 wall-clock 限制，只需每调用 DeepSeek
      // 的 15s timeout（deepseek.ts DEEPSEEK_TIMEOUT_MS）防 hung promise。
      // 见 https://developers.cloudflare.com/workers/platform/limits/#duration
      const result = await translateUrl({
        url,
        source,
        target,
        mode: mode as 'bilingual' | 'target',
        apiKey: DS_API_KEY(),
      });
      console.log(`[translate/url-page] blocks=${result.blocks} chunks=${result.chunks} duration=${result.duration_ms}ms`);
      // 缓存翻译结果，供 / 路由展示
      lastTranslatedHtml = result.html;
      // 写入 D1（同一 URL+source+target 再次请求时直接读，不再翻译）
      if (db) {
        try {
          await db.prepare(
            'INSERT OR IGNORE INTO translations (url, source_lang, target_lang, html) VALUES (?, ?, ?, ?)'
          ).bind(url, sourceStored, target, result.html).run();
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
    const raw = decodeURIComponent(c.req.path.slice('/s/'.length));
    if (!raw) {
      return c.json({ error: 'target is required after /s/' }, 400);
    }

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
