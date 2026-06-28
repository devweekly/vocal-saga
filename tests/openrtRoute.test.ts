/**
 * GET /openrt/<target-without-scheme> 路由单测。
 *
 * OpenRouter 免费模型翻译路由，使用 openrouter/free。
 * 与 /translate 路由类似，但使用 OpenRouter API 而非 DeepSeek。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(async (args: { url: string; mode: string; provider: string }) => ({
    html: `<html><body>openrouter: ${args.url} (${args.provider})</body></html>`,
    blocks: 3,
    chunks: 1,
    duration_ms: 50,
  })),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
  process.env.OPENROUTER_API_KEY = 'or-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:openrt-' + Math.random().toString(36).slice(2)));
  const { translateUrl } = await import('../lib/translate/pipeline');
  (translateUrl as any).mockClear();
  (translateUrl as any).mockResolvedValue({
    html: '<html><body>ok</body></html>',
    title: 'Test',
    blocks: 1,
    chunks: 1,
    duration_ms: 10,
  });
});

function buildApp() {
  return createApp();
}

function req(path: string): Request {
  return new Request(`http://test${path}`);
}

// 测试 stripMarkdownCodeBlock 函数
describe('stripMarkdownCodeBlock', () => {
  it('strips ```json code block', async () => {
    const { stripMarkdownCodeBlock } = await import('../lib/translate/service/shared');
    const input = '```json\n[{"id":"b1","translated_text":"你好"}]\n```';
    const result = stripMarkdownCodeBlock(input);
    expect(result).toBe('[{"id":"b1","translated_text":"你好"}]');
  });

  it('strips ``` code block without json label', async () => {
    const { stripMarkdownCodeBlock } = await import('../lib/translate/service/shared');
    const input = '```\n[{"id":"b1","translated_text":"你好"}]\n```';
    const result = stripMarkdownCodeBlock(input);
    expect(result).toBe('[{"id":"b1","translated_text":"你好"}]');
  });

  it('returns plain JSON unchanged', async () => {
    const { stripMarkdownCodeBlock } = await import('../lib/translate/service/shared');
    const input = '[{"id":"b1","translated_text":"你好"}]';
    const result = stripMarkdownCodeBlock(input);
    expect(result).toBe(input);
  });

  it('handles whitespace variations', async () => {
    const { stripMarkdownCodeBlock } = await import('../lib/translate/service/shared');
    const input = '  ```json\n  [{"id":"b1"}]\n  ```  ';
    const result = stripMarkdownCodeBlock(input);
    expect(result).toBe('[{"id":"b1"}]');
  });

  it('strips opening ```json when closing ``` is missing (truncated output)', async () => {
    // NVIDIA 模型可能因 max_tokens 截断，只输出开头的 ```json 没有结尾 ```
    const { stripMarkdownCodeBlock } = await import('../lib/translate/service/shared');
    const input = '```json\n{"translations":[{"id":"b1","translated_text":"你好"}]}';
    const result = stripMarkdownCodeBlock(input);
    expect(result).toBe('{"translations":[{"id":"b1","translated_text":"你好"}]}');
    // 结果必须是合法 JSON
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('strips opening ``` when closing ``` is missing (truncated, no json label)', async () => {
    const { stripMarkdownCodeBlock } = await import('../lib/translate/service/shared');
    const input = '```\n{"translations":[]}';
    const result = stripMarkdownCodeBlock(input);
    expect(result).toBe('{"translations":[]}');
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

// 测试 stripThinkingTags 函数
// webclaw defense in depth：qwen3 / deepseek-r1 等推理模型可能把 <think>...</think>
// 泄漏到 content，必须在 stripMarkdownCodeBlock 之前去除，否则 JSON.parse 爆炸。
describe('stripThinkingTags', () => {
  it('strips complete <think>...</think> block', async () => {
    const { stripThinkingTags } = await import('../lib/translate/service/shared');
    const input = '<think>Let me think about this translation...</think>\n{"translations":[]}';
    const result = stripThinkingTags(input);
    expect(result).toBe('{"translations":[]}');
  });

  it('strips <think> block with multi-line content (DOTALL)', async () => {
    const { stripThinkingTags } = await import('../lib/translate/service/shared');
    const input = '<think>\nLine 1: reasoning\nLine 2: more reasoning\n</think>\n{"translations":[]}';
    const result = stripThinkingTags(input);
    expect(result).toBe('{"translations":[]}');
  });

  it('strips truncated <think> without closing tag (max_tokens cutoff)', async () => {
    const { stripThinkingTags } = await import('../lib/translate/service/shared');
    const input = '<think>I need to translate this but I am running out of tokens';
    const result = stripThinkingTags(input);
    // 截断的 thinking 整段去除，结果为空字符串
    expect(result).toBe('');
  });

  it('strips truncated <think> preserving content after it', async () => {
    const { stripThinkingTags } = await import('../lib/translate/service/shared');
    // 模型先输出完整 thinking，再输出部分 JSON（被截断）
    const input = '<think>thinking...</think>\n{"translations":[{"id":"b1","translated_text":"你好"}';
    const result = stripThinkingTags(input);
    expect(result).toBe('{"translations":[{"id":"b1","translated_text":"你好"}');
  });

  it('handles case-insensitive <think> tags', async () => {
    const { stripThinkingTags } = await import('../lib/translate/service/shared');
    const input = '<THINK>reasoning</THINK>\n{"translations":[]}';
    const result = stripThinkingTags(input);
    expect(result).toBe('{"translations":[]}');
  });

  it('strips multiple <think>...</think> blocks', async () => {
    const { stripThinkingTags } = await import('../lib/translate/service/shared');
    const input = '<think>first thought</think>\n{"translations":[]}\n<think>second thought</think>';
    const result = stripThinkingTags(input);
    expect(result).toBe('{"translations":[]}');
  });

  it('preserves content without <think> tags', async () => {
    const { stripThinkingTags } = await import('../lib/translate/service/shared');
    const input = '{"translations":[{"id":"b1","translated_text":"你好"}]}';
    const result = stripThinkingTags(input);
    expect(result).toBe(input);
  });

  it('strips <think> inside ```json block (defense in depth)', async () => {
    // 模型把 thinking 包进 ```json 块：先去 thinking 再去 markdown
    const { stripThinkingTags, stripMarkdownCodeBlock } = await import('../lib/translate/service/shared');
    const input = '```json\n<think>reasoning here</think>\n{"translations":[]}\n```';
    const stripped = stripThinkingTags(input);
    const result = stripMarkdownCodeBlock(stripped);
    expect(result).toBe('{"translations":[]}');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('strips <think> before ```json (common qwen3 pattern)', async () => {
    // qwen3 常见输出：先 thinking，再 ```json 块
    const { stripThinkingTags, stripMarkdownCodeBlock } = await import('../lib/translate/service/shared');
    const input = '<think>User wants Chinese translation. I will translate each block.</think>\n```json\n{"translations":[{"id":"b1","translated_text":"你好"}]}\n```';
    const stripped = stripThinkingTags(input);
    const result = stripMarkdownCodeBlock(stripped);
    expect(result).toBe('{"translations":[{"id":"b1","translated_text":"你好"}]}');
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

describe('GET /openrt/<target> — OpenRouter free model', () => {
  it('200 with valid request', async () => {
    const app = buildApp();
    const res = await app.request(req('/openrt/example.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('uses openrouter provider', async () => {
    const app = buildApp();
    await app.request(req('/openrt/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.provider).toBe('openrouter');
  });

  it('uses openrouter provider', async () => {
    const app = buildApp();
    await app.request(req('/openrt/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.provider).toBe('openrouter');
  });

  it('returns translated HTML', async () => {
    const app = buildApp();
    const res = await app.request(req('/openrt/example.com'));
    const body = await res.text();
    expect(body).toContain('<html>');
    expect(body).toContain('ok');
  });

  it('strips https:// prefix', async () => {
    const app = buildApp();
    await app.request(req('/openrt/https%3A%2F%2Fexample.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/article');
  });

  it('adds .com suffix for domain without dot', async () => {
    const app = buildApp();
    await app.request(req('/openrt/towardsdatascience/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://towardsdatascience.com/article');
  });

  it('does not force re-translate (force=false)', async () => {
    const app = buildApp();
    await app.request(req('/openrt/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    // service 模式下 force 应该是 false
    expect(call.url).toBe('https://example.com');
  });

  it('400 when target is empty', async () => {
    const app = buildApp();
    const res = await app.request(req('/openrt/'));
    expect(res.status).toBe(400);
  });

  it('returns translated HTML', async () => {
    const app = buildApp();
    const res = await app.request(req('/openrt/example.com'));
    const body = await res.text();
    expect(body).toContain('<html>');
    expect(body).toContain('ok');
  });
});
