import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareAITranslationService } from '../lib/translate/service/cloudflare';

describe('CloudflareAITranslationService', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('throws when Cloudflare credentials are missing', async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;

    const service = new CloudflareAITranslationService();
    await expect(service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh')).rejects.toThrow(
      'Cloudflare AI not configured'
    );
  });

  it('calls Cloudflare REST API and returns cleaned JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: '```json\n{"translations":[{"id":"1","translated_text":"你好"}]}\n```',
              },
            },
          ],
        }),
    });
    globalThis.fetch = fetchMock;

    const service = new CloudflareAITranslationService();
    const result = await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/moonshotai/kimi-k2.6');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    });

    const parsed = JSON.parse(result);
    expect(parsed.translations[0].translated_text).toBe('你好');
  });

  it('throws on HTTP error with body snippet', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    globalThis.fetch = fetchMock;

    const service = new CloudflareAITranslationService();
    await expect(service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh')).rejects.toThrow(
      'Cloudflare AI API error: HTTP 401'
    );
  });

  it('stream falls back to non-stream', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '{"translations":[{"id":"1","translated_text":"你好"}]}' } }],
        }),
    });
    globalThis.fetch = fetchMock;

    const service = new CloudflareAITranslationService();
    const generator = service.translateStream('[{"id":"1","text":"hello"}]', 'en', 'zh');
    const chunks: string[] = [];
    for await (const chunk of generator) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    const parsed = JSON.parse(chunks[chunks.length - 1]);
    expect(parsed.translations[0].translated_text).toBe('你好');
  });
});
