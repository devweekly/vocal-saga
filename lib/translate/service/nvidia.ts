/**
 * NVIDIA 翻译服务：使用 build.nvidia.com API。
 *
 * 与 DeepSeekTranslationService 共享 TranslationService 接口，
 * 但指向 NVIDIA 的 API 端点。
 */
import type { TranslationService, Glossary } from './_service';
import { parseSSEStream } from './streamParser';
import { getNvidiaApiKey } from '../../config';
import { buildTranslationBody, stripMarkdownCodeBlock, cleanJsonString } from './shared';

const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_MODEL = 'moonshotai/kimi-k2.6';

function buildHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getNvidiaApiKey()}`,
    Accept: 'application/json',
  };
}

async function callApi(body: string): Promise<string> {
  const apiKey = getNvidiaApiKey();
  if (!apiKey) throw new Error('NVIDIA API key not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders(),
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('NVIDIA API timeout (60s)');
    }
    throw err;
  }
  clearTimeout(timeout);

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

  let cleaned = stripMarkdownCodeBlock(content);
  try {
    JSON.parse(cleaned);
  } catch {
    cleaned = cleanJsonString(cleaned);
  }

  return cleaned;
}

export class NvidiaTranslationService implements TranslationService {
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

    const body = buildTranslationBody(blocks, sourceLang, targetLang, glossary, this.model);
    const raw = await callApi(JSON.stringify(body));

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

    // 60s 超时
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('NVIDIA stream timeout (60s)');
      }
      throw err;
    }
    clearTimeout(timeout);

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
