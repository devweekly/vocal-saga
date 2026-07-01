/**
 * Gemini 翻译服务：使用 Google @google/genai SDK。
 *
 * SDK 会自动处理认证（X-goog-api-key header）、请求格式（contents/parts）、
 * 响应解析（candidates[0].content.parts），比手动 fetch 更简洁。
 *
 * 参考：https://ai.google.dev/gemini-api/docs/api-key
 */
import { GoogleGenAI } from '@google/genai';
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

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

/** 获取 Gemini 客户端实例，API Key 缺失时抛错 */
function getClient(): GoogleGenAI {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('Gemini API key not configured');
  return new GoogleGenAI({ apiKey });
}

/** 清洗 LLM 输出：去 thinking 标签 → 去 markdown 代码块 → 修 JSON */
function cleanResponse(content: string): string {
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
    const ai = getClient();

    // 构造请求参数：contents 为用户输入，config.systemInstruction 为系统提示
    const blocksJson = JSON.stringify(
      blocks.map((b: { id: string; text: string }) => ({ id: b.id, text: b.text })),
      null,
      2,
    );
    const systemContent = buildSystemContent(sourceLang, targetLang, glossary);

    // 超时保护：60s（与其他服务一致）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let response;
    try {
      response = await ai.models.generateContent({
        model: this.model,
        contents: `JSON:\n\n${blocksJson}`,
        config: {
          systemInstruction: systemContent,
          temperature: 0.1,
          maxOutputTokens: estimateMaxTokens(blocksJson),
          // 关闭思考：Gemini 2.5 系列支持 thinkingBudget=0，旧模型忽略
          thinkingConfig: { thinkingBudget: 0 },
          abortSignal: controller.signal,
        },
      });
    } catch (err: any) {
      clearTimeout(timeout);
      // SDK 抛出的错误可能是 GoogleGenAIError 或 ClientError
      throw new Error(`Gemini API error: ${err?.message || String(err)}`);
    }
    clearTimeout(timeout);

    // response.text 是 getter，返回所有 text parts 的拼接
    const content = response.text || '';
    if (!content) {
      throw new Error('Gemini returned empty response');
    }

    const cleaned = cleanResponse(content);

    // 简单的 unchanged 检测
    try {
      const parsed = JSON.parse(cleaned);
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

    return cleaned;
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): AsyncGenerator<string, string, unknown> {
    const blocks = JSON.parse(jsonContent);
    const ai = getClient();

    const blocksJson = JSON.stringify(
      blocks.map((b: { id: string; text: string }) => ({ id: b.id, text: b.text })),
      null,
      2,
    );
    const systemContent = buildSystemContent(sourceLang, targetLang, glossary);

    // 超时保护：60s
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let stream: AsyncIterable<{ text?: string }>;
    try {
      stream = await ai.models.generateContentStream({
        model: this.model,
        contents: `JSON:\n\n${blocksJson}`,
        config: {
          systemInstruction: systemContent,
          temperature: 0.1,
          maxOutputTokens: estimateMaxTokens(blocksJson),
          thinkingConfig: { thinkingBudget: 0 },
          abortSignal: controller.signal,
        },
      });
    } catch (err: any) {
      clearTimeout(timeout);
      throw new Error(`Gemini API error: ${err?.message || String(err)}`);
    }

    let fullContent = '';
    try {
      // SDK 的 stream 是 AsyncIterable，每个 chunk 有 .text getter
      for await (const chunk of stream) {
        const delta = chunk.text || '';
        if (delta) {
          fullContent += delta;
          yield fullContent;
        }
      }
    } catch (err: any) {
      throw new Error(`Gemini stream error: ${err?.message || String(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    return fullContent;
  }
}
