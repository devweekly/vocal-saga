/**
 * OpenCode 翻译服务单测。
 *
 * mock global.fetch，覆盖：
 *   - 正常翻译请求（JSON 解析、清洗、返回）
 *   - 流式翻译（SSE delta 累积）
 *   - API Key 未配置错误
 *   - HTTP 错误（401 / 500 / 429）
 *   - 响应缺少 choices 字段
 *   - thinking 标签 / markdown 代码块剥离
 *   - 超时保护（AbortController）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setOpencodeApiKey } from '../lib/config';
import { OpencodeTranslationService } from '../lib/translate/service/opencode';

// ── mock fetch ──────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── 工具：构造 OpenAI 兼容的成功响应 ────────────────────────
function makeOkResponse(content: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify({
      choices: [{ message: { content } }],
    }),
  };
}

function makeErrorResponse(status: number, message: string) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify({ error: { message } }),
  };
}

describe('OpencodeTranslationService', () => {
  beforeEach(() => {
    setOpencodeApiKey('test-opencode-key');
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 正常翻译 ─────────────────────────────────────────────
  it('正常翻译：返回合法 JSON', async () => {
    const translations = [{ id: 'b1', text: 'Hello' }];
    const mockResponse = JSON.stringify(
      { b1: '你好' },
    );
    mockFetch.mockResolvedValueOnce(makeOkResponse(mockResponse));

    const svc = new OpencodeTranslationService();
    const result = await svc.translate(
      JSON.stringify(translations),
      'en',
      'zh',
    );

    expect(result).toBe(JSON.stringify({ b1: '你好' }));
    // 验证 fetch 调用参数
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer test-opencode-key');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['User-Agent']).toBe('vocal-saga/1.0');
    // body 包含模型名和 response_format
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('big-pickle');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
  });

  // ── API Key 未配置 ───────────────────────────────────────
  it('API Key 未配置时抛出错误', async () => {
    setOpencodeApiKey('');
    const svc = new OpencodeTranslationService();
    await expect(
      svc.translate(JSON.stringify([{ id: 'b1', text: 'Hi' }]), 'en', 'zh'),
    ).rejects.toThrow('OpenCode API key not configured');
  });

  // ── HTTP 401 错误 ────────────────────────────────────────
  it('HTTP 401 认证失败', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(401, 'Invalid API key'));
    const svc = new OpencodeTranslationService();
    await expect(
      svc.translate(JSON.stringify([{ id: 'b1', text: 'Hi' }]), 'en', 'zh'),
    ).rejects.toThrow('HTTP 401 - Invalid API key');
  });

  // ── HTTP 500 错误 ────────────────────────────────────────
  it('HTTP 500 服务端错误', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500, 'Internal error'));
    const svc = new OpencodeTranslationService();
    await expect(
      svc.translate(JSON.stringify([{ id: 'b1', text: 'Hi' }]), 'en', 'zh'),
    ).rejects.toThrow('HTTP 500 - Internal error');
  });

  // ── HTTP 429 限流 ────────────────────────────────────────
  it('HTTP 429 限流错误', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(429, 'Rate limit'));
    const svc = new OpencodeTranslationService();
    await expect(
      svc.translate(JSON.stringify([{ id: 'b1', text: 'Hi' }]), 'en', 'zh'),
    ).rejects.toThrow('HTTP 429 - Rate limit');
  });

  // ── 响应缺少 choices ─────────────────────────────────────
  it('响应缺少 choices 字段时抛错', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ foo: 'bar' }),
    });
    const svc = new OpencodeTranslationService();
    await expect(
      svc.translate(JSON.stringify([{ id: 'b1', text: 'Hi' }]), 'en', 'zh'),
    ).rejects.toThrow('missing choices[0].message.content');
  });

  // ── thinking 标签剥离 ───────────────────────────────────
  it('剥离 <think> 标签', async () => {
    const inner = JSON.stringify({ b1: '你好' });
    const wrapped = `<think>reasoning here</think>\n${inner}`;
    mockFetch.mockResolvedValueOnce(makeOkResponse(wrapped));

    const svc = new OpencodeTranslationService();
    const result = await svc.translate(
      JSON.stringify([{ id: 'b1', text: 'Hello' }]),
      'en',
      'zh',
    );
    expect(result).toBe(inner);
  });

  // ── markdown 代码块剥离 ─────────────────────────────────
  it('剥离 markdown 代码块', async () => {
    const inner = JSON.stringify({ b1: '你好' });
    const wrapped = '```json\n' + inner + '\n```';
    mockFetch.mockResolvedValueOnce(makeOkResponse(wrapped));

    const svc = new OpencodeTranslationService();
    const result = await svc.translate(
      JSON.stringify([{ id: 'b1', text: 'Hello' }]),
      'en',
      'zh',
    );
    expect(result).toBe(inner);
  });

  // ── 超时保护 ────────────────────────────────────────────
  it('请求超时抛出错误', async () => {
    // 直接模拟 fetch 因 abort 而 reject
    mockFetch.mockImplementationOnce(() => {
      return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
    });

    const svc = new OpencodeTranslationService();
    await expect(
      svc.translate(JSON.stringify([{ id: 'b1', text: 'Hi' }]), 'en', 'zh'),
    ).rejects.toThrow('timeout');
  });

  // ── 网络错误 ────────────────────────────────────────────
  it('网络错误抛出原始异常', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const svc = new OpencodeTranslationService();
    await expect(
      svc.translate(JSON.stringify([{ id: 'b1', text: 'Hi' }]), 'en', 'zh'),
    ).rejects.toThrow('Network error');
  });

  // ── 流式翻译 ────────────────────────────────────────────
  it('流式翻译：累积 SSE delta', async () => {
    const fullJson = '{"b1": "你好"}';
    // 模拟 SSE 流
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"b1":' } }] }) }\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: ' "你好"}' } }] }) }\n\n`,
      `data: [DONE]\n\n`,
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

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: stream,
    });

    const svc = new OpencodeTranslationService();
    const gen = svc.translateStream(
      JSON.stringify([{ id: 'b1', text: 'Hello' }]),
      'en',
      'zh',
    );

    const chunks: string[] = [];
    for await (const delta of gen) {
      chunks.push(delta);
    }

    // 最终累积结果应等于完整 JSON
    const final = chunks[chunks.length - 1];
    expect(final).toBe(fullJson);
  });

  // ── 流式：API Key 未配置 ────────────────────────────────
  it('流式：API Key 未配置时抛出错误', async () => {
    setOpencodeApiKey('');
    const svc = new OpencodeTranslationService();
    await expect(
      svc.translateStream(
        JSON.stringify([{ id: 'b1', text: 'Hi' }]),
        'en',
        'zh',
      ).next(),
    ).rejects.toThrow('OpenCode API key not configured');
  });

  // ── 流式：HTTP 错误 ─────────────────────────────────────
  it('流式：HTTP 错误时抛出', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(503, 'Service unavailable'));
    const svc = new OpencodeTranslationService();
    await expect(
      svc.translateStream(
        JSON.stringify([{ id: 'b1', text: 'Hi' }]),
        'en',
        'zh',
      ).next(),
    ).rejects.toThrow('HTTP 503');
  });

  // ── 流式：response.body 为 null ─────────────────────────
  it('流式：response.body 为 null 时抛错', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
    });
    const svc = new OpencodeTranslationService();
    await expect(
      svc.translateStream(
        JSON.stringify([{ id: 'b1', text: 'Hi' }]),
        'en',
        'zh',
      ).next(),
    ).rejects.toThrow('response body is null');
  });

  // ── body 包含 system + user 消息 ────────────────────────
  it('请求 body 包含 system 和 user 消息', async () => {
    const mockResponse = JSON.stringify({ b1: '你好' });
    mockFetch.mockResolvedValueOnce(makeOkResponse(mockResponse));

    const svc = new OpencodeTranslationService();
    await svc.translate(
      JSON.stringify([{ id: 'b1', text: 'Hello' }]),
      'en',
      'zh',
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    // user 消息包含原文 JSON
    expect(body.messages[1].content).toContain('b1');
    expect(body.messages[1].content).toContain('Hello');
  });
});
