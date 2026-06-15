/**
 * Cloudflare AI 翻译服务：使用 CF Workers AI 的 openai/gpt-5-nano 模型。
 *
 * 128K context window，足够处理大段文章。
 * 通过 env.AI999.run() 调用，无需 HTTP fetch。
 */
import type { TranslationService, Glossary } from './_service';
import { getAI } from '../../config';
import { buildSystemContent, stripMarkdownCodeBlock, cleanJsonString } from './shared';

const MODEL = '@cf/moonshotai/kimi-k2.6';

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
      // 关闭思考：GLM-4.7-flash 是 reasoning 模型，思考过程会被模型放进
      // message.reasoning 字段（我们已忽略），但思考本身会拖慢全并行翻译。
      // 双重保险：参数 + prompt 末尾的强约束。
      parameters: {
        disable_thinking: true,
        reasoning_effort: 'none',
      },
    };

    // 末尾再追加禁思考约束，覆盖参数被 Workers AI 忽略的场景。
    body.messages[0].content += `

Do NOT output any reasoning, thinking, chain-of-thought, or analysis.
Return ONLY the final JSON object. No prose, no explanation, no markdown outside the JSON block.`;

    const ai = getAI();
    if (!ai) throw new Error('Cloudflare AI not configured');

    console.log(`[CloudAI] Calling ${MODEL}, ${blocks.length} blocks`);
    const response = await ai.run(MODEL, body);
    console.log('[CloudAI] raw response:', JSON.stringify(response)?.slice(0, 2000));

    // @cf/zai-org/glm-4.7-flash 走 OpenAI 兼容返回：
    //   { choices: [{ message: { role, content, reasoning? } }] }
    // message.content 是真正的 LLM 输出（可能带 ```json``` 包装），
    // message.reasoning 是思考过程，忽略。
    // 老一点的 @cf/ 模型可能返回 { response: "..." }；两种都认。
    let content: string;
    const choice = (response as any)?.choices?.[0]?.message;
    if (typeof choice?.content === 'string') {
      content = choice.content;
    } else if (typeof (response as any)?.response === 'string') {
      content = (response as any).response;
    } else if (typeof response === 'string') {
      content = response;
    } else {
      content = JSON.stringify(response);
    }

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
