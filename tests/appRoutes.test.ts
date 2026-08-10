/**
 * 剩余 Hono 路由单测：hello、models、text 翻译、术语表 CRUD。
 *
 * glossaryStore 在模块顶层 mock，不影响其他 test file（vitest 文件级隔离）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(),
  translateText: vi.fn(),
  translateHtml: vi.fn(),
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
import { cacheKeyUrl } from '../lib/urlUtils';
import { simpleHash } from '../lib/translate/cacheKey';

function mockClearAll(...mocks: any[]) {
  for (const m of mocks) m.mockClear();
}

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:app-routes-' + Math.random().toString(36).slice(2)));
  const { translateUrl, translateText, translateHtml } = await import('../lib/translate/pipeline');
  mockClearAll(translateUrl, translateText, translateHtml);
  (translateUrl as any).mockResolvedValue({
    html: '<html><body>ok</body></html>',
    title: 'Test',
    blocks: 1, chunks: 1, duration_ms: 10,
  });
  (translateHtml as any).mockResolvedValue({
    html: '<html><body>translated</body></html>',
    title: 'Translated',
    blocks: 2, chunks: 1, duration_ms: 20,
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

// ── mock D1 ──────────────────────────────────────────────────
interface MockRow {
  id: number;
  url: string;
  title: string;
  source_lang: string;
  target_lang: string;
  html: string;
  created_at: string;
}

function createMockDb() {
  const rows: MockRow[] = [];
  let nextId = 1;

  /** 按 id DESC 排序后的只读副本 */
  function sortedRows(): MockRow[] {
    return [...rows].sort((a, b) => b.id - a.id);
  }

  // 先定义 db，再让 prepare 内部通过闭包读取 db._insertError
  const db: {
    _rows: MockRow[];
    _insertError: string | null;
    prepare: (sql: string) => any;
  } = {
    _rows: rows,
    // 测试钩子：设为非空字符串后，下一次 INSERT 的 run() 会抛错，
    // 用于验证 D1 save 失败时是否正确 surface 给前端（header + HTML banner）
    _insertError: null,
    prepare: (_sql: string) => {
      const sql = _sql;
      // 无 bind 的查询（如 COUNT(*)、全量列表）
      const unbound = {
        all: async () => {
          if (/COUNT\(\*\)/i.test(sql)) {
            return { results: [{ total: rows.length }], success: true };
          }
          return { results: sortedRows(), success: true };
        },
        first: async () => {
          if (/COUNT\(\*\)/i.test(sql)) {
            return { total: rows.length };
          }
          return null;
        },
      };
      return {
        ...unbound,
        bind: (...args: any[]) => ({
          run: async () => {
            if (sql.trim().startsWith('INSERT')) {
              // 测试钩子：模拟 D1 save 失败（如 schema 不匹配、UNIQUE 冲突等）
              if (db._insertError) {
                throw new Error(db._insertError);
              }
              const url = args[0] as string;
              const title = args[1] as string;
              const sourceLang = args[2] as string;
              const targetLang = args[3] as string;
              const html = args[4] as string;
              const idx = rows.findIndex(
                (r) => r.url === url && r.source_lang === sourceLang && r.target_lang === targetLang,
              );
              if (idx >= 0) {
                rows[idx].title = title;
                rows[idx].html = html;
                rows[idx].created_at = new Date().toISOString();
              } else {
                rows.push({
                  id: nextId++,
                  url,
                  title,
                  source_lang: sourceLang,
                  target_lang: targetLang,
                  html,
                  created_at: new Date().toISOString(),
                });
              }
            }
            return { results: rows, success: true };
          },
          first: async () => {
            if (sql.includes('WHERE url = ? AND source_lang = ? AND target_lang = ?')) {
              const [url, sourceLang, targetLang] = args;
              const matches = rows.filter(
                (r) => r.url === url && r.source_lang === sourceLang && r.target_lang === targetLang,
              );
              if (sql.match(/ORDER\s+BY\s+created_at\s+DESC/i)) {
                matches.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
              }
              return matches[0] || null;
            }
            if (sql.includes('WHERE id = ?')) {
              const [id] = args;
              return rows.find((r) => r.id === Number(id)) || null;
            }
            return null;
          },
          all: async () => {
            // 分页查询：SELECT ... LIMIT ? OFFSET ?
            if (/LIMIT\s+\?\s+OFFSET\s+\?/i.test(sql)) {
              const limit = args[0] as number;
              const offset = args[1] as number;
              return { results: sortedRows().slice(offset, offset + limit), success: true };
            }
            return { results: sortedRows(), success: true };
          },
        }),
      };
    },
  };
  return db;
}

function envWithDb(db: any): object {
  return { DB999: db };
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

// ─── GET /fanyi/page/check ─────────────────────────────────
describe('GET /fanyi/page/check', () => {
  it('returns cached HTML when cache exists', async () => {
    const app = buildApp();
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: cacheKeyUrl('https://example.com/article'),
      title: 'Test',
      source_lang: 'en',
      target_lang: 'zh',
      // 健康缓存：保留原页面内联样式
      html: '<html><head><style>.original { color: black; }</style></head><body>cached translation<span class="fanyi-translation">译文</span></body></html>',
      content_hash: 'cached-content-hash-1',
      created_at: new Date().toISOString(),
    });

    const res = await app.request(
      req('/fanyi/page/check?url=https://example.com/article&source=en&target=zh'),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).toBe('d1-cache');
    const html = await res.text();
    expect(html).toContain('cached translation');
  });

  it('treats cache with empty content_hash as miss (cross-path pollution guard)', async () => {
    // /translate/url-page 等路径存的缓存 content_hash 为空串，其 block ID 由服务端自行分配，
    // 与扩展端 walker 编号体系不同。/fanyi/page 路径下空 content_hash 必须视为未命中（返回 204），
    // 否则扩展端按自己的 b1/b2 去查服务端缓存 → 译文错位到错误 DOM 元素。
    const app = buildApp();
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: cacheKeyUrl('https://example.com/article'),
      title: 'Test',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><style>.original { color: black; }</style></head><body>cached translation<span class="fanyi-translation">译文</span></body></html>',
      content_hash: '',
      created_at: new Date().toISOString(),
    });

    const res = await app.request(
      req('/fanyi/page/check?url=https://example.com/article&source=en&target=zh'),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(204);
  });

  it('returns 204 when cache miss', async () => {
    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page/check?url=https://example.com/article&source=en&target=zh'),
    );

    expect(res.status).toBe(204);
  });

  it('returns 204 when cached HTML is structurally unhealthy', async () => {
    // 损坏缓存（缺 <html>，也无原页面样式）应视为 miss，让扩展端 fallback 到 POST /fanyi/page
    const app = buildApp();
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: cacheKeyUrl('https://example.com/article'),
      title: 'Test',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<body><head>corrupted cached translation</body></head></html>',
      created_at: new Date().toISOString(),
    });

    const res = await app.request(
      req('/fanyi/page/check?url=https://example.com/article&source=en&target=zh'),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(204);
  });

  it('returns 204 when cached HTML lost original CSS', async () => {
    // 损坏缓存保留 <html> 但丢失原页面样式，只剩 OneTrust + fanyi 样式
    const app = buildApp();
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: cacheKeyUrl('https://example.com/article'),
      title: 'Test',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><style>#onetrust-banner-sdk { display: none; }</style><style>/* 双语对照样式 */ .fanyi-translation {}</style></head><body>cached translation</body></html>',
      created_at: new Date().toISOString(),
    });

    const res = await app.request(
      req('/fanyi/page/check?url=https://example.com/article&source=en&target=zh'),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(204);
  });

  it('returns 204 when db query fails', async () => {
    const app = buildApp();
    const badDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error('db down');
          },
        }),
      }),
    };

    const res = await app.request(
      req('/fanyi/page/check?url=https://example.com/article&source=en&target=zh'),
      {},
      envWithDb(badDb),
    );

    expect(res.status).toBe(204);
  });

  it('returns 400 when url is missing', async () => {
    const app = buildApp();
    const res = await app.request(req('/fanyi/page/check?source=en&target=zh'));

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe('url is required');
  });
});

// ─── POST /fanyi/page ──────────────────────────────────────
describe('POST /fanyi/page', () => {
  it('returns translated HTML when html, url and apiKey provided', async () => {
    const app = buildApp();
    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: '<html><head><title>Hello</title></head><body><p>Test</p></body></html>',
        url: 'https://example.com/article',
        apiKey: 'sk-test-api-key',
      }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('translated');
  });

  it('returns 400 when html is missing', async () => {
    const app = buildApp();
    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    }));
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe('html is required');
  });

  it('returns 400 when url is missing', async () => {
    const app = buildApp();
    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<p>test</p>' }),
    }));
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe('url is required');
  });

  it('returns 400 when apiKey is missing for deepseek', async () => {
    const app = buildApp();
    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: '<html><body>test</body></html>',
        url: 'https://example.com',
        provider: 'deepseek',
      }),
    }));
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe('apiKey is required');
  });

  it('allows non-deepseek provider without apiKey', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const app = buildApp();
    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: '<html><body>test</body></html>',
        url: 'https://example.com',
        provider: 'openrouter',
      }),
    }));
    expect(res.status).toBe(200);
    expect(translateHtml).toHaveBeenCalledOnce();
    const arg = (translateHtml as any).mock.calls[0][0];
    expect(arg.provider).toBe('openrouter');
    expect(arg.apiKey).toBeUndefined();
  });

  it('returns 400 when provider is invalid', async () => {
    const app = buildApp();
    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: '<html><body>test</body></html>',
        url: 'https://example.com',
        provider: 'mimo',
        apiKey: 'sk-test-api-key',
      }),
    }));
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toMatch(/provider must be one of/);
  });

  it('passes provider/apiKey and fixed bilingual mode to translateHtml', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const app = buildApp();
    await app.request(req('/fanyi/page?source=ja&target=zh&mode=target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: '<html><body>test</body></html>',
        url: 'https://example.com',
        apiKey: 'sk-test-api-key',
        provider: 'openrouter',
      }),
    }));
    expect(translateHtml).toHaveBeenCalledOnce();
    const arg = (translateHtml as any).mock.calls[0][0];
    expect(arg.source).toBe('ja');
    expect(arg.target).toBe('zh');
    // /fanyi/page 固定为 bilingual，provider 透传，apiKey 透传
    expect(arg.mode).toBe('bilingual');
    expect(arg.provider).toBe('openrouter');
    expect(arg.apiKey).toBe('sk-test-api-key');
  });

  it('returns 500 when translateHtml throws', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    (translateHtml as any).mockRejectedValueOnce(new Error('translation failed'));

    const app = buildApp();
    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: '<html><body>test</body></html>',
        url: 'https://example.com',
        apiKey: 'sk-test-api-key',
      }),
    }));
    expect(res.status).toBe(500);
    const body: any = await res.json();
    expect(body.error).toBe('translation failed');
  });

  it('returns D1 cache directly when url+source+target exists', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: 'https://example.com',
      title: 'Cached',
      source_lang: 'en',
      target_lang: 'zh',
      // 健康缓存需保留原页面样式
      html: '<html><head><link rel="stylesheet" href="/style.css"></head><body>cached from d1<span class="fanyi-translation">译文</span></body></html>',
      // content_hash 必须等于提交 html 的 simpleHash 才能命中（与线上修复一致）
      content_hash: String(simpleHash('<html><body>new</body></html>')),
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
        }),
      }),
      {},
      envWithDb(db),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).toBe('d1-cache');
    const html = await res.text();
    // 注入了重定向守卫脚本，但仍包含原始缓存内容
    expect(html).toContain('cached from d1');
    expect(html).toContain('__vsRedirectGuard');
    expect(translateHtml).not.toHaveBeenCalled();
  });

  it('re-translates when cached content_hash is empty (cross-path pollution guard)', async () => {
    // 空 content_hash 的缓存（来自 /translate/url-page 等非预标记路径）block ID 与扩展端不兼容，
    // /fanyi/page 必须视为未命中并重新翻译，而非直接返回导致译文错位。
    const { translateHtml } = await import('../lib/translate/pipeline');
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: 'https://example.com',
      title: 'Cached',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><link rel="stylesheet" href="/style.css"></head><body>cached from d1<span class="fanyi-translation">译文</span></body></html>',
      content_hash: '',
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
        }),
      }),
      {},
      envWithDb(db),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).not.toBe('d1-cache');
    expect(translateHtml).toHaveBeenCalled();
  });

  it('saves translation result to D1 when cache miss', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const db = createMockDb();

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
        }),
      }),
      {},
      envWithDb(db),
    );
    expect(res.status).toBe(200);
    expect(translateHtml).toHaveBeenCalledOnce();
    expect(db._rows).toHaveLength(1);
    expect(db._rows[0].url).toBe('https://example.com');
    expect(db._rows[0].source_lang).toBe('en');
    expect(db._rows[0].target_lang).toBe('zh');
    expect(db._rows[0].html).toContain('translated');
  });

  it('ignores unhealthy D1 cache and re-translates', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: 'https://example.com',
      title: 'Cached',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<body><head>corrupted cached translation</body></head></html>',
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
        }),
      }),
      {},
      envWithDb(db),
    );
    expect(res.status).toBe(200);
    expect(translateHtml).toHaveBeenCalledOnce();
    const html = await res.text();
    expect(html).toContain('translated');
    expect(html).not.toContain('corrupted');
  });

  // ── D1 save 失败必须 surface 给前端（不再静默吞掉）──
  // 回归：曾经 save 失败只 console.error，前端拿不到信号、无法察觉缓存失效。
  // 现在通过 X-Translate-Warning header + HTML banner 双通道提示。
  it('surfaces D1 save error via X-Translate-Warning header and HTML banner', async () => {
    const db = createMockDb();
    db._insertError = 'D1_ERROR: table translations has no column named content_hash: SQLITE_ERROR';

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
        }),
      }),
      {},
      envWithDb(db),
    );
    // 翻译本身成功，仍然返回 200（graceful degradation：缓存失败不阻塞翻译）
    expect(res.status).toBe(200);
    // header 透出错误信息，让扩展端能程序化感知并 toast 提示
    expect(res.headers.get('X-Translate-Warning')).toContain('content_hash');
    const html = await res.text();
    // HTML 包含可见警告条，让直访用户也能看到
    expect(html).toContain('data-vs-save-warning');
    expect(html).toContain('译文已生成，但服务端缓存失败');
    // 错误信息在 HTML 中可见（且不会被原样注入为 HTML 标签）
    expect(html).toContain('content_hash');
    // 翻译内容仍然返回
    expect(html).toContain('translated');
  });
});

// ─── 分页列表 GET / 和 GET /page/:page ──────────────────────
describe('分页列表', () => {
  /** 向 mock D1 批量插入 n 条记录 */
  function seedDb(db: any, n: number) {
    for (let i = 1; i <= n; i++) {
      db._rows.push({
        id: i,
        url: `https://example.com/post-${i}`,
        title: `Post ${i}`,
        source_lang: 'en',
        target_lang: 'zh',
        html: '<html></html>',
        created_at: new Date().toISOString(),
      });
    }
  }

  it('首页 / 渲染第 1 页，包含分页导航', async () => {
    const app = buildApp();
    const db = createMockDb();
    seedDb(db, 120); // 120 条 → 4 页（30×4）

    const res = await app.request(req('/'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    // 第 1 页应包含最新记录 Post 120
    expect(html).toContain('Post 120');
    // 不应包含第 2 页的记录 Post 90（第 1 页 30 条：120~91）
    expect(html).not.toContain('Post 90');
    // 分页导航：当前页 1/4，有下一页链接，上一页不可点
    expect(html).toContain('1 / 4');
    expect(html).toContain('href="/page/2"');
    expect(html).not.toContain('href="/page/0"');
  });

  it('GET /page/2 返回第 2 页记录', async () => {
    const app = buildApp();
    const db = createMockDb();
    seedDb(db, 120);

    const res = await app.request(req('/page/2'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    // 第 2 页：Post 90 ~ Post 61
    expect(html).toContain('Post 90');
    expect(html).toContain('Post 61');
    // 不应包含第 1 页和第 3 页的记录
    expect(html).not.toContain('Post 120');
    expect(html).not.toContain('Post 60');
    // 导航：2/4，有上一页和下一页
    expect(html).toContain('2 / 4');
    expect(html).toContain('href="/page/1"');
    expect(html).toContain('href="/page/3"');
  });

  it('最后一页只有剩余记录，无下一页链接', async () => {
    const app = buildApp();
    const db = createMockDb();
    seedDb(db, 120); // 4 页：30 + 30 + 30 + 30

    const res = await app.request(req('/page/4'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    // 第 4 页：Post 30 ~ Post 1
    expect(html).toContain('Post 30');
    expect(html).toContain('Post 1');
    expect(html).not.toContain('Post 31');
    // 最后一页：4/4，有上一页，无下一页
    expect(html).toContain('4 / 4');
    expect(html).toContain('href="/page/3"');
    expect(html).not.toContain('href="/page/5"');
  });

  it('无记录时显示空提示，无分页导航', async () => {
    const app = buildApp();
    const db = createMockDb();

    const res = await app.request(req('/'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('暂无翻译记录');
    expect(html).not.toContain('上一页');
    expect(html).not.toContain('下一页');
  });

  it('无 D1 时返回空列表页', async () => {
    const app = buildApp();
    const res = await app.request(req('/'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('暂无翻译记录');
  });

  it('非法页码 /page/0 返回 404', async () => {
    const app = buildApp();
    const db = createMockDb();
    seedDb(db, 10);

    const res = await app.request(req('/page/0'), {}, envWithDb(db));
    expect(res.status).toBe(404);
  });

  it('非法页码 /page/abc 返回 404', async () => {
    const app = buildApp();
    const db = createMockDb();
    seedDb(db, 10);

    const res = await app.request(req('/page/abc'), {}, envWithDb(db));
    expect(res.status).toBe(404);
  });

  it('页码超出总页数时仍渲染（空列表）', async () => {
    const app = buildApp();
    const db = createMockDb();
    seedDb(db, 10); // 只有 1 页

    const res = await app.request(req('/page/99'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    // 超出页数，无记录显示
    expect(html).toContain('暂无翻译记录');
  });
});

// ─── GET /translate/:target ─────────────────────────────────
describe('GET /translate/<target> — cache health', () => {
  it('ignores unhealthy D1 cache and re-translates', async () => {
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockResolvedValueOnce({
      html: '<html><body>fresh translation: https://example.com/post</body></html>',
      title: 'Fresh',
      blocks: 1,
      chunks: 1,
      duration_ms: 10,
    });

    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: 'https://example.com/post',
      title: 'Cached',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<body><head>corrupted cached translation</body></head></html>',
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(req('/translate/example.com/post'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    expect(translateUrl).toHaveBeenCalledOnce();
    const html = await res.text();
    expect(html).toContain('fresh translation');
    expect(html).not.toContain('corrupted');
  });
});

// ─── GET /article/:id ───────────────────────────────────────
describe('GET /article/:id', () => {
  it('serves cached translation when HTML is healthy', async () => {
    const db = createMockDb();
    db._rows.push({
      id: 42,
      url: 'https://example.com/post',
      title: 'Post',
      source_lang: 'en',
      target_lang: 'zh',
      // 健康缓存需保留原页面样式
      html: '<html><head><style>.original { color: black; }</style></head><body>healthy cached translation<span class="fanyi-translation">译文</span></body></html>',
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(req('/article/42'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('healthy cached translation');
    expect(html).toContain('__vsRedirectGuard');
  });

  it('redirects to re-translate when cached HTML is unhealthy', async () => {
    const db = createMockDb();
    db._rows.push({
      id: 42,
      url: 'https://example.com/post',
      title: 'Post',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<body><head>corrupted cached translation</body></head></html>',
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(req('/article/42'), {}, envWithDb(db));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/translate/example.com%2Fpost');
  });

  it('redirects to re-translate when <base> appears after relative stylesheet', async () => {
    // arxiv / ar5iv 旧缓存：<base> 在相对 CSS 之后，浏览器用代理域解析导致 404
    const db = createMockDb();
    db._rows.push({
      id: 43,
      url: 'https://arxiv.org/html/2501.00000',
      title: 'Paper',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><link href="/static/browse/style.css" rel="stylesheet"><base href="https://arxiv.org/html/"></head><body>cached translation<span class="fanyi-translation">译文</span></body></html>',
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(req('/article/43'), {}, envWithDb(db));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/translate/arxiv.org%2Fhtml%2F2501.00000');
  });

  it('serves newer healthy cache for same URL when requested id is unhealthy', async () => {
    const db = createMockDb();
    // id=44 是旧的损坏缓存（base 在相对 CSS 之后）
    db._rows.push({
      id: 44,
      url: 'https://arxiv.org/html/2501.00000',
      source_lang: 'en',
      target_lang: 'zh',
      title: 'Old',
      html: '<html><head><link href="/static/browse/style.css" rel="stylesheet"><base href="https://arxiv.org/html/"></head><body>old<span class="fanyi-translation">旧</span></body></html>',
      created_at: '2026-07-01T00:00:00Z',
    });
    // id=45 是同一 URL 的新健康缓存
    db._rows.push({
      id: 45,
      url: 'https://arxiv.org/html/2501.00000',
      source_lang: 'en',
      target_lang: 'zh',
      title: 'New',
      html: '<html><head><base href="https://arxiv.org/html/"><link href="/static/browse/style.css" rel="stylesheet"></head><body>new<span class="fanyi-translation">新</span></body></html>',
      created_at: '2026-07-27T00:00:00Z',
    });

    const app = buildApp();
    const res = await app.request(req('/article/44'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('新');
  });

  it('returns 404 when translation id does not exist', async () => {
    const app = buildApp();
    const db = createMockDb();
    const res = await app.request(req('/article/999'), {}, envWithDb(db));
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// injectTranslationCss — 确保翻译 CSS 被正确注入到各种 HTML 结构中
// =============================================================================
import { injectTranslationCss, TRANSLATION_CSS } from '../lib/app';

describe('injectTranslationCss', () => {
  it('injects before </head>', () => {
    const html = '<html><head><title>Test</title></head><body>Hi</body></html>';
    const result = injectTranslationCss(html);
    expect(result).toContain('<style data-fanyi-css>');
    expect(result).toContain(TRANSLATION_CSS);
    expect(result.indexOf('<style data-fanyi-css>')).toBeLessThan(result.indexOf('</head>'));
  });

  it('injects inside <head> when no closing tag', () => {
    const html = '<html><head><title>Test</title><body>Hi</body></html>';
    const result = injectTranslationCss(html);
    expect(result).toContain('<style data-fanyi-css>');
    // style should be right after <head>
    expect(result.match(/<head>(<style[^>]*>)/)?.[1]).toBeDefined();
  });

  it('injects after <body> when no head at all', () => {
    const html = '<html><body><p>Hi</p></body></html>';
    const result = injectTranslationCss(html);
    expect(result).toContain('<style data-fanyi-css>');
    expect(result.indexOf('<style data-fanyi-css>')).toBeGreaterThan(result.indexOf('<body'));
  });

  it('injects after <html> as fallback', () => {
    const html = '<html><p>Minimal</p></html>';
    const result = injectTranslationCss(html);
    expect(result).toContain('<style data-fanyi-css>');
    expect(result.indexOf('<style data-fanyi-css>')).toBeGreaterThan(result.indexOf('<html'));
  });

  it('prefixes completely empty/broken HTML', () => {
    const result = injectTranslationCss('<p>Just a fragment</p>');
    expect(result).toContain('<style data-fanyi-css>');
    expect(result.startsWith('<style')).toBe(true);
  });

  it('contains critical !important rules for .fanyi-translation', () => {
    expect(TRANSLATION_CSS).toContain('display:block!important');
    expect(TRANSLATION_CSS).toContain('order:1!important');
    expect(TRANSLATION_CSS).toContain('position:static!important');
  });
});
