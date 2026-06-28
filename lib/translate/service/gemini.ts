/**
 * Gemini 翻译服务：使用 Google Gemini 原生 API。
 *
 * 端点：https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * 鉴权：X-goog-api-key header（参考 https://ai.google.dev/gemini-api/docs/api-key）
 *
 * 与 OpenAI 兼容服务（DeepSeek / OpenRouter / NVIDIA）不同，Gemini 原生 API
 * 使用 contents/parts 结构而非 messages，system prompt 通过 systemInstruction
 * 字段单独传递。
 */
import type { TranslationService, Glossary } from './_service';
import { getGeminiApiKey } from '../../config';
import {
  buildSystemContent,
  estimateMaxTokens,
  stripThinkingTags,
  stripMarkdownCodeBlock,
  cleanJsonString,
  repairTruncatedJson,
} from './shared';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

function buildHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-goog-api-key': getGeminiApiKey(),
  };
}

/**
 * 构造 Gemini 原生 API 请求体。
 *
 * Gemini 的 messages 结构是 contents/parts（不是 OpenAI 的 messages），
 * system prompt 通过 systemInstruction 字段单独传。
 *
 * thinkingConfig.thinkingBudget=0 关闭 Gemini 2.5 系列的思考过程，
 * 避免拖慢全并行翻译；旧模型会忽略该字段。
 */
function buildGeminiBody(
  blocks: Array<{ id: string; text: string }>,
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary,
) {
  const blocksJson = JSON.stringify(
    blocks.map((b) => ({ id: b.id, text: b.text })),
    null,
    2,
  );
  const systemContent = buildSystemContent(sourceLang, targetLang, glossary);

  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: `JSON:\n\n${blocksJson}` }],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemContent }],
    },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: estimateMaxTokens(blocksJson),
      // 关闭思考：Gemini 2.5 Flash/Pro 支持 thinkingBudget=0，旧模型忽略
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

async function callApi(body: string, model: string): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('Gemini API key not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  const url = `${API_BASE}/${model}:generateContent`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(),
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Gemini API timeout (60s)');
    }
    throw err;
  }
  clearTimeout(timeout);

  console.log('[Gemini] Response status:', response.status);

  const responseText = await response.text().catch(() => '');

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorJson = JSON.parse(responseText);
      // Gemini 错误格式：{ "error": { "code": 400, "message": "...", "status": "..." } }
      if (errorJson.error) {
        errorMessage += ` - ${errorJson.error.message || JSON.stringify(errorJson.error)}`;
      } else if (errorJson.message) {
        errorMessage += ` - ${errorJson.message}`;
      } else {
        errorMessage += ` - ${responseText.substring(0, 200)}`;
      }
    } catch {
      errorMessage += ` - ${responseText.substring(0, 200)}`;
    }
    throw new Error(`Gemini API error: ${errorMessage}`);
  }

  const data = JSON.parse(responseText);
  // Gemini 响应：{ candidates: [{ content: { parts: [{ text: "..." }] } }] }
  // 多个 parts 的 text 需要拼接
  const content = data.candidates?.[0]?.content?.parts
    ?.map((p: any) => p?.text || '')
    .join('') ?? '';

  if (!content) {
    throw new Error('Gemini returned invalid response: missing candidates[0].content.parts');
  }

  let cleaned = stripThinkingTags(content);
  cleaned = stripMarkdownCodeBlock(cleaned);
  try {
    JSON.parse(cleaned);
  } catch {
    cleaned = cleanJsonString(cleaned);
    try {
      JSON.parse(cleaned);
    } catch {
      // LLM 输出可能因 max_tokens 被截断，尝试修复未闭合的 JSON
      cleaned = repairTruncatedJson(cleaned);
    }
  }

  return cleaned;
}

export class GeminiTranslationService implements TranslationService {
  private model: string;

  constructor(model?: string) {
    this.model = model || DEFAULT_MODEL;
  }

  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);
    const body = buildGeminiBody(blocks, sourceLang, targetLang, glossary);
    const raw = await callApi(JSON.stringify(body), this.model);

    // 简单的 unchanged 检测
    try {
      const parsed = JSON.parse(raw);
      const translations = parsed.translations || parsed;
      if (Array.isArray(translations)) {
        const unchanged = translations.filter(
          (t: any, i: number) => t.translated_text === blocks[i]?.text || t.text === blocks[i]?.text
        ).length;
        if (unchanged > 0 && unchanged === translations.length) {
          console.warn('[Gemini] ALL translated blocks came back unchanged');
        }
      }
    } catch {
      // parse 失败不阻塞
    }

    return raw;
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): AsyncGenerator<string, string, unknown> {
    const blocks = JSON.parse(jsonContent);
    const body = buildGeminiBody(blocks, sourceLang, targetLang, glossary);

    const apiKey = getGeminiApiKey();
    if (!apiKey) throw new Error('Gemini API key not configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    // Gemini 流式端点：streamGenerateContent?alt=sse
    // alt=sse 让响应格式为 SSE（data: {...}\n\n），便于流式解析
    const url = `${API_BASE}/${this.model}:streamGenerateContent?alt=sse`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('Gemini stream timeout (60s)');
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Gemini API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
    }

    if (!response.body) {
      throw new Error('Gemini API error: response body is null');
    }

    const reader = response.body.getReader();
    let fullContent = '';

    // Gemini SSE 数据格式与 OpenAI 不同：
    //   data: {"candidates":[{"content":{"parts":[{"text":"增量文本"}]}}]}
    // parseSSEStream（streamParser.ts）按 OpenAI 的 delta.content 解析，无法复用，
    // 这里内联解析 Gemini 的 candidates[0].content.parts[].text。
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.candidates?.[0]?.content?.parts
              ?.map((p: any) => p?.text || '')
              .join('') ?? '';
            if (delta) {
              fullContent += delta;
              yield fullContent;
            }
          } catch {
            // 解析失败忽略，继续读下一行
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return fullContent;
  }
}
