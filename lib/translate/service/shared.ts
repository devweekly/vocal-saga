/**
 * 翻译服务共享工具函数。
 *
 * 所有 LLM 服务（DeepSeek / OpenRouter / NVIDIA / Cloudflare）共用。
 */

import type { Glossary } from './_service';
import { buildJinyongSystemContent } from './jinyong-prompt';

// ── JSON 截断修复 ────────────────────────────────────────────

/**
 * 修复 LLM 返回的截断 JSON。
 * 当模型输出因 max_tokens 达到上限被截断时，JSON 字符串/对象/数组可能未闭合。
 * 本函数尝试截断到最近的完整元素边界，并补全闭合括号，以保留已翻译的内容。
 *
 * 仅处理最常见的翻译响应结构：{"translations":[{"id":"...","translated_text":"..."},...]}
 * 或 [{"id":"...","translated_text":"..."},...]；
 * 不支持任意 JSON 恢复；如果无法修复，原样返回字符串，让调用方抛出原始错误。
 */
export function repairTruncatedJson(str: string): string {
  const trimmed = str.trim();
  // 如果已经能解析，直接返回
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // 继续修复
  }

  // 辅助：去掉尾部未闭合的字符串。
  // 如果最后一个字符落在未闭合的字符串中，回退到该字符串开始引号之前，
  // 让后续的元素边界扫描能继续工作。
  function trimTrailingPartialString(s: string): string {
    let inString = false;
    let escaped = false;
    let lastOpenQuote = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        const wasInString = inString;
        inString = !inString;
        if (!wasInString) {
          lastOpenQuote = i;
        }
      }
    }
    if (inString && lastOpenQuote >= 0) {
      return s.slice(0, lastOpenQuote);
    }
    return s;
  }

  let s = trimTrailingPartialString(trimmed);

  // 辅助：从前往后扫描，找到最后一个完整顶层元素结束的位置。
  // 返回该元素结束字符（} 或 ]）的索引；找不到返回 -1。
  function findLastCompleteElementEnd(text: string): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let lastCompleteEnd = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        // 记录每一个不在字符串内的闭合括号位置；
        // 截断到该位置后，补全剩余未闭合的外层括号。
        lastCompleteEnd = i;
      }
    }
    return lastCompleteEnd;
  }

  const lastCompleteEnd = findLastCompleteElementEnd(s);
  if (lastCompleteEnd < 0) {
    return trimmed; // 无法找到完整元素，放弃修复
  }

  // 截断到完整元素之后，保留该元素；去掉后面不完整的碎片
  let repaired = s.slice(0, lastCompleteEnd + 1);

  // 去掉末尾多余的逗号、空白
  repaired = repaired.replace(/,\s*$/, '');

  // 重新扫描前缀，统计未闭合的 { 和 [，并补全
  let openObjects = 0;
  let openArrays = 0;
  let inStr = false;
  let escaped = false;
  for (let j = 0; j < repaired.length; j++) {
    const ch = repaired[j];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') openObjects++;
    else if (ch === '[') openArrays++;
    else if (ch === '}') openObjects--;
    else if (ch === ']') openArrays--;
  }

  while (openArrays > 0) {
    repaired += ']';
    openArrays--;
  }
  while (openObjects > 0) {
    repaired += '}';
    openObjects--;
  }

  return repaired;
}


// ── Token 估算 ──────────────────────────────────────────────

/**
 * 估算 max output tokens。
 * 翻译 ratio 约 1:1（JSON 格式输入 → JSON 格式输出），
 * 留 6x 余量应对中文扩词以及 JSON 字段包装（id、translated_text 等），上限 131072。
 */
export function estimateMaxTokens(inputJson: string): number {
  const estimatedInputTokens = Math.ceil(inputJson.length * 0.5);
  return Math.min(131072, Math.max(2048, estimatedInputTokens * 6));
}

// ── System Prompt ────────────────────────────────────────────

/**
 * 默认 system prompt：金庸风格（半文半白、武侠韵味、技术准确）。
 */
export function buildSystemContent(
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary
): string {
  return buildJinyongSystemContent(sourceLang, targetLang, glossary);
}

/**
 * 备选 system prompt：通用直译风格。
 * 当调用方需要更保守、更传统的技术翻译时使用。
 */
export function buildDefaultSystemContent(
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
4. Treat every block as independent — do not skip, summarize, merge, or reorder any block.

Translation style:

- Use natural, idiomatic Simplified Chinese.
- Avoid literal English sentence structures.
- Translate generic "you" and "we" naturally according to context instead of mechanically.
- Omit repeated subjects when natural in Chinese.
- Preserve the original meaning exactly.
`;

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
    thinking: { type: 'disabled' },
  };
}

// ── JSON 清理 ────────────────────────────────────────────────

/**
 * 移除推理模型（qwen3 / deepseek-r1 等）泄漏到 content 的 <think>...</think> 标签。
 *
 * webclaw defense in depth：即使请求时禁用了 thinking（thinking: { type: 'disabled' }），
 * 模型仍可能因配置被忽略、max_tokens 截断、或 API 端 bug 把思考过程包进 content。
 * 一旦 thinking 内容混进 ```json 块，JSON.parse 立刻爆炸。
 *
 * 处理两种情况：
 * 1. 完整：<think>...</think>（正常情况，DOTALL 匹配跨行内容）
 * 2. 截断：<think>... 无 </think>（max_tokens 不足，思考未闭合，去到字符串末尾）
 *
 * 必须在 stripMarkdownCodeBlock 之前调用：thinking 标签可能出现在 ```json
 * 块内部，先去 thinking 再去 markdown 包裹。
 */
export function stripThinkingTags(text: string): string {
  // 去除完整的 <think>...</think>（含内容），[\s\S] 让 . 匹配换行
  let result = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 去除截断的 <think>... 无 </think>（max_tokens 不足时思考未闭合）
  result = result.replace(/<think>[\s\S]*$/gi, '');
  return result.trim();
}

/**
 * 清理 LLM 返回的 JSON：移除 markdown 代码块包裹。
 *
 * 处理两种情况：
 * 1. 完整包裹：```json\n{...}\n```（正常情况）
 * 2. 只有开头 ```json 没有结尾 ```（模型截断/max_tokens 不足）
 *
 * 旧正则要求结尾 ```，截断时不匹配，导致 JSON.parse("```json\n{...") 报
 * "Unexpected token '`'"。改为先去开头再去结尾，两种情况都能处理。
 */
export function stripMarkdownCodeBlock(text: string): string {
  let trimmed = text.trim();
  // 去除开头的 ```json 或 ```（无论有没有结尾 ```）
  trimmed = trimmed.replace(/^```(?:json)?\s*\n?/, '');
  // 去除结尾的 ```（如果有）
  trimmed = trimmed.replace(/\s*```\s*$/, '');
  return trimmed.trim();
}

/**
 * 清理 JSON：修复尾随逗号。
 */
export function cleanJsonString(str: string): string {
  return str.replace(/,\s*([}\]])/g, '$1');
}
