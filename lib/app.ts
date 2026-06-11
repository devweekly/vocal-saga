/**
 * 平台无关的 Express 应用工厂。
 *
 * 入口（Netlify / Cloudflare Pages）在启动时构造一个 StorageAdapter
 * （NetlifyBlobsStorage / CloudflareKVStorage），调本工厂拿到 Express app。
 *
 * Express app 是无状态对象（路由 / 中间件），可在多次冷启动间共享。
 */

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
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

export function createApp(storage?: StorageAdapter): Express {
  if (storage) {
    setDefaultStorage(storage);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  // ── LLM 代理 (上游 API key) ──────────────────────────
  const CF_ACCOUNT_ID      = process.env.CLOUDFLARE_ACCOUNT_ID;
  const CF_API_TOKEN       = process.env.CLOUDFLARE_API_TOKEN;
  const DS_API_KEY         = process.env.DEEPSEEK_API_KEY;
  const NVIDIA_API_KEY     = process.env.NVIDIA_API_KEY;
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

  const CF_BASE         = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai`;
  const DS_BASE         = 'https://api.deepseek.com';
  const NVIDIA_BASE     = 'https://integrate.api.nvidia.com';
  const OPENROUTER_BASE = 'https://openrouter.ai/api';

  const DS_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

  const BACKENDS = new Set(['deepseek', 'cloudflare', 'nvidia', 'openrouter']);

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

  const AUTH_KEY = process.env.AUTH_KEY || '';

  if (!AUTH_KEY || AUTH_KEY.length < 6) {
    throw new Error('AUTH_KEY is required and must be at least 6 characters');
  }

  function checkAuth(req: Request) {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return bearer === AUTH_KEY;
  }

  // ── POST /api/v1/chat/completions ─────────────────────
  app.post('/api/v1/chat/completions', async (req: Request, res: Response) => {
    if (!checkAuth(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const startedAt = Date.now();
    const { stream, _backend } = req.body || {};
    const resolved = resolveModel(req.body?.model, _backend);
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }
    req.body = { ...req.body, model: resolved.model };
    const backend = resolved.backend;

    if (backend !== 'deepseek' && !req.body.model) {
      return res.status(400).json({
        error: 'model is required for this backend',
        backend,
      });
    }

    console.log(`[req] model=${resolved.model} backend=${backend} stream=${!!stream} msgs=${req.body.messages?.length ?? 0}`);

    if (backend === 'deepseek') {
      if (req.body.thinking === undefined) {
        req.body.thinking = { type: 'disabled' };
      }
      if (req.body.temperature === undefined) {
        req.body.temperature = 0.1;
      }
      if (req.body.user_id === undefined && !req.body.user) {
        req.body.user_id = 'vocal-saga';
      }
    }

    let targetUrl: string, headers: Record<string, string>;

    if (backend === 'cloudflare') {
      if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
        return res.status(500).json({ error: 'Cloudflare AI not configured' });
      }
      targetUrl = `${CF_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' };
    } else if (backend === 'nvidia') {
      if (!NVIDIA_API_KEY) {
        return res.status(500).json({ error: 'NVIDIA Build not configured' });
      }
      targetUrl = `${NVIDIA_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${NVIDIA_API_KEY}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
    } else if (backend === 'openrouter') {
      if (!OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'OpenRouter not configured' });
      }
      targetUrl = `${OPENROUTER_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' };
    } else {
      if (!DS_API_KEY) {
        return res.status(500).json({ error: 'DeepSeek not configured' });
      }
      targetUrl = `${DS_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${DS_API_KEY}`, 'Content-Type': 'application/json' };
    }

    try {
      const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(req.body),
      });

      const latency = Date.now() - startedAt;

      if (!upstream.ok) {
        const errData = await upstream.json();
        console.error(`[resp] status=${upstream.status} latency=${latency}ms error=${JSON.stringify(errData)}`);
        return res.status(upstream.status).json(errData);
      }

      if (stream && upstream.body) {
        console.log(`[resp] status=${upstream.status} latency=${latency}ms stream=started`);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
          }
        } finally {
          reader.releaseLock();
          res.end();
          console.log(`[resp] stream=done total=${Date.now() - startedAt}ms`);
        }
        return;
      }

      const data = (await upstream.json()) as Record<string, any>;
      const usage = data.usage;
      console.log(`[resp] status=${upstream.status} latency=${latency}ms` +
        (usage ? ` tokens_in=${usage.prompt_tokens} tokens_out=${usage.completion_tokens}` : ''));
      res.json({ ...data, _backend: backend });
    } catch (err) {
      console.error(`[resp] error="${(err as Error).message}" latency=${Date.now() - startedAt}ms`);
      res.status(502).json({ error: 'Upstream request failed', detail: (err as Error).message });
    }
  });

  // ── GET /api/v1/models ────────────────────────────────
  app.get('/api/v1/models', async (_req, res) => {
    const models: any[] = [];
    if (DS_API_KEY) {
      for (const id of DS_MODELS) {
        models.push({ id, object: 'model', owned_by: 'deepseek' });
      }
    }
    res.json({ object: 'list', data: models });
  });

  // ── GET /api/hello ────────────────────────────────────
  app.get('/api/hello', (req, res) => {
    const name = req.query.name || 'world';
    res.json({ message: `Hello, ${name}!`, timestamp: new Date().toISOString() });
  });

  // ── 翻译代理 ──────────────────────────────────────────
  app.post('/api/translate/text', async (req: Request, res: Response) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { text, source, target, glossary } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    if (!DS_API_KEY) {
      return res.status(500).json({ error: 'DeepSeek not configured' });
    }
    console.log(`[translate/text] chars=${text.length} src=${source || 'auto'} tgt=${target || 'zh'}`);
    try {
      const result = await translateText({
        text,
        source,
        target,
        apiKey: DS_API_KEY,
        glossary,
      });
      console.log(`[translate/text] chunks=${result.chunks} duration=${result.duration_ms}ms`);
      res.json(result);
    } catch (err) {
      console.error('[translate/text] error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/translate/url', async (req: Request, res: Response) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { url, source, target, mode, glossary } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }
    if (!DS_API_KEY) {
      return res.status(500).json({ error: 'DeepSeek not configured' });
    }
    console.log(`[translate/url] url=${url} src=${source || 'auto'} tgt=${target || 'zh'} mode=${mode || 'bilingual'}`);
    try {
      const result = await translateUrl({
        url,
        source,
        target,
        mode,
        apiKey: DS_API_KEY,
        glossary,
      });
      console.log(`[translate/url] blocks=${result.blocks} chunks=${result.chunks} duration=${result.duration_ms}ms`);
      res.json(result);
    } catch (err) {
      console.error('[translate/url] error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── 术语表管理（持久层由 setDefaultStorage 注入） ─────
  app.get('/api/glossary', async (_req, res) => {
    if (!checkAuth(_req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const g = await getGlossary();
      res.json(g);
    } catch (err) {
      console.error('[glossary] get error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/glossary', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    const terms = (req.body as any)?.terms;
    if (!Array.isArray(terms) || terms.some((t: unknown) => typeof t !== 'string')) {
      return res.status(400).json({ error: 'terms: string[] required' });
    }
    try {
      const g = await addUserTerms(terms);
      res.json(g);
    } catch (err) {
      console.error('[glossary] add error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/glossary', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const g = await clearUserTerms();
      res.json(g);
    } catch (err) {
      console.error('[glossary] clear error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/glossary/:term', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { term } = req.params;
    try {
      const g = await removeUserTerm(decodeURIComponent(term));
      res.json(g);
    } catch (err) {
      console.error('[glossary] remove error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  let _extractGlossary: ((text: string) => { document_terms: string[] }) | null = null;
  async function getExtractor() {
    if (!_extractGlossary) {
      const mod = await import('./translate/glossaryExtractor');
      _extractGlossary = (mod as any).extractGlossaryLocal;
    }
    return _extractGlossary!;
  }

  app.post('/api/glossary/extract', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { text } = (req.body as any) || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    try {
      const extract = await getExtractor();
      const result = extract(text);
      const merge = req.query.merge === 'true';
      if (merge) {
        const g = await addUserTerms(result.document_terms);
        console.log(`[glossary/extract] text=${text.length}ch → ${result.document_terms.length} terms (merged)`);
        res.json(g);
      } else {
        const g = await setDocumentTerms(result.document_terms);
        console.log(`[glossary/extract] text=${text.length}ch → ${result.document_terms.length} terms`);
        res.json(g);
      }
    } catch (err) {
      console.error('[glossary/extract] error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put('/api/glossary/document', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    const terms = (req.body as any)?.terms;
    if (!Array.isArray(terms) || terms.some((t: unknown) => typeof t !== 'string')) {
      return res.status(400).json({ error: 'terms: string[] required' });
    }
    try {
      const g = await setDocumentTerms(terms);
      res.json(g);
    } catch (err) {
      console.error('[glossary/document] put error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/glossary/document', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const g = await clearDocumentTerms();
      res.json(g);
    } catch (err) {
      console.error('[glossary/document] clear error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
