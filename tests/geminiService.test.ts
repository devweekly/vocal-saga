/**
 * GeminiTranslationService 单测。
 *
 * mock @google/genai SDK，覆盖：
 *   - 凭据缺失抛错
 *   - 非流式 generateContent 调用参数
 *   - response.text 解析
 *   - markdown / thinking 标签剥离
 *   - SDK 错误处理
 *   - 流式 generateContentStream
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock @google/genai SDK — vi.hoisted 确保 mock 函数在 vi.mock 工厂执行前就已定义
const { mockGenerateContent, mockGenerateContentStream } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockGenerateContentStream: vi.fn(),
}));
vi.mock('@google/genai', () => ({
  // Vitest 4 要求构造函数 mock 使用 function/class，不能用箭头函数
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContent: mockGenerateContent,
      generateContentStream: mockGenerateContentStream,
    };
  },
}));

import { GeminiTranslationService } from '../lib/translate/service/gemini';
import { setGeminiApiKey, getGeminiApiKey } from '../lib/config';

describe('GeminiTranslationService', () => {
  beforeEach(() => {
    setGeminiApiKey('test-gemini-key');
    mockGenerateContent.mockClear();
    mockGenerateContentStream.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when Gemini API key is not configured', async () => {
    setGeminiApiKey('');
    const service = new GeminiTranslationService();
    await expect(
      service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh')
    ).rejects.toThrow('Gemini API key not configured');
  });

  it('calls generateContent with correct model and contents', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"translations":[{"id":"1","translated_text":"你好"}]}',
    });

    const service = new GeminiTranslationService();
    const result = await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    // 验证 SDK 被调用
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const params = mockGenerateContent.mock.calls[0][0];
    expect(params.model).toBe('gemini-3.1-flash-lite');
    expect(params.contents).toContain('JSON:');
    expect(params.contents).toContain('"hello"');

    // 验证返回的 JSON
    const parsed = JSON.parse(result);
    expect(parsed.translations[0].translated_text).toBe('你好');
  });

  it('passes systemInstruction and thinkingConfig in config', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"translations":[]}',
    });

    const service = new GeminiTranslationService();
    await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    const config = mockGenerateContent.mock.calls[0][0].config;
    expect(config.systemInstruction).toContain('Translate');
    expect(config.temperature).toBe(0.1);
    expect(config.maxOutputTokens).toBeGreaterThan(0);
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('uses default model gemini-3.1-flash-lite when no model passed', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"translations":[]}',
    });

    const service = new GeminiTranslationService();
    await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-3.1-flash-lite');
  });

  it('uses custom model when passed to constructor', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"translations":[]}',
    });

    const service = new GeminiTranslationService('gemini-2.5-pro');
    await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-2.5-pro');
  });

  it('strips markdown code block from response', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '```json\n{"translations":[{"id":"1","translated_text":"你好"}]}\n```',
    });

    const service = new GeminiTranslationService();
    const result = await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    const parsed = JSON.parse(result);
    expect(parsed.translations[0].translated_text).toBe('你好');
  });

  it('strips <think> tags from response', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '<think>reasoning</think>\n{"translations":[{"id":"1","translated_text":"你好"}]}',
    });

    const service = new GeminiTranslationService();
    const result = await service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh');

    const parsed = JSON.parse(result);
    expect(parsed.translations[0].translated_text).toBe('你好');
  });

  it('throws on SDK error with message', async () => {
    mockGenerateContent.mockRejectedValue(new Error('API key not valid'));

    const service = new GeminiTranslationService();
    await expect(
      service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh')
    ).rejects.toThrow('Gemini API error: API key not valid');
  });

  it('throws when response.text is empty', async () => {
    mockGenerateContent.mockResolvedValue({ text: '' });

    const service = new GeminiTranslationService();
    await expect(
      service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh')
    ).rejects.toThrow('Gemini returned empty response');
  });

  it('throws when response.text is undefined', async () => {
    mockGenerateContent.mockResolvedValue({});

    const service = new GeminiTranslationService();
    await expect(
      service.translate('[{"id":"1","text":"hello"}]', 'en', 'zh')
    ).rejects.toThrow('Gemini returned empty response');
  });

  // ── 流式 ─────────────────────────────────────────────────

  it('stream calls generateContentStream and yields accumulated content', async () => {
    const chunks = [
      { text: '{"translations":[' },
      { text: '{"id":"1","translated_text":"你好"}' },
      { text: ']}' },
    ];
    mockGenerateContentStream.mockResolvedValue((async function* () {
      for (const chunk of chunks) yield chunk;
    })());

    const service = new GeminiTranslationService();
    const generator = service.translateStream(
      '[{"id":"1","text":"hello"}]',
      'en',
      'zh'
    );

    const results: string[] = [];
    for await (const chunk of generator) {
      results.push(chunk);
    }

    // 流式应累积完整内容
    expect(results.length).toBe(3);
    expect(results[0]).toBe('{"translations":[');
    const final = results[results.length - 1];
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

  it('stream throws on SDK error', async () => {
    mockGenerateContentStream.mockRejectedValue(new Error('HTTP 429: rate limited'));

    const service = new GeminiTranslationService();
    const generator = service.translateStream(
      '[{"id":"1","text":"hello"}]',
      'en',
      'zh'
    );
    await expect(generator.next()).rejects.toThrow('Gemini API error: HTTP 429');
  });

  it('stream handles chunks with undefined text', async () => {
    const chunks = [
      { text: undefined },
      { text: '{"translations":[]}' },
    ];
    mockGenerateContentStream.mockResolvedValue((async function* () {
      for (const chunk of chunks) yield chunk;
    })());

    const service = new GeminiTranslationService();
    const generator = service.translateStream(
      '[{"id":"1","text":"hello"}]',
      'en',
      'zh'
    );

    const results: string[] = [];
    for await (const chunk of generator) {
      results.push(chunk);
    }

    // undefined text 的 chunk 不应 yield
    expect(results.length).toBe(1);
    expect(results[0]).toBe('{"translations":[]}');
  });

  it('getGeminiApiKey / setGeminiApiKey round-trip', () => {
    setGeminiApiKey('abc-123');
    expect(getGeminiApiKey()).toBe('abc-123');
    setGeminiApiKey('test-gemini-key'); // 还原
  });
});
