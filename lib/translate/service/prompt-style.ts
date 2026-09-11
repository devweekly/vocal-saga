/**
 * 文风调度：把 `PromptStyle` 映射到具体的 prompt 构建函数。
 *
 * 本文件是**唯一**的调度出口 —— 两端（fanyi-extension 的 `deepseek.ts` /
 * vocal-saga 的 `shared.ts`）都只调用 `buildStyledSystemContent`，
 * 因此"某个文风走哪个 prompt"这件事两端不可能漂移。
 *
 * 各文风只提供 persona 段落，契约 / 安全策略 / 术语表 / 输出格式全部由
 * prompt-contract.ts 统一拼装（见该文件说明）。
 */

import type { Glossary } from './_service';
import { buildDefaultSystemContent } from './default-prompt';
import { buildJinyongSystemContent } from './jinyong-prompt';
import { buildAchengSystemContent } from './acheng-prompt';
import { buildWangxiaoboSystemContent } from './wangxiaobo-prompt';
import { buildJapaneseNaturalZhSystemContent } from './japanese-natural-zh-prompt';

/**
 * 翻译文风选项：
 * - `default`           通用自然翻译（默认）
 * - `jinyong`           雅致、从容、略带传统叙事节奏
 * - `acheng`            白描、克制、观察性、具体
 * - `wangxiaobo`        理性、清晰、自然、克制
 * - `ja-source-natural` 日语原文 → 自然中文（保留日文论述的克制感）
 *
 * 命名说明：用 `ja-source-natural` 而不是 `ja-natural`，避免被理解成
 * 反方向的「中文 → 日语自然化」。本模式只在**源语言检测为日语**时启用。
 */
export type PromptStyle = 'default' | 'jinyong' | 'acheng' | 'wangxiaobo' | 'ja-source-natural';

/**
 * 按文风构建 system prompt。
 *
 * `ja-source-natural` 带一道护栏：目标语言是日语时回退通用直译。
 * ja → ja 无意义；zh → ja 属于「日语自然化」方向，与本模式无关。
 * 配置过期 / 手工错配时宁可走 default，也不能用错 prompt 产出坏结果。
 *
 * 站点规则（sitePrompt）不在这里处理：那是扩展端特有的注入，
 * 由调用方在本函数返回值之后追加。
 */
export function buildStyledSystemContent(
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
    case 'ja-source-natural': {
      if ((targetLang || '').toLowerCase().startsWith('ja')) {
        return buildDefaultSystemContent(sourceLang, targetLang, glossary);
      }
      return buildJapaneseNaturalZhSystemContent(sourceLang, targetLang, glossary);
    }
    default:
      return buildDefaultSystemContent(sourceLang, targetLang, glossary);
  }
}
