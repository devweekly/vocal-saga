/**
 * 剩余 Hono 路由单测：hello、models、text 翻译、术语表 CRUD。
 *
 * glossaryStore 在模块顶层 mock，不影响其他 test file（vitest 文件级隔离）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(),
  translateText: vi.fn(),
}));

vi.mock('../lib/translate/glossaryStore', () => ({
  getGlossary: vi.fn(),
  addUserTerms: vi.fn(),
  removeUserTerm: vi.fn(),
  clearUserTerms: vi.fn(),
  setDocumentTerms: vi.fn(),
  clearDocumentTerms: vi.fn(),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

function mockClearAll(...mocks: any[]) {
  for (const m of mocks) m.mockClear();
}

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:app-routes-' + Math.random().toString(36).slice(2)));
  const { translateUrl, translateText } = await import('../lib/translate/pipeline');
  mockClearAll(translateUrl, translateText);
  (translateUrl as any).mockResolvedValue({
    html: '<html><body>ok</body></html>',
    title: 'Test',
    blocks: 1, chunks: 1, duration_ms: 10,
  });

  const gs = await import('../lib/translate/glossaryStore');
  mockClearAll(gs.getGlossary, gs.addUserTerms, gs.removeUserTerm, gs.clearUserTerms, gs.setDocumentTerms, gs.clearDocumentTerms);
});

function buildApp() {
  return createApp();
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://test${path}`, init || {});
}

// ─── GET /api/hello ──────────────────────────────────────────
describe('GET /api/hello', () => {
  it('returns default greeting', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/hello'));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.message).toBe('Hello, world!');
    expect(body.timestamp).toBeDefined();
  });

  it('honors ?name= param', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/hello?name=Test'));
    const body: any = await res.json();
    expect(body.message).toBe('Hello, Test!');
  });
});

// ─── GET /api/v1/models ──────────────────────────────────────
describe('GET /api/v1/models', () => {
  it('lists deepseek models when DEEPSEEK_API_KEY is set', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/v1/models'));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    for (const m of body.data) {
      expect(m.object).toBe('model');
      expect(['deepseek-v4-flash', 'deepseek-v4-pro']).toContain(m.id);
    }
  });

  it('returns models list', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/v1/models'));
    const body: any = await res.json();
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThanOrEqual(0);
  });
});

// ─── POST /api/v1/chat/completions ───────────────────────────
describe('POST /api/v1/chat/completions backend config', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'cf-account';
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    process.env.NVIDIA_API_KEY = 'nv-token';
    process.env.OPENROUTER_API_KEY = 'or-token';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl-test',
      choices: [{ message: { content: 'ok' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  function chatReq(body: Record<string, unknown>): Request {
    return req('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-auth-key-123456',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        ...body,
      }),
    });
  }

  it('uses Cloudflare account id and API token values', async () => {
    const app = buildApp();
    const res = await app.request(chatReq({ _backend: 'cloudflare', model: '@cf/meta/llama' }));
    expect(res.status).toBe(200);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/cf-account/ai/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer cf-token');
  });

  it('uses NVIDIA API key value', async () => {
    const app = buildApp();
    const res = await app.request(chatReq({ _backend: 'nvidia', model: 'nvidia/test-model' }));
    expect(res.status).toBe(200);

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer nv-token');
  });

  it('uses OpenRouter API key value', async () => {
    const app = buildApp();
    const res = await app.request(chatReq({ _backend: 'openrouter', model: 'openai/gpt-oss:free' }));
    expect(res.status).toBe(200);

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer or-token');
  });

  it('uses NVIDIA service', async () => {
    const app = buildApp();
    const res = await app.request(chatReq({ _backend: 'nvidia', model: 'nvidia/test-model' }));
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
});

// ─── POST /api/translate/text ─────────────────────────────────
describe('POST /api/translate/text', () => {
  it('translates text via pipeline', async () => {
    const { translateText } = await import('../lib/translate/pipeline');
    (translateText as any).mockResolvedValue({
      translations: [{ id: 't1', original: 'hello', translated: '你好' }],
      chunks: 1,
      duration_ms: 10,
    });

    const app = buildApp();
    const res = await app.request(req('/api/translate/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', source: 'en', target: 'zh' }),
    }));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.translations[0].translated).toBe('你好');
  });

  it('400 when text is missing', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/translate/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
  });

  it('400 when text is not a string', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/translate/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 123 }),
    }));
    expect(res.status).toBe(400);
  });

  it('500 when translateText throws', async () => {
    const { translateText } = await import('../lib/translate/pipeline');
    (translateText as any).mockRejectedValueOnce(new Error('boom'));

    const app = buildApp();
    const res = await app.request(req('/api/translate/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    }));
    expect(res.status).toBe(500);
    const body: any = await res.json();
    expect(body.error).toBe('boom');
  });
});

// ─── Glossary API ────────────────────────────────────────────
describe('Glossary API', () => {
  it('GET /api/glossary returns terms', async () => {
    const gs = await import('../lib/translate/glossaryStore');
    (gs.getGlossary as any).mockResolvedValue({ user_terms: ['React'], document_terms: ['LLM'] });

    const app = buildApp();
    const res = await app.request(req('/api/glossary'));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.user_terms).toEqual(['React']);
  });

  it('GET /api/glossary 500 on store error', async () => {
    const gs = await import('../lib/translate/glossaryStore');
    (gs.getGlossary as any).mockRejectedValueOnce(new Error('store error'));

    const app = buildApp();
    const res = await app.request(req('/api/glossary'));
    expect(res.status).toBe(500);
  });

  it('POST /api/glossary adds terms', async () => {
    const gs = await import('../lib/translate/glossaryStore');
    (gs.addUserTerms as any).mockResolvedValue({ user_terms: ['React'] });

    const app = buildApp();
    const res = await app.request(req('/api/glossary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms: ['React'] }),
    }));
    expect(res.status).toBe(200);
  });

  it('POST /api/glossary 400 when terms is not string[]', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/glossary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms: 'not-an-array' }),
    }));
    expect(res.status).toBe(400);
  });

  it('POST /api/glossary 400 when terms contains non-string', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/glossary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms: ['valid', 123] }),
    }));
    expect(res.status).toBe(400);
  });

  it('DELETE /api/glossary clears terms', async () => {
    const gs = await import('../lib/translate/glossaryStore');
    (gs.clearUserTerms as any).mockResolvedValue({ user_terms: [] });

    const app = buildApp();
    const res = await app.request(req('/api/glossary', { method: 'DELETE' }));
    expect(res.status).toBe(200);
  });

  it('DELETE /api/glossary/:term requires auth', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/glossary/React', { method: 'DELETE' }));
    expect(res.status).toBe(401);
  });

  it('DELETE /api/glossary/:term removes term with valid auth', async () => {
    const gs = await import('../lib/translate/glossaryStore');
    (gs.removeUserTerm as any).mockResolvedValue({ user_terms: [] });

    const app = buildApp();
    const res = await app.request(req('/api/glossary/React', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-auth-key-123456' },
    }));
    expect(res.status).toBe(200);
  });

  it('PUT /api/glossary/document sets document terms', async () => {
    const gs = await import('../lib/translate/glossaryStore');
    (gs.setDocumentTerms as any).mockResolvedValue({ document_terms: ['LLM'] });

    const app = buildApp();
    const res = await app.request(req('/api/glossary/document', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms: ['LLM'] }),
    }));
    expect(res.status).toBe(200);
  });

  it('DELETE /api/glossary/document requires auth', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/glossary/document', { method: 'DELETE' }));
    expect(res.status).toBe(401);
  });

  it('app.notFound returns 404 for unknown routes', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/nonexistent'));
    expect(res.status).toBe(404);
  });
});
