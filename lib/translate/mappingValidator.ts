/**
 * 翻译映射校验（mapping validation）
 * =============================================================================
 * 检测单个 block 的「原文」与「译文」在信息量上是否严重不匹配，从而发现
 * block id 错配（例如标题拿到了正文的译文、正文拿到了标题的译文）。
 *
 * 为什么需要它：
 *   - 之前的 mitsloan 故障就是 D1 缓存跨路径污染导致 block id 错位，
 *     标题被填上了正文段落的译文。这种错位单看译文质量没问题，
 *     但「短原文 ↔ 长译文」的长度/句子数反差会立刻暴露。
 *
 * 信号选择（避免误报）：
 *   - 中文比英文密度高，纯字符长度比对会产生误报，因此用【非对称区间】
 *     +【句子数】双信号，且对「较长原文才检查过短」以降低短文压缩的误报。
 *   - 句子数对语言密度不敏感：标题通常 1 句、正文多句；原文 1 句译文 5 句
 *     是强烈错配信号，与中英文无关。
 *
 * 默认行为：仅返回 verdict（是否可疑 + 原因），由调用方决定 log-only 还是
 * 严格剔除。不修改任何翻译结果。
 */

export interface MappingVerdict {
  origChars: number;
  transChars: number;
  origSentences: number;
  transSentences: number;
  /** transChars / origChars；origChars 为 0 时：transChars 也为 0 → 1，否则 Infinity */
  charRatio: number;
  /** transSentences / origSentences；origSentences 为 0 时：transSentences 也为 0 → 1，否则 Infinity */
  sentenceRatio: number;
  suspect: boolean;
  reasons: string[];
}

export interface MappingOptions {
  /** 译文过长的阈值（transChars / origChars 上限），默认 3.5 */
  maxCharRatio?: number;
  /** 译文过短的阈值（transChars / origChars 下限），默认 0.2 */
  minCharRatio?: number;
  /** 句子数激增阈值（transSentences / origSentences 上限），默认 2.5。
   *  设 2.5 是因为：标题（1 句）若拿到正文（3+ 句）译文，比值为 3 > 2.5 即告警；
   *  而正常的 2 句→3 句（比值 1.5）不会误报。中文密度高，字符比在此类错配中不可靠，
   *  句子数是更稳健的信号。 */
  maxSentenceRatio?: number;
  /** 句子数骤减阈值（transSentences / origSentences 下限），默认 0.34 */
  minSentenceRatio?: number;
  /** 触发字符比判定所需的最小绝对字符差，默认 25（过滤微小波动） */
  minAbsoluteChars?: number;
  /** 启用「过短」字符比判定所需的原文最小字符数，默认 40（短文压缩属正常） */
  minOrigCharsForShortCheck?: number;
}

/**
 * 统计句子数（中英文通用）。
 * 以 . ! ? ; 及中文 。 ！ ？ ； 以及换行作为句末切分，过滤空片段。
 * 空串返回 0；普通单句文本返回 1。
 */
export function countSentences(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/[\n\r]+/g, '。');
  const parts = normalized.split(/[.!?;。！？；]+/);
  let count = 0;
  for (const raw of parts) {
    const t = raw.trim();
    if (t.length === 0) continue;
    // 过滤纯符号/数字片段（不含任何字母或汉字）
    if (!/[一-鿿a-zA-Z]/.test(t)) continue;
    count++;
  }
  return count;
}

/**
 * 校验单个 block 的原文/译文映射是否可疑。
 */
export function validateBlockMapping(
  original: string,
  translated: string,
  opts: MappingOptions = {}
): MappingVerdict {
  const maxCharRatio = opts.maxCharRatio ?? 3.5;
  const minCharRatio = opts.minCharRatio ?? 0.2;
  const maxSentenceRatio = opts.maxSentenceRatio ?? 2.5;
  const minSentenceRatio = opts.minSentenceRatio ?? 0.34;
  const minAbs = opts.minAbsoluteChars ?? 25;
  const minOrigForShort = opts.minOrigCharsForShortCheck ?? 40;

  const origChars = (original || '').replace(/\s/g, '').length;
  const transChars = (translated || '').replace(/\s/g, '').length;
  const origSentences = countSentences(original || '');
  const transSentences = countSentences(translated || '');

  const charRatio =
    origChars === 0 ? (transChars === 0 ? 1 : Infinity) : transChars / origChars;
  const sentenceRatio =
    origSentences === 0
      ? transSentences === 0
        ? 1
        : Infinity
      : transSentences / origSentences;

  const reasons: string[] = [];
  const absDiff = Math.abs(transChars - origChars);

  // 原文为空却有译文：异常映射
  if (origChars === 0 && transChars > 0) {
    reasons.push('原文为空却有译文');
  }

  // 字符比判定（需达到一定绝对差，避免微小波动误报）
  if (absDiff >= minAbs && origChars > 0) {
    if (charRatio > maxCharRatio) {
      reasons.push(`译文过长：字符比 ${charRatio.toFixed(2)} > ${maxCharRatio}`);
    }
    // 仅对较长原文检查「过短」：短文（如标题）压缩成更短中文属正常
    if (origChars > minOrigForShort && charRatio < minCharRatio) {
      reasons.push(`译文过短：字符比 ${charRatio.toFixed(2)} < ${minCharRatio}`);
    }
  }

  // 句子数比判定（对语言密度不敏感，是更稳健的错配信号）
  if (origSentences >= 1 && transSentences >= 1) {
    if (sentenceRatio > maxSentenceRatio) {
      reasons.push(`句子数激增：比 ${sentenceRatio.toFixed(2)} > ${maxSentenceRatio}`);
    }
    if (sentenceRatio < minSentenceRatio) {
      reasons.push(`句子数骤减：比 ${sentenceRatio.toFixed(2)} < ${minSentenceRatio}`);
    }
  }

  return {
    origChars,
    transChars,
    origSentences,
    transSentences,
    charRatio,
    sentenceRatio,
    suspect: reasons.length > 0,
    reasons,
  };
}
