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
  DS_API_KEY,
  NVIDIA_API_KEY,
  OPENROUTER_API_KEY,
  CF_BASE,
  DS_BASE,
  NVIDIA_BASE,
  OPENROUTER_BASE,
  DS_MODELS,
  resolveModel,
} from './modelResolver';

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
   * 公共翻译 handler，供 /translate/*、/s/*、/force/*、/openrt/* 使用。
   * @param force 跳过 D1 缓存，强制重新翻译并覆盖写入
   * @param service 翻译服务：'deepseek'（默认）或 'openrouter'
   */
  async function handleTranslateRequest(c: any, rawPath: string, force = false, service: 'deepseek' | 'openrouter' = 'deepseek') {
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

    console.log(`[translate/url-page] url=${url} src=${source || 'en'} tgt=${target} mode=${mode} force=${force}`);

    // ── D1 去重：同 URL+source+target 已存在则直接返回（force 模式跳过） ──
    // 用 cacheKeyUrl 标准化：www.example.com 和 example.com 命中同一缓存
    const db = (c.env as any)?.DB999;
    const sourceStored = source || 'en';
    const cacheKey = cacheKeyUrl(url);
    if (db && !force) {
      try {
        const existing: any = await db.prepare(
          'SELECT html FROM translations WHERE url = ? AND source_lang = ? AND target_lang = ? LIMIT 1'
        ).bind(cacheKey, sourceStored, target).first();
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
      // 根据 service 选择 API key
      const apiKey = service === 'openrouter' ? OPENROUTER_API_KEY() : DS_API_KEY();
      if (!apiKey) {
        const serviceName = service === 'openrouter' ? 'OpenRouter' : 'DeepSeek';
        return c.json({ error: `${serviceName} API key not configured` }, 500);
      }

      const result = await translateUrl({
        url,
        source,
        target,
        mode: mode as 'bilingual' | 'target',
        apiKey,
        service,
      });
      console.log(`[translate/url-page] blocks=${result.blocks} chunks=${result.chunks} duration=${result.duration_ms}ms`);
      // 缓存翻译结果，供 / 路由展示
      lastTranslatedHtml = result.html;
      // 写入 D1（force 模式用 INSERT OR REPLACE 覆盖已有记录）
      // 用 cacheKey 存储：www 和非 www 共享同一缓存
      if (db) {
        try {
          if (force) {
            // 先删旧记录，再插入新记录（D1 没有 UPSERT，用 REPLACE 模拟）
            await db.prepare(
              'DELETE FROM translations WHERE url = ? AND source_lang = ? AND target_lang = ?'
            ).bind(cacheKey, sourceStored, target).run();
          }
          await db.prepare(
            'INSERT INTO translations (url, source_lang, target_lang, html) VALUES (?, ?, ?, ?)'
          ).bind(cacheKey, sourceStored, target, result.html).run();
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

  // ── OpenRouter 免费模型翻译：使用 nvidia/nemotron-3-nano-30b-a3b ──────────
  app.get('/openrt/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/openrt/'.length));
    return handleTranslateRequest(c, raw, /* force */ false, /* service */ 'openrouter');
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
