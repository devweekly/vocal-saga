/**
 * 翻译服务共享工具函数。
 *
 * 所有 LLM 服务（DeepSeek / OpenRouter / NVIDIA / Cloudflare）共用。
 */

import { jsonrepair } from 'jsonrepair';
import type { Glossary } from './_service';
import { buildJinyongSystemContent } from './jinyong-prompt';
import { buildAchengSystemContent } from './acheng-prompt';
import { buildWangxiaoboSystemContent } from './wangxiaobo-prompt';

// ── Prompt Style ────────────────────────────────────────────

/** 翻译文风选项：default=通用直译, jinyong=金庸武侠, acheng=阿城白描, wangxiaobo=王小波大白话 */
export type PromptStyle = 'default' | 'jinyong' | 'acheng' | 'wangxiaobo';

// ── JSON 修复 ────────────────────────────────────────────────

/**
 * 通用 JSON 修复：包装 jsonrepair 库处理 LLM 偶发输出错误。
 *
 * jsonrepair 能修复：
 * - 截断（max_tokens 不足导致的未闭合 JSON，会保留已写出的部分内容）
 * - 缺逗号 / 缺引号 / 缺括号
 * - 单引号 → 双引号
 * - 特殊空格 → 普通空格
 * - Python 常量 None/True/False → null/true/false
 * - 尾随逗号
 * - JSON 注释、JSONP 包裹、MongoDB 类型等
 *
 * 注意：jsonrepair 对 "重复引号" 这种 LLM 特有错误修不对（会把
 * `" "text"` 当成合法的 `" \"text"` property name），所以调用方
 * 应先调 cleanJsonString 修复已知模式，再 fallback 到本函数。
 *
 * @throws 当 jsonrepair 也无法修复、或修复结果不是对象/数组时抛错
 */
export function repairJson(str: string): string {
  const repaired = jsonrepair(str);
  // 防御：jsonrepair 对完全无法识别的输入（如纯文本 'not json'）会
  // 包装成字符串 '"not json"'，下游 parsed.translations 会拿到字符串
  // 而不是对象，引发更难排查的 bug。校验修复后必须是 object/array。
  const parsed = JSON.parse(repaired);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`jsonrepair returned non-object: ${repaired.slice(0, 100)}`);
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
 * 根据 style 选择对应的 system prompt 构建函数。
 * - default: 通用直译风格
 * - jinyong / acheng / wangxiaobo: 对应文学风格 prompt
 */
export function buildSystemContent(
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary,
  style?: PromptStyle
): string {
  switch (style) {
    case 'jinyong':
      return buildJinyongSystemContent(sourceLang, targetLang, glossary);
    case 'acheng':
      return buildAchengSystemContent(sourceLang, targetLang, glossary);
    case 'wangxiaobo':
      return buildWangxiaoboSystemContent(sourceLang, targetLang, glossary);
    default:
      return buildDefaultSystemContent(sourceLang, targetLang, glossary);
  }
}

/** 默认通用直译风格 prompt */
function buildDefaultSystemContent(
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary
): string {
  const targetLangName = !targetLang ? 'Simplified Chinese' : targetLang === 'zh' ? 'Simplified Chinese' : targetLang;
  const sourceLangName = !sourceLang ? 'English' : sourceLang === 'en' ? 'English' : sourceLang;

  let systemContent = `Translate ${sourceLangName} to ${targetLangName}.

1. Return {"translations":[{"id":"x","translated_text":"y"}]}. One entry per input block, same ids.
2. For translatable text, provide a translation. Never return empty string or placeholder.
3. Keep URLs, code, and version numbers unchanged. Translate everything else into natural Chinese.
4. Treat every block as independent — do not skip, summarize, merge, or reorder any block.

Translation style:

- Write as if originally written in natural Simplified Chinese.
- Freely restructure sentences to follow natural Chinese expression while preserving every fact.
- Translate generic "you" and "we" naturally according to context instead of mechanically.
- Omit repeated subjects when natural in Chinese.
- Preserve the original meaning exactly.
- Prefer fluent Chinese over mirroring the source wording.
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

Translate all remaining text naturally into Chinese.`;
  }

  return systemContent;
}

// ── 翻译请求体构造 ──────────────────────────────────────────

export function buildTranslationBody(
  blocks: Array<{ id: string; text: string }>,
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary,
  model?: string,
  style?: PromptStyle
) {
  const blocksJson = JSON.stringify(
    blocks.map((b) => ({ id: b.id, text: b.text })),
    null,
    2
  );

  const systemContent = buildSystemContent(sourceLang, targetLang, glossary, style);

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
    temperature: 0.5,
    max_tokens: estimateMaxTokens(blocksJson),
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
 * 清理 JSON：修复 LLM 偶发输出错误。
 *
 * 处理两类问题：
 * 1. 尾随逗号：`{"a":1,}` → `{"a":1}`（旧逻辑）
 * 2. 重复引号（DeepSeek 等模型偶发）：在 property name 前多输出一个引号，
 *    例如 `"id": "b1",\n      " "text": "..."` 应该是 `"text":`。
 *    错误模式下 JSON.parse 报 "Expected ':' after property name"，
 *    因为 parser 把 `" "` 当成空字符串 property name，但后面紧跟 `text` 而非 `:`。
 *
 * 修复策略：限定上下文为逗号/花括号 + 空白 之间，避免误伤合法的 `" "` property name
 * （例如 `{" ":"value"}` 极少见，且要求引号之间至少有一个空白字符）。
 */
export function cleanJsonString(str: string): string {
  return str
    // 1. 去尾随逗号
    .replace(/,\s*([}\]])/g, '$1')
    // 2. 修复 LLM 偶发 " "propName": 重复引号模式（去掉前一个多余的引号和空白）
    .replace(/([,{}]\s*)"(\s+)"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g, '$1"$3":');
}

/**
 * 从可能混有前后散文的 LLM 输出中，抽取最外层的 JSON 对象或数组。
 *
 * 动机：jsonrepair 对"前后夹带了说明文字"的输入容错较差，容易抛
 * "Colon expected" 之类错误。多数坏 JSON 失败的实际结构是——
 *   模型在 JSON 前后加了 "Here is the translation:" / 结尾总结，
 *   或 max_tokens 截断了尾巴（缺最后的 `}`/`]`）。
 * 先定位首个 `{`/`[` 与最后一个匹配的 `}`/`]`，把这段纯净容器交给
 * jsonrepair，修复成功率显著高于直接对整个字符串 repair。
 *
 * 纯 JSON 输入（首个即 `{`/`[`，末尾即 `}`/`]`）会原样返回，无副作用。
 * 找不到任何 JSON 括号时回退为原串（让下游 JSON.parse 报原错）。
 */
export function extractJsonContainer(str: string): string {
  const s = str.trim();
  if (!s) return str;

  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  // 没有 JSON 括号：直接回退
  if (firstObj === -1 && firstArr === -1) return str;

  let start: number;
  let close: string;
  if (firstArr === -1 || (firstObj !== -1 && firstObj < firstArr)) {
    start = firstObj;
    close = '}';
  } else {
    start = firstArr;
    close = ']';
  }

  const lastClose = s.lastIndexOf(close);
  // 找不到闭合括号，或闭合在开头之前（异常）：回退
  if (lastClose <= start) return str;

  return s.slice(start, lastClose + 1);
}
