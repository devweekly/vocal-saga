/**
 * Cloudflare AI 翻译服务：使用 CF Workers AI 的免费模型。
 *
 * 与 DeepSeekTranslationService 共享 TranslationService 接口，
 * 但使用 Cloudflare 的 env.AI999.run() 而非 HTTP fetch。
 */
import type { TranslationService } from './_service';
import { getAI } from '../../config';
import { buildTranslationBody, stripMarkdownCodeBlock, cleanJsonString } from './shared';

const MODEL = 'openai/gpt-5-nano';

export class CloudflareAITranslationService implements TranslationService {

  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: any,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);

    const body = buildTranslationBody(blocks, sourceLang, targetLang, glossary, MODEL);

    const ai = getAI();
    if (!ai) throw new Error('Cloudflare AI not configured');

    console.log('[CloudAI] Calling', MODEL);
    const response = await ai.run(MODEL, body);
    console.log('[CloudAI] Response received');

    // CF AI 返回的是字符串，不是 JSON
    const content = typeof response === 'string' ? response : JSON.stringify(response);

    // 清理 markdown 代码块 + 修复 JSON
    let cleaned = stripMarkdownCodeBlock(content);
    try {
      JSON.parse(cleaned);
    } catch {
      cleaned = cleanJsonString(cleaned);
    }

    return cleaned;
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: any,
  ): AsyncGenerator<string, string, unknown> {
    // CF AI 不支持流式，降级为非流式
    const result = await this.translate(jsonContent, sourceLang, targetLang, glossary);
    yield result;
    return result;
  }
}
