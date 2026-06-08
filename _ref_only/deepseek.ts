import type { TranslationService, GlossaryEntry } from './_service';
import { parseSSEStream } from './streamParser';
import { logUnchangedBlocks } from '../utils/translateApi';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';
const USER_ID = 'fanyi-extension';
const TRANSLATION_TEMPERATURE = 0.1;

/**
 * Estimate max output tokens for translation.
 *
 * 真实边界（已查 https://api-docs.deepseek.com/quick_start/pricing）：
 * - deepseek-v4-flash MAX OUTPUT = 384K（硬上限非常高）
 * - 计费 = actual tokens × price，不是 reserve × price
 *   → reserve 大小不会让账单变大，只影响 worst-case latency
 * - 必须设 cap，因为 response_format: json_object 下模型失控时
 *   可能"unending stream of whitespace"跑到 384K 仍不停
 *   （见 https://api-docs.deepseek.com/api/create-chat-completion）
 *
 * 翻译 ratio 经验值（chunkBuilder TARGET_TOKENS=800 → 典型 chunk）：
 * - input 800 tokens (12 blocks) → output ~2000 tokens
 * - input 1500 tokens (18 blocks) → output ~3700 tokens
 * - input 2000 tokens (30 blocks, worst case) → output ~5000 tokens
 * - + JSON 包装（id/translated_text 键名、引号、换行）≈ +10-20%
 *
 * 当前公式：* 4 * 2 = 8x input tokens，最低 1024。
 *  - 800 input  →  6400 reserve（典型 12 块，3.2x headroom）
 *  - 1500 input → 12000 reserve（18 块，3.2x headroom）
 *  - 2000 input → 16000 reserve（30 块，3.2x headroom）
 *  - 200 input  →  1024 reserve（retry 单块的下限）
 * 3.2x headroom 给模型留出"想多说点"或"加注释"的余量，同时远
 * 小于 384K 硬上限。再大的 chunk 触顶靠 content.ts 的 per-block
 * retry 兜底（retry 切到 1-3 块的小 chunk，reserve 永远不会触顶）。
 */
function estimateMaxTokens(inputJson: string): number {
  // Rough estimate: 1 char ≈ 0.3 tokens for English, 0.5 for CJK
  const estimatedInputTokens = Math.ceil(inputJson.length * 0.5);
  return Math.max(1024, Math.ceil(estimatedInputTokens * 5 * 2));
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function buildTranslationBody(
  blocks: Array<{ id: string; text: string }>,
  sourceLang: string,
  targetLang: string,
  sitePrompt?: string,
  glossary?: GlossaryEntry[]
) {
  const blocksJson = JSON.stringify(
    blocks.map((b) => ({ id: b.id, text: b.text })),
    null,
    2
  );

  const targetLangName = targetLang === 'zh' ? 'Simplified Chinese' : targetLang;

  let systemContent = `Translate ${sourceLang === 'en' ? 'English' : sourceLang} to ${targetLangName}. Rules:
1. Return {"translations":[{"id":"x","translated_text":"y"}]}. One entry per input block, same ids. No extra text.
2. translated_text must NOT equal input text. Never return empty, "...", or placeholder.
3. Keep URLs, code, version numbers, brand names as-is. Translate everything else.
4. Treat every block as independent — do not skip, summarize, or merge any block. Each one is a separate text that must be translated in full.`;

// Use the full glossary as-is. We do NOT per-chunk filter here because:
// 1) the LLM will naturally ignore terms that don't appear in the current
//    chunk's text, so filtering just costs CPU.
// 2) per-chunk filtering breaks KV cache reuse — the glossary section
//    would differ chunk-to-chunk, defeating the cache for everything
//    after the glossary lines.
const relevantGlossary = glossary && glossary.length > 0 ? glossary : undefined;
if (relevantGlossary) {
  const glossaryLines = relevantGlossary
    .map((g: GlossaryEntry) => `- "${g.term}" → "${g.translation}"`)
    .join('\n');
  systemContent += `\n\nTerminology glossary (MUST follow these translations):\n${glossaryLines}`;
}

if (sitePrompt) {
  systemContent += `\n\nSite-specific rules:\n${sitePrompt}`;
}

return {
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: systemContent,
      },
      {
        role: 'user',
        content: `Translate ${blocks.length} blocks to ${targetLangName}. Output JSON only.

${blocksJson}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: TRANSLATION_TEMPERATURE,
    max_tokens: estimateMaxTokens(blocksJson),
    user_id: USER_ID,
    thinking: { type: 'disabled' },
    stream: false,
  };
}

async function callApi(
  apiKey: string,
  body: string
): Promise<string> {
  console.log('[DeepSeek] Calling API:', API_URL);
  console.log('[DeepSeek] Request body length:', body.length, 'bytes');
  console.log('[DeepSeek] API Key length:', apiKey.length);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body,
    });

    console.log('[DeepSeek] Response status:', response.status);
    console.log('[DeepSeek] Response headers:', Object.fromEntries(response.headers.entries()));

    const responseText = await response.text().catch(() => '');
    console.log('[DeepSeek] Response body:', responseText.substring(0, 500));

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      
      try {
        const errorJson = JSON.parse(responseText);
        if (errorJson.error) {
          errorMessage += ` - ${errorJson.error.message || errorJson.error}`;
          if (errorJson.error.type) errorMessage += ` [${errorJson.error.type}]`;
          if (errorJson.error.code) errorMessage += ` (code: ${errorJson.error.code})`;
        } else if (errorJson.message) {
          errorMessage += ` - ${errorJson.message}`;
        } else {
          errorMessage += ` - ${responseText.substring(0, 200)}`;
        }
      } catch {
        errorMessage += ` - ${responseText.substring(0, 200)}`;
      }

      if (response.status === 401) {
        errorMessage += '\n\n可能原因: API Key 无效或已过期';
      } else if (response.status === 403) {
        errorMessage += '\n\n可能原因: 账户余额不足或被封禁';
      } else if (response.status === 429) {
        errorMessage += '\n\n可能原因: 请求频率超限，请稍后重试';
      } else if (response.status === 500 || response.status === 503) {
        errorMessage += '\n\n可能原因: DeepSeek 服务暂时不可用';
      }

      throw new Error(`DeepSeek API error: ${errorMessage}`);
    }

    const data = JSON.parse(responseText);
    console.log('[DeepSeek] Parsed response:', JSON.stringify(data).substring(0, 300));

    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error('[DeepSeek] Invalid response structure:', JSON.stringify(data).substring(0, 500));
      throw new Error('DeepSeek 返回了无效响应: 缺少 choices[0].message.content');
    }

    console.log('[DeepSeek] Response content length:', content.length);
    return content;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      console.error('[DeepSeek] Fetch error - possible network/CORS issue:', error);
      throw new Error(`网络请求失败: ${error.message}\n\n可能原因:\n1. 网络连接问题\n2. Firefox 扩展权限不足\n3. 被防火墙/代理拦截`);
    }
    throw error;
  }
}

export class DeepSeekTranslationService implements TranslationService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary: GlossaryEntry[],
    context?: string,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);

    const body = buildTranslationBody(
      blocks,
      sourceLang,
      targetLang,
      context,
      glossary.length > 0 ? glossary : undefined
    );

    const raw = await callApi(this.apiKey, JSON.stringify(body));
    return logUnchangedBlocks(raw, blocks);
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary: GlossaryEntry[],
    context?: string,
  ): AsyncGenerator<string, string, unknown> {
    const blocks = JSON.parse(jsonContent);

    const bodyObj = buildTranslationBody(
      blocks,
      sourceLang,
      targetLang,
      context,
      glossary.length > 0 ? glossary : undefined
    );
    bodyObj.stream = true;
    const body = JSON.stringify(bodyObj);

    console.log('[DeepSeek] Calling streaming API:', API_URL);

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders(this.apiKey),
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`DeepSeek API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
    }

    if (!response.body) {
      throw new Error('DeepSeek API error: response body is null');
    }

    const reader = response.body.getReader();
    let fullContent = '';

    for await (const delta of parseSSEStream(reader)) {
      fullContent += delta;
      yield fullContent;
    }

    return logUnchangedBlocks(fullContent, blocks);
  }
}
