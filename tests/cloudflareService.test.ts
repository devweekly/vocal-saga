import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareAITranslationService } from '../lib/translate/service/cloudflare';
import { setCfAccountId, setCfApiToken } from '../lib/config';

describe('CloudflareAITranslationService', () => {
  const originalFetch = globalThis.fetch;

  // P0-3 后 service 从 config 单例读取 CF 凭证，不再直接读 process.env。
  // 测试通过 setter 显式注入（与 createApp(env) 生产路径一致）。
  beforeEach(() => {
    setCfAccountId('test-account');
    setCfApiToken('test-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // 清空 config 单例，避免跨用例污染
    setCfAccountId('');
    setCfApiToken('');
    vi.restoreAllMocks();
  });

  it('throws when Cloudflare credentials are missing', async () => {
    setCfAccountId('');
    setCfApiToken('');

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
          result: {
            choices: [
              {
                message: {
                  content: '```json\n{"translations":[{"id":"1","translated_text":"你好"}]}\n```',
                },
              },
            ],
          },
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

  it('also supports top-level choices response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"translations":[{"id":"1","translated_text":"你好"}]}',
              },
            },
          ],
        }),
    });
    globalThis.fetch = fetchMock;

    const service = new CloudflareAITranslationService();
    const result = await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

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
          result: {
            choices: [{ message: { content: '{"translations":[{"id":"1","translated_text":"你好"}]}' } }],
          },
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
