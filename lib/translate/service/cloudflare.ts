/**
 * Cloudflare AI 翻译服务：使用 CF Workers AI 的 openai/gpt-5-nano 模型。
 *
 * 128K context window，足够处理大段文章。
 * 通过 env.AI999.run() 调用，无需 HTTP fetch。
 */
import type { TranslationService, Glossary } from './_service';
import { getAI } from '../../config';
import { buildSystemContent, stripMarkdownCodeBlock, cleanJsonString } from './shared';

const MODEL = '@cf/zai-org/glm-4.7-flash';

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
      parameters: {
        reasoning_effort: 'none',
      },
    };

    const ai = getAI();
    if (!ai) throw new Error('Cloudflare AI not configured');

    console.log(`[CloudAI] Calling ${MODEL}, ${blocks.length} blocks`);
    const response = await ai.run(MODEL, body);
    console.log('[CloudAI] raw response:', JSON.stringify(response)?.slice(0, 2000));

    // CF Workers AI 的 ai.run() 对 chat-completion 模型返回
    // { response: "...", usage: {...} }。response 字段本身可能是字符串
    // （最常见，LLM 原始输出），也可能是已解析的对象，少数情况下还有
    // 其他形态。统一转成字符串交给下游解析。
    const content =
      typeof response === 'string'
        ? response
        : (response as any)?.response != null
        ? typeof (response as any).response === 'string'
          ? (response as any).response
          : JSON.stringify((response as any).response)
        : JSON.stringify(response);

    // 清理 markdown 代码块 + 修复 JSON
    let cleaned = stripMarkdownCodeBlock(content);
    try {
      JSON.parse(cleaned);
    } catch {
      cleaned = cleanJsonString(cleaned);
    }

    // 防御：下游 processTranslationWithCheck 会做 `for (const item of translations)`，
    // 拿到非数组就直接抛 "translations is not iterable"，排查时只能看到错误
    // 信息，看不到真实 payload。这里提前验证，失败时把完整内容带上。
    let parsedForCheck: any;
    try {
      parsedForCheck = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(
        `[CloudAI] cleaned content is not valid JSON. content=${cleaned.slice(0, 1000)}`
      );
    }
    const arr = parsedForCheck?.translations;
    if (!Array.isArray(arr)) {
      console.log('[CloudAI] parsed keys:', Object.keys(parsedForCheck ?? {}));
      console.log('[CloudAI] parsed.translations type:', typeof arr, 'value:', arr);
      throw new Error(
        `[CloudAI] translations is not iterable. payload=${JSON.stringify(parsedForCheck).slice(0, 2000)}`
      );
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
