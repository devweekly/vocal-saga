import type { TranslationService, Glossary } from './_service';
import { parseSSEStream } from './streamParser';
import { logUnchangedBlocks } from '../translateApi';

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
  return Math.max(1024, Math.ceil(estimatedInputTokens * 8 * 2));
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function buildSystemContent(
  sourceLang: string,
  targetLang: string,
  sitePrompt?: string,
  glossary?: Glossary
): string {
  const targetLangName = !targetLang ? 'Simplified Chinese' : targetLang === 'zh' ? 'Simplified Chinese' : targetLang;
  const sourceLangName = !sourceLang ? 'English' : sourceLang === 'en' ? 'English' : sourceLang;

  // Prompt 设计目标：低成本、高吞吐、非人工交互。每个词都要有价值。
  // 1. 明确源语言 → 不让模型猜，减少一次隐式语言检测。
  // 2. 不写 "must NOT equal input" → 品牌名/代号确实就是要保留原文，
  //    写了反而跟 "Keep URLs, brand names unchanged" 冲突，让模型困惑。
  // 3. "Longest match first" 太模糊删掉。
  // 4. user message 精简到 "JSON:" + blocksJson → 更短 token。
  let systemContent = `Translate ${sourceLangName} to ${targetLangName}.

1. Return {"translations":[{"id":"x","translated_text":"y"}]}. One entry per input block, same ids.
2. For translatable text, provide a translation. Never return empty string or placeholder.
3. Keep URLs, code, and version numbers unchanged. Translate everything else.
4. Treat every block as independent — do not skip, summarize, merge, or reorder any block.`;

  const docTerms = glossary?.document_terms;
  if (docTerms && docTerms.length > 0) {
    // 排序固定 → token 序列稳定 → DeepSeek KV cache 公共前缀命中。
    // 没有 glossary → 不写这段，免得空 Examples 占 token。
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

  if (sitePrompt) {
    systemContent += `\n\nSite-specific rules:\n${sitePrompt}`;
  }

  return systemContent;
}

function buildTranslationBody(
  blocks: Array<{ id: string; text: string }>,
  sourceLang: string,
  targetLang: string,
  sitePrompt?: string,
  glossary?: Glossary
) {
  const blocksJson = JSON.stringify(
    blocks.map((b) => ({ id: b.id, text: b.text })),
    null,
    2
  );

  // user message 精简到 "JSON:" + blocks — 比 "Output JSON only."
  // 更短，同时 "JSON" 字样满足 response_format: json_object 硬约束。
  const systemContent = buildSystemContent(sourceLang, targetLang, sitePrompt, hasGlossaryEntries(glossary) ? glossary : undefined);
  console.log('[DeepSeek] System prompt built:\n' + systemContent);
  return {
    model: MODEL,
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
  // 45s 超时，防止 API 太慢导致 Workers 挂起
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('DeepSeek API timeout (45s) — content may be too large');
    }
    throw err;
  }
  clearTimeout(timeout);

  console.log('[DeepSeek] Response status:', response.status);

  const responseText = await response.text().catch(() => '');

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

  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    console.error('[DeepSeek] Invalid response structure:', JSON.stringify(data).substring(0, 500));
    throw new Error('DeepSeek 返回了无效响应: 缺少 choices[0].message.content');
  }

  return content;
}

function hasGlossaryEntries(glossary?: Glossary): boolean {
  return !!glossary && (
    (glossary.hard_terms?.length ?? 0) > 0 ||
    (glossary.soft_terms?.length ?? 0) > 0 ||
    (glossary.document_terms?.length ?? 0) > 0
  );
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
    glossary?: Glossary,
    context?: string,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);

    const body = buildTranslationBody(
      blocks,
      sourceLang,
      targetLang,
      context,
      hasGlossaryEntries(glossary) ? glossary : undefined
    );

    const raw = await callApi(this.apiKey, JSON.stringify(body));
    return logUnchangedBlocks(raw, blocks);
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
    context?: string,
  ): AsyncGenerator<string, string, unknown> {
    const blocks = JSON.parse(jsonContent);

    const bodyObj = buildTranslationBody(
      blocks,
      sourceLang,
      targetLang,
      context,
      hasGlossaryEntries(glossary) ? glossary : undefined
    );
    bodyObj.stream = true;
    const body = JSON.stringify(bodyObj);

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
