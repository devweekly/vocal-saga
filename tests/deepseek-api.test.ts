import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekTranslationService } from '../lib/translate/service/deepseek';
import { setDSApiKey } from '../lib/config';

// Mock global fetch
const globalFetch = vi.fn();
Object.defineProperty(globalThis, 'fetch', { value: globalFetch, writable: true });

describe('DeepSeekTranslationService API methods', () => {
  let service: DeepSeekTranslationService;

  beforeEach(() => {
    setDSApiKey('test-api-key');
    service = new DeepSeekTranslationService();
    vi.clearAllMocks();
  });

  describe('translate', () => {
    it('should translate content successfully', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '{"translations":[{"id":"b1","translated_text":"你好"}]}' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      const result = await service.translate(
        JSON.stringify([{ id: 'b1', text: 'hello' }]),
        'en',
        'zh',
        []
      );

      expect(result).toBe('{"translations":[{"id":"b1","translated_text":"你好"}]}');
      expect(globalFetch).toHaveBeenCalledTimes(1);
      const fetchCall = globalFetch.mock.calls[0];
      expect(fetchCall[1].headers.Authorization).toMatch(/^Bearer /);
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).toBe('deepseek-v4-flash');
      expect(body.stream).toBe(false);
    });

    it('should include glossary in translation request', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '{"translations":[]}' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      const glossary = { document_terms: ['React', 'API'] };
      await service.translate(
        JSON.stringify([{ id: 'b1', text: 'React is great' }]),
        'en',
        'zh',
        glossary
      );

      const fetchCall = globalFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.messages[0].content).toContain('React');
      expect(body.messages[0].content).toContain('Preserve only proper nouns and named entities.');
      expect(body.messages[0].content).toContain('This page mentions:');
    });

    it('omits Named entities section when glossary is empty', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '{"translations":[]}' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await service.translate(
        JSON.stringify([{ id: 'b1', text: 'hello' }]),
        'en',
        'zh',
        { document_terms: [] }
      );

      const fetchCall = globalFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.messages[0].content).not.toContain('Preserve only proper nouns and named entities.');
    });

    it('should handle HTTP 401 error', async () => {
      const mockResponse = {
        ok: false,
        status: 401,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          error: { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key' },
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined)
      ).rejects.toThrow('401');
    });

    it('should handle HTTP 429 error', async () => {
      const mockResponse = {
        ok: false,
        status: 429,
        headers: new Map(),
        text: vi.fn().mockResolvedValue('Too many requests'),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined)
      ).rejects.toThrow('429');
    });

    it('should handle network errors', async () => {
      globalFetch.mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined)
      ).rejects.toThrow();
    });

    it('should handle invalid response structure', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: {} }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined)
      ).rejects.toThrow('invalid response');
    });

    it('should handle non-JSON error response', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        headers: new Map(),
        text: vi.fn().mockResolvedValue('Internal Server Error'),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined)
      ).rejects.toThrow('500');
    });
  });

  describe('error handling', () => {
    it('should handle 403 error', async () => {
      const mockResponse = {
        ok: false,
        status: 403,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          error: { message: 'Forbidden' },
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined)
      ).rejects.toThrow('403');
    });

    it('should handle 503 error', async () => {
      const mockResponse = {
        ok: false,
        status: 503,
        headers: new Map(),
        text: vi.fn().mockResolvedValue('Service Unavailable'),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined)
      ).rejects.toThrow('503');
    });
  });
});
