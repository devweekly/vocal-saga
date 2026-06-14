/**
 * 翻译服务共享工具函数。
 *
 * 所有 LLM 服务（DeepSeek / OpenRouter / NVIDIA / Cloudflare）共用。
 */

import type { Glossary } from './_service';

// ── Token 估算 ──────────────────────────────────────────────

/**
 * 估算 max output tokens。
 * 翻译 ratio 经验值：input * 8 * 2 = 16x，最低 1024。
 */
export function estimateMaxTokens(inputJson: string): number {
  const estimatedInputTokens = Math.ceil(inputJson.length * 0.5);
  return Math.max(1024, Math.ceil(estimatedInputTokens * 8 * 2));
}

// ── System Prompt ────────────────────────────────────────────

export function buildSystemContent(
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

// ── 翻译请求体构造 ──────────────────────────────────────────

export function buildTranslationBody(
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
    model: model || 'deepseek-v4-flash',
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
    temperature: 0.1,
    max_tokens: estimateMaxTokens(blocksJson),
  };
}

// ── JSON 清理 ────────────────────────────────────────────────

/**
 * 清理 LLM 返回的 JSON：移除 markdown 代码块包裹。
 */
export function stripMarkdownCodeBlock(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (match) {
    return match[1].trim();
  }
  return trimmed;
}

/**
 * 清理 JSON：修复尾随逗号。
 */
export function cleanJsonString(str: string): string {
  return str.replace(/,\s*([}\]])/g, '$1');
}
