/**
 * Cloudflare AI 翻译服务：使用 CF Workers AI 的免费模型。
 *
 * 与 DeepSeekTranslationService 共享 TranslationService 接口，
 * 但使用 Cloudflare 的 env.AI999.run() 而非 HTTP fetch。
 *
 * 注意：CF Workers AI 免费模型有 context window 限制（通常 8K tokens），
 * 大量文本块需要自行分块后逐批调用。
 */
import type { TranslationService, Glossary } from './_service';
import { getAI } from '../../config';
import { buildSystemContent, stripMarkdownCodeBlock, cleanJsonString } from './shared';

// CF AI 免费模型，context window 较小
const MODEL = '@cf/meta/llama-3.2-1b-instruct';
// CF AI 单次最大 token 数（免费模型限制）
const MAX_CF_TOKENS = 3000;

export class CloudflareAITranslationService implements TranslationService {

  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);
    const systemContent = buildSystemContent(sourceLang, targetLang, glossary);

    const ai = getAI();
    if (!ai) throw new Error('Cloudflare AI not configured');

    // CF AI 免费模型 context window 小，需要分批处理
    // 每批最多 ~3000 tokens（约 6000 字符）
    const BATCH_CHARS = 6000;
    const batches: typeof blocks[] = [];
    let currentBatch: typeof blocks = [];
    let currentChars = 0;

    for (const block of blocks) {
      if (currentChars + block.text.length > BATCH_CHARS && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }
      currentBatch.push(block);
      currentChars += block.text.length;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    console.log(`[CloudAI] ${blocks.length} blocks → ${batches.length} batches, model=${MODEL}`);

    // 逐批调用 CF AI
    const allTranslations: any[] = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchJson = JSON.stringify(
        batch.map((b: any) => ({ id: b.id, text: b.text })),
        null,
        2
      );

      const body = {
        messages: [
          { role: 'system' as const, content: systemContent },
          { role: 'user' as const, content: `JSON:\n\n${batchJson}` },
        ],
      };

      console.log(`[CloudAI] Batch ${i + 1}/${batches.length}: ${batch.length} blocks`);
      const response = await ai.run(MODEL, body);

      // CF AI 返回的可能是对象或字符串
      const content = typeof response === 'string' ? response : JSON.stringify(response);

      // 清理 markdown 代码块 + 修复 JSON
      let cleaned = stripMarkdownCodeBlock(content);
      try {
        const parsed = JSON.parse(cleaned);
        const translations = parsed.translations || parsed;
        if (Array.isArray(translations)) {
          allTranslations.push(...translations);
        }
      } catch {
        cleaned = cleanJsonString(cleaned);
        try {
          const parsed = JSON.parse(cleaned);
          const translations = parsed.translations || parsed;
          if (Array.isArray(translations)) {
            allTranslations.push(...translations);
          }
        } catch (e) {
          console.error(`[CloudAI] Batch ${i + 1} JSON parse failed:`, (e as Error).message);
        }
      }
    }

    console.log(`[CloudAI] Total translations: ${allTranslations.length}`);
    return JSON.stringify({ translations: allTranslations });
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
