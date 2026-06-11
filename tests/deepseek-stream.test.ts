import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekTranslationService } from '../lib/translate/service/deepseek';

// Mock global fetch
const globalFetch = vi.fn();
Object.defineProperty(globalThis, 'fetch', { value: globalFetch, writable: true });

describe('DeepSeekTranslationService.translateStream', () => {
  let service: DeepSeekTranslationService;

  beforeEach(() => {
    service = new DeepSeekTranslationService('test-api-key');
    vi.clearAllMocks();
  });

  function createMockReader(deltas: string[]) {
    const encoder = new TextEncoder();
    const events = deltas.map(d => `data: {"choices":[{"delta":{"content":"${d}"}}]}\n\n`);
    events.push('data: [DONE]\n\n');

    // Concatenate all events into a single Uint8Array to avoid jsdom ReadableStream issues
    const fullData = events.join('');
    const chunk = encoder.encode(fullData);
    let consumed = false;

    return {
      read: vi.fn().mockImplementation(() => {
        if (!consumed) {
          consumed = true;
          return Promise.resolve({ done: false, value: chunk });
        }
        return Promise.resolve({ done: true, value: undefined });
      }),
      releaseLock: vi.fn(),
    };
  }

  function createMockResponse(deltas: string[], status = 200) {
    return {
      ok: status === 200,
      status,
      body: {
        getReader: () => createMockReader(deltas),
      },
      text: vi.fn().mockResolvedValue(''),
    };
  }

  async function consumeStream(stream: AsyncGenerator<string, string, unknown>): Promise<{ values: string[]; returnValue: string }> {
    const values: string[] = [];
    let returnValue = '';
    while (true) {
      const result = await stream.next();
      if (result.done) {
        returnValue = result.value as string;
        break;
      }
      values.push(result.value);
    }
    return { values, returnValue };
  }

  it('should yield accumulated content for each delta', async () => {
    const mockResponse = createMockResponse(['Hello', ' world', '!']);
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'test' }]),
      'en',
      'zh',
      []
    );

    const { values } = await consumeStream(stream);
    expect(values).toEqual(['Hello', 'Hello world', 'Hello world!']);
  });

  it('should set stream=true in request body', async () => {
    const mockResponse = createMockResponse(['test']);
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    await consumeStream(stream);

    const fetchCall = globalFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.stream).toBe(true);
  });

  it('should include Authorization header', async () => {
    const mockResponse = createMockResponse(['test']);
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    await consumeStream(stream);

    const fetchCall = globalFetch.mock.calls[0];
    expect(fetchCall[1].headers.Authorization).toBe('Bearer test-api-key');
  });

  it('should throw on HTTP error', async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      body: null,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    await expect(consumeStream(stream)).rejects.toThrow('DeepSeek API error: HTTP 401');
  });

  it('should throw when response body is null', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      body: null,
      text: vi.fn().mockResolvedValue(''),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    await expect(consumeStream(stream)).rejects.toThrow('response body is null');
  });

  it('should return final content as generator return value', async () => {
    const mockResponse = createMockResponse(['Hello', ' world']);
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    const { returnValue } = await consumeStream(stream);
    expect(returnValue).toBe('Hello world');
  });

  it('should handle empty stream', async () => {
    const mockResponse = createMockResponse([]);
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    const { values } = await consumeStream(stream);
    expect(values).toEqual([]);
  });

  it('should handle glossary in request', async () => {
    const mockResponse = createMockResponse(['test']);
    globalFetch.mockResolvedValue(mockResponse);

    const glossary = { document_terms: ['React'] };
    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'React is great' }]),
      'en',
      'zh',
      glossary
    );

    await consumeStream(stream);

    const fetchCall = globalFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.messages[0].content).toContain('React');
      expect(body.messages[0].content).toContain('Preserve only proper nouns and named entities.');
    });

  it('should handle multiple document_terms in stream', async () => {
    const mockResponse = createMockResponse(['test']);
    globalFetch.mockResolvedValue(mockResponse);

    const glossary = { document_terms: ['LLM', 'React'] };
    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'LLM and React' }]),
      'en',
      'zh',
      glossary
    );

    await consumeStream(stream);

    const fetchCall = globalFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.messages[0].content).toContain('LLM');
    expect(body.messages[0].content).toContain('React');
  });

  it('should handle network errors', async () => {
    globalFetch.mockRejectedValue(new TypeError('fetch failed'));

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    await expect(consumeStream(stream)).rejects.toThrow();
  });
});
