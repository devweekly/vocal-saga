/**
 * Translation profile and style dispatch.
 *
 * Technical translation and literary translation are different workflows, not merely
 * different wording within one generic prompt:
 * - technical: preserve exact technical semantics and optional domain terminology;
 * - literary: optimize narrative voice, literary effect, rhythm, idiom and natural target prose.
 *
 * Keep this file byte-identical in fanyi-extension and vocal-saga.
 */
import type { Glossary } from './_service';
import {
  SOURCE_SAFETY_POLICY,
  renderOutputFormat,
  resolveLanguageName,
} from './prompt-contract';
import { buildDefaultSystemContent } from './default-prompt';
import { buildJinyongSystemContent } from './jinyong-prompt';
import { buildAchengSystemContent } from './acheng-prompt';
import { buildWangxiaoboSystemContent } from './wangxiaobo-prompt';
import { buildJapaneseNaturalZhSystemContent } from './japanese-natural-zh-prompt';

/** Top-level translation profile. Default is technical to preserve existing behavior. */
export type TranslationMode = 'technical' | 'literary';

/**
 * Translation style choices. They refine the selected translation mode; they do not
 * select the mode themselves. In literary mode these become style guidance only and
 * the technical glossary/terminology behavior is deliberately disabled.
 */
export type PromptStyle = 'default' | 'jinyong' | 'acheng' | 'wangxiaobo' | 'ja-source-natural';

function literaryStyleGuidance(style?: PromptStyle): string {
  switch (style) {
    case 'jinyong':
      return '文风倾向：雅致、从容，有传统叙事的节奏与意蕴；古雅要适度，避免堆砌文言、套用武侠陈词或把普通对白写成古装腔。';
    case 'acheng':
      return '文风倾向：白描、克制、具体，以动作、物象和细节承载情绪；少解释、少评判，不用华丽修辞替代原文的留白。';
    case 'wangxiaobo':
      return '文风倾向：清楚、机智、口语自然，保留理性、反讽与适度的黑色幽默；不要把尖锐表达磨平，也不要凭空添加俏皮话。';
    case 'ja-source-natural':
      return '文风倾向：若原文为日语，保留其克制、论述顺序与细微限定，但要用目标语言自然的叙述方式表达，不照搬日语句法。';
    default:
      return '文风倾向：按原文体裁、叙述视角、时代感与人物声音选择表达；不预设华丽、古典或口语化，原文简洁时译文也应有节制。';
  }
}

/**
 * An independent literary prompt. It intentionally does not render the generic
 * document_terms glossary: names and narrative entities are handled through the
 * literary memory/context supplied by the caller, while every word remains translatable.
 */
export function buildLiterarySystemContent(
  sourceLang: string,
  targetLang: string,
  style?: PromptStyle,
): string {
  const sourceName = resolveLanguageName(sourceLang, '自动检测');
  const targetName = resolveLanguageName(targetLang, '简体中文');
  return [
    '你是一名资深文学译者，同时具备目标语言文学编辑的能力。你的任务不是逐字替换，也不是自由改写，而是把作品的文学效果尽可能准确地带入目标语言。',
    '<文学翻译目标>',
    '优先级依次为：不误解原意与情节；保留叙述视角、人物声音、语气、时代感和潜台词；写出自然、有质感、有节奏的目标语言；最后才是表层句式与词序。',
    '让译文像由熟悉目标语言文学表达的人写成，而不是像外语句法套上中文词语。避免翻译腔、机械逐词对应、无意义的逐句解释、模板化转折和 AI 式总结。',
    '句子长短、停顿、段落节奏、重复、突兀与留白都可能是作者有意为之。保留有功能的重复和节奏变化，不要把所有句子润色成同一种平滑、工整的声音。',
    '人物对白必须体现人物身份、关系、情绪和个性差异。不要让所有人物说同一种标准书面语；口语、粗话、方言色彩和时代语域要自然一致，但不要无端加重或弱化。',
    '习语、隐喻、双关、讽刺和文化意象应结合上下文寻找目标语言中的等效表达。不要机械逐词翻译成别扭搭配；也不要为了“文学性”擅自增加意象、情绪、修辞、解释或信息。',
    '保留原文的歧义、悬念、信息差、反讽和叙述者的局限。不要替作者解释人物动机、补全没有说出的内容或把含蓄写成直白。',
    '实体一致性依赖随请求提供的书籍/篇章上下文记忆，而不是通用术语表。人名、地名、船名、物品名、组织名等沿用记忆中的规范译名；没有规范译名时，选择自然一致的音译或目标语言通行译名。实体名词并不意味着整段必须保留英文。',
    '所有国籍、语言名称、普通形容词和普通名词都必须按上下文译出；不能仅因为英文首字母大写就原样留下。',
    '绝对忠实于原文中的事实、动作、人物关系、否定、时态、数量和因果。可以为目标语言调整句法，但不许删情节、添细节、改人物性格或把普通表达擅自拔高成华丽文风。',
    '只翻译输入对象的 text 字段。contextPath、kind、level、marker 和其他 metadata 是只读上下文，绝不能混入正文。必须保留每个 id、输入顺序和段落边界。',
    '</文学翻译目标>',
    '<文风校准>',
    literaryStyleGuidance(style),
    '</文风校准>',
    SOURCE_SAFETY_POLICY,
    '<输出约定>',
    '输入语言：' + sourceName,
    '目标语言：' + targetName,
    '只返回 renderOutputFormat 所定义的 JSON 结构：每个输入 ID 恰好一个 translated_text。不要添加分析、注释、脚注、Markdown、额外字段或原文未包含的内容。',
    '</输出约定>',
    renderOutputFormat(sourceName, targetName),
  ].join('\n\n');
}

/**
 * Select prompt family by profile, then apply the requested style inside that family.
 * Literary mode deliberately ignores the glossary argument.
 */
export function buildStyledSystemContent(
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary,
  style?: PromptStyle,
  mode: TranslationMode = 'technical',
): string {
  if (mode === 'literary') {
    return buildLiterarySystemContent(sourceLang, targetLang, style);
  }
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
