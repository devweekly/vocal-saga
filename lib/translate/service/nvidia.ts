/**
 * NVIDIA 翻译服务：使用 build.nvidia.com API。
 *
 * 与 DeepSeekTranslationService 共享 TranslationService 接口，
 * 但指向 NVIDIA 的 API 端点。
 */
import type { TranslationService, Glossary } from './_service';
import { parseSSEStream } from './streamParser';

const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
/** 默认模型：kimi-k2.6 */
const DEFAULT_MODEL = 'moonshotai/kimi-k2.6';
/** DeepSeek 模型（通过 NVIDIA API） */
const DEEPSEEK_MODEL = 'deepseek-ai/deepseek-v4-pro';
const TRANSLATION_TEMPERATURE = 0.1;

function estimateMaxTokens(inputJson: string): number {
  const estimatedInputTokens = Math.ceil(inputJson.length * 0.5);
  return Math.max(1024, Math.ceil(estimatedInputTokens * 8 * 2));
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
}

function buildSystemContent(
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary
): string {
  const targetLangName = !targetLang ? 'Simplified Chinese' : targetLang === 'zh' ? 'Simplified Chinese' : targetLang;
  const sourceLangName = !sourceLang ? 'English' : sourceLang === 'en' ? 'English' : sourceLang;

  let systemContent = `Translate ${sourceLangName} to ${targetLangName}.

1. Return {"translations":[{"id":"x","translated_text":"y"}]}. One entry per input block, same ids.
2. For translatable text, provide a translation. Never return empty string or placeholder.
3. Keep URLs, code, and version numbers unchanged. Translate everything else.
4. Treat every block as independent — do not skip, summarize, merge, or reorder any block.`;

  const docTerms = glossary?.document_terms;
  if (docTerms && docTerms.length > 0) {
    const sorted = [...docTerms].sort();
    systemContent += `

Preserve only proper nouns and named entities. Examples:
- company names
- organization names
- product names
- service names
- trademarks

This page mentions:
${sorted.join('\n')}

Translate all ordinary English words and phrases normally.`;
  }

  return systemContent;
}

function buildTranslationBody(
  blocks: Array<{ id: string; text: string }>,
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary,
  model?: string
) {
  const blocksJson = JSON.stringify(
    blocks.map((b) => ({ id: b.id, text: b.text })),
    null,
    2
  );

  const systemContent = buildSystemContent(sourceLang, targetLang, glossary);

  return {
    model: model || DEFAULT_MODEL,
    messages: [
      {
        role: 'system' as const,
        content: systemContent,
      },
      {
        role: 'user' as const,
        content: `JSON:\n\n${blocksJson}`,
      },
    ],
    temperature: TRANSLATION_TEMPERATURE,
    max_tokens: estimateMaxTokens(blocksJson),
  };
}

/**
 * 清理 LLM 返回的 JSON：移除 markdown 代码块包裹。
 */
function stripMarkdownCodeBlock(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (match) {
    return match[1].trim();
  }
  return trimmed;
}

async function callApi(apiKey: string, body: string): Promise<string> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body,
  });

  console.log('[NVIDIA] Response status:', response.status);

  const responseText = await response.text().catch(() => '');

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorJson = JSON.parse(responseText);
      if (errorJson.error) {
        errorMessage += ` - ${errorJson.error.message || errorJson.error}`;
      } else if (errorJson.message) {
        errorMessage += ` - ${errorJson.message}`;
      } else {
        errorMessage += ` - ${responseText.substring(0, 200)}`;
      }
    } catch {
      errorMessage += ` - ${responseText.substring(0, 200)}`;
    }
    throw new Error(`NVIDIA API error: ${errorMessage}`);
  }

  const data = JSON.parse(responseText);
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('NVIDIA returned invalid response: missing choices[0].message.content');
  }

  // 清理 markdown 代码块包裹
  return stripMarkdownCodeBlock(content);
}

export class NvidiaTranslationService implements TranslationService {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
  }

  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);

    const body = buildTranslationBody(blocks, sourceLang, targetLang, glossary, this.model);

    const raw = await callApi(this.apiKey, JSON.stringify(body));

    // 简单的 unchanged 检测
    try {
      const parsed = JSON.parse(raw);
      const translations = parsed.translations || parsed;
      if (Array.isArray(translations)) {
        const unchanged = translations.filter(
          (t: any, i: number) => t.translated_text === blocks[i]?.text || t.text === blocks[i]?.text
        ).length;
        if (unchanged > 0 && unchanged === translations.length) {
          console.warn('[NVIDIA] ALL translated blocks came back unchanged');
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

    const body = buildTranslationBody(blocks, sourceLang, targetLang, glossary, this.model);

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders(this.apiKey),
      body: JSON.stringify({ ...body, stream: true }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`NVIDIA API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
    }

    if (!response.body) {
      throw new Error('NVIDIA API error: response body is null');
    }

    const reader = response.body.getReader();
    let fullContent = '';

    for await (const delta of parseSSEStream(reader)) {
      fullContent += delta;
      yield fullContent;
    }

    return fullContent;
  }
}
