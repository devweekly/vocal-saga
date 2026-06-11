/**
 * 平台无关的 Hono 应用工厂。
 *
 * 入口（Netlify Functions / Cloudflare Pages）在启动时构造一个 StorageAdapter
 * （NetlifyBlobsStorage / CloudflareKVStorage / MapStorage），调本工厂拿到 Hono app。
 *
 * Hono 在 Workers 上零开销直接跑，在 Node 端通过 hono/aws-lambda 适配。
 */

import { Hono, type Context } from 'hono';
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

/**
 * 读取 env 的统一入口：
 *   - CF Pages：bindings 通过 `c.env` 进来（Hono 第二参数）
 *   - Netlify / 本地：Lambda / Node 把 env 写到 process.env
 * 都检查一遍，c.env 优先。这样 lib/app.ts 不用关心平台 shim 的注入方式。
 */
function env(c: Context, key: string): string | undefined {
  const fromBinding = (c.env as Record<string, string | undefined> | undefined)?.[key];
  if (fromBinding) return fromBinding;
  return process.env[key];
}

/**
 * 实际请求处理时再读 AUTH_KEY，不在模块加载时校验：
 *   - CF Pages 模块在 isolate 启动期 eager 加载，shim 的 env 绑定
 *     要等请求来才可用，模块顶层就 process.env 读不到。
 *   - 改成"首次请求时 warn 但不 throw"，等调用方需要鉴权时再校验。
 */
function getAuthKey(c: Context): string {
  const k = env(c, 'AUTH_KEY') || '';
  if (!k || k.length < 6) {
    throw new Error('AUTH_KEY is required and must be at least 6 characters');
  }
  return k;
}

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

function checkAuth(c: Context): boolean {
  let expected: string;
  try {
    expected = getAuthKey(c);
  } catch {
    return false;
  }
  const bearer = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  return bearer === expected;
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

  // ── POST /api/v1/chat/completions ─────────────────────
  app.post('/api/v1/chat/completions', async (c) => {
    if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);

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
      if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
        return c.json({ error: 'Cloudflare AI not configured' }, 500);
      }
      targetUrl = `${CF_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' };
    } else if (backend === 'nvidia') {
      if (!NVIDIA_API_KEY) {
        return c.json({ error: 'NVIDIA Build not configured' }, 500);
      }
      targetUrl = `${NVIDIA_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${NVIDIA_API_KEY}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
    } else if (backend === 'openrouter') {
      if (!OPENROUTER_API_KEY) {
        return c.json({ error: 'OpenRouter not configured' }, 500);
      }
      targetUrl = `${OPENROUTER_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' };
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
    if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
    const { text, source, target, glossary } = await c.req.json().catch(() => ({} as any));
    if (!text || typeof text !== 'string') {
      return c.json({ error: 'text is required' }, 400);
    }
    if (!DS_API_KEY()) {
      return c.json({ error: 'DeepSeek not configured' }, 500);
    }
    console.log(`[translate/text] chars=${text.length} src=${source || 'auto'} tgt=${target || 'zh'}`);
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

  app.post('/api/translate/url', async (c) => {
    if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
    const { url, source, target, mode, glossary } = await c.req.json().catch(() => ({} as any));
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }
    if (!DS_API_KEY()) {
      return c.json({ error: 'DeepSeek not configured' }, 500);
    }
    console.log(`[translate/url] url=${url} src=${source || 'auto'} tgt=${target || 'zh'} mode=${mode || 'bilingual'}`);
    try {
      const result = await translateUrl({
        url,
        source,
        target,
        mode,
        apiKey: DS_API_KEY(),
        glossary,
      });
      console.log(`[translate/url] blocks=${result.blocks} chunks=${result.chunks} duration=${result.duration_ms}ms`);
      return c.json(result);
    } catch (err) {
      console.error('[translate/url] error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /**
   * GET /api/translate/url?url=<TARGET>&source=auto&target=zh&mode=bilingual
   *
   * 直接把目标 URL 抓下来 + 翻译 + 双语回填，返回渲染好的 HTML。
   * 浏览器访问即可看到双语对照页（保留原页面所有样式，仅在翻译处加 .fanyi-translation span）。
   *
   * Query params:
   *   - url: 必填，目标 http(s) URL
   *   - source / target: ISO 代码，默认 auto / zh
   *   - mode: bilingual（默认，原+译）| target（仅译）
   *   - glossary: 暂未支持（POST 版本有），需要时再加
   *
   * Auth: 仍走 Authorization header（checkAuth）。浏览器原生 GET 无法带 header，
   *       需要在 DevTools/扩展/curl 注入。auth-from-query 故意不开（会进 access log）。
   */
  app.get('/api/translate/url', async (c) => {
    if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);

    const url = c.req.query('url');
    const source = c.req.query('source');
    const target = c.req.query('target') || 'zh';
    const mode = c.req.query('mode') || 'bilingual';

    if (!url) {
      return c.json({ error: 'url query param is required' }, 400);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return c.json({ error: 'url is not a valid URL' }, 400);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.json({ error: 'url must be http or https' }, 400);
    }
    if (mode !== 'bilingual' && mode !== 'target') {
      return c.json({ error: 'mode must be bilingual or target' }, 400);
    }
    if (!DS_API_KEY()) {
      return c.json({ error: 'DeepSeek not configured' }, 500);
    }

    console.log(`[translate/url-page] url=${url} src=${source || 'auto'} tgt=${target} mode=${mode}`);
    try {
      const result = await translateUrl({
        url,
        source,
        target,
        mode: mode as 'bilingual' | 'target',
        apiKey: DS_API_KEY(),
      });
      console.log(`[translate/url-page] blocks=${result.blocks} chunks=${result.chunks} duration=${result.duration_ms}ms`);
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
  });

  // ── 术语表管理（持久层由 setDefaultStorage 注入） ─────
  app.get('/api/glossary', async (c) => {
    if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
    try {
      return c.json(await getGlossary());
    } catch (err) {
      console.error('[glossary] get error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/glossary', async (c) => {
    if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
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
    if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
    try {
      return c.json(await clearUserTerms());
    } catch (err) {
      console.error('[glossary] clear error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.delete('/api/glossary/:term', async (c) => {
    if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
    const term = decodeURIComponent(c.req.param('term'));
    try {
      return c.json(await removeUserTerm(term));
    } catch (err) {
      console.error('[glossary] remove error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/glossary/extract', async (c) => {
    if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
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
    if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
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

  app.delete('/api/glossary/document', async (c) => {
    if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
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
