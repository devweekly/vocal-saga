/**
 * GeminiTranslationService 单测。
 *
 * 覆盖：
 *   - 凭据缺失抛错
 *   - 调用 Gemini 原生 API（generateContent 端点 + X-goog-api-key header）
 *   - 响应解析（candidates[0].content.parts[].text 拼接）
 *   - markdown 代码块剥离
 *   - thinking 标签剥离
 *   - HTTP 错误带 body 片段
 *   - 流式 SSE 解析（streamGenerateContent?alt=sse）
 *   - 请求体结构（contents/parts/systemInstruction/generationConfig）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiTranslationService } from '../lib/translate/service/gemini';
import { setGeminiApiKey, getGeminiApiKey } from '../lib/config';

describe('GeminiTranslationService', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setGeminiApiKey('test-gemini-key');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws when Gemini API key is not configured', async () => {
    setGeminiApiKey('');
    const service = new GeminiTranslationService();
    await expect(
      service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh')
    ).rejects.toThrow('Gemini API key not configured');
  });

  it('calls Gemini generateContent endpoint with X-goog-api-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"translations":[{"id":"1","translated_text":"你好"}]}' }],
              },
            },
          ],
        }),
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService();
    const result = await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    // 验证 URL 和 method
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent'
    );
    expect(init?.method).toBe('POST');
    // 验证 headers（X-goog-api-key，不是 Authorization Bearer）
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-goog-api-key': 'test-gemini-key',
    });

    // 验证返回的 JSON
    const parsed = JSON.parse(result);
    expect(parsed.translations[0].translated_text).toBe('你好');
  });

  it('uses default model gemini-flash-latest when no model passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: '{"translations":[]}' }] } },
          ],
        }),
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService();
    await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('gemini-flash-latest');
  });

  it('uses custom model when passed to constructor', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: '{"translations":[]}' }] } },
          ],
        }),
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService('gemini-pro-latest');
    await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('gemini-pro-latest');
  });

  it('builds request body with contents/parts/systemInstruction structure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: '{"translations":[]}' }] } },
          ],
        }),
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService();
    await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Gemini 原生结构：contents[{role, parts[{text}]}]
    expect(body.contents).toBeInstanceOf(Array);
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts[0].text).toContain('JSON:');
    // system prompt 通过 systemInstruction 单独传
    expect(body.systemInstruction).toBeDefined();
    expect(body.systemInstruction.parts[0].text).toContain('Translate');
    // generationConfig 包含 temperature / maxOutputTokens / thinkingConfig
    expect(body.generationConfig.temperature).toBe(0.1);
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThan(0);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('concatenates text from multiple parts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: '{"translations":[' },
                  { text: '{"id":"1","translated_text":"你好"}' },
                  { text: ']}' },
                ],
              },
            },
          ],
        }),
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService();
    const result = await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    const parsed = JSON.parse(result);
    expect(parsed.translations[0].translated_text).toBe('你好');
  });

  it('strips markdown code block from response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: '```json\n{"translations":[{"id":"1","translated_text":"你好"}]}\n```' },
                ],
              },
            },
          ],
        }),
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService();
    const result = await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    const parsed = JSON.parse(result);
    expect(parsed.translations[0].translated_text).toBe('你好');
  });

  it('strips <think> tags from response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: '<think>reasoning about translation</think>\n{"translations":[{"id":"1","translated_text":"你好"}]}' },
                ],
              },
            },
          ],
        }),
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService();
    const result = await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    const parsed = JSON.parse(result);
    expect(parsed.translations[0].translated_text).toBe('你好');
  });

  it('throws on HTTP error with body snippet', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({
        error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' },
      }),
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService();
    await expect(
      service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh')
    ).rejects.toThrow(/Gemini API error: HTTP 403.*API key not valid/);
  });

  it('throws when response is missing candidates content', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [] } }] }),
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService();
    await expect(
      service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh')
    ).rejects.toThrow('missing candidates[0].content.parts');
  });

  // ── 流式 ─────────────────────────────────────────────────

  it('stream calls streamGenerateContent endpoint with alt=sse', async () => {
    const sseChunks = [
      'data: {"candidates":[{"content":{"parts":[{"text":"{\\"translations\\":[{"}]}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"{\\"id\\":\\"1\\",\\"translated_text\\":\\"你好\\"}]}"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"]}"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService();
    const generator = service.translateStream(
      '[{"id":"1","text":"hello"}]',
      'en',
      'zh'
    );

    const chunks: string[] = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    // 验证调用 streamGenerateContent 端点
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('streamGenerateContent');
    expect(url).toContain('alt=sse');

    // 流式应累积完整内容
    expect(chunks.length).toBeGreaterThan(0);
    const final = chunks[chunks.length - 1];
    expect(final).toContain('你好');
  });

  it('stream throws when API key not configured', async () => {
    setGeminiApiKey('');
    const service = new GeminiTranslationService();
    const generator = service.translateStream(
      '[{"id":"1","text":"hello"}]',
      'en',
      'zh'
    );
    await expect(generator.next()).rejects.toThrow('Gemini API key not configured');
  });

  it('stream throws on HTTP error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService();
    const generator = service.translateStream(
      '[{"id":"1","text":"hello"}]',
      'en',
      'zh'
    );
    await expect(generator.next()).rejects.toThrow(/HTTP 429/);
  });

  it('stream throws when response body is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    });
    globalThis.fetch = fetchMock;

    const service = new GeminiTranslationService();
    const generator = service.translateStream(
      '[{"id":"1","text":"hello"}]',
      'en',
      'zh'
    );
    await expect(generator.next()).rejects.toThrow('response body is null');
  });

  it('getGeminiApiKey / setGeminiApiKey round-trip', () => {
    setGeminiApiKey('abc-123');
    expect(getGeminiApiKey()).toBe('abc-123');
    setGeminiApiKey('test-gemini-key'); // 还原
  });
});
