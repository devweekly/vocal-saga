/**
 * Cloudflare AI 翻译服务：使用 CF Workers AI 的 openai/gpt-5-nano 模型。
 *
 * 128K context window，足够处理大段文章。
 * 通过 env.AI999.run() 调用，无需 HTTP fetch。
 */
import type { TranslationService, Glossary } from './_service';
import { getAI } from '../../config';
import { buildSystemContent, stripMarkdownCodeBlock, cleanJsonString } from './shared';

const MODEL = 'openai/gpt-5-nano';

export class CloudflareAITranslationService implements TranslationService {

  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);

    const blocksJson = JSON.stringify(
      blocks.map((b: any) => ({ id: b.id, text: b.text })),
      null,
      2
    );

    const systemContent = buildSystemContent(sourceLang, targetLang, glossary);

    // CF AI 的 ai.run(model, body)：model 在第一个参数指定，body 不传 model
    const body = {
      messages: [
        { role: 'system' as const, content: systemContent },
        { role: 'user' as const, content: `JSON:\n\n${blocksJson}` },
      ],
    };

    const ai = getAI();
    if (!ai) throw new Error('Cloudflare AI not configured');

    console.log(`[CloudAI] Calling ${MODEL}, ${blocks.length} blocks`);
    const response = await ai.run(MODEL, body);
    console.log('[CloudAI] Response received');

    // CF AI 返回的可能是对象或字符串
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
    glossary?: Glossary,
  ): AsyncGenerator<string, string, unknown> {
    // CF AI 不支持流式，降级为非流式
    const result = await this.translate(jsonContent, sourceLang, targetLang, glossary);
    yield result;
    return result;
  }
}
