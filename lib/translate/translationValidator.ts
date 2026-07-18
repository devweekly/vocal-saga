// 翻译完整性校验 — 检查缓存的 HTML 是否包含完整的翻译
//
// 当前 isHealthyCachedHtml（lib/app.ts）只检查结构（<html> 标签 + 样式表），
// 不检查翻译是否完整。此模块提供更严格的校验：
//   1. 基本结构（<html> 标签 + 长度）
//   2. 翻译标记存在（.fanyi-translation / data-fanyi-translated 等）
//   3. 翻译数量足够（可选，传入预期 block 数量时校验，允许 10% 误差）
//   4. 翻译内容非空（超过 50% 为空 → 视为损坏）
//
// 标记命名与 fanyi-extension 的 translationDisplay.ts 保持一致：
//   - <span class="fanyi-original"> 原文
//   - <span class="fanyi-translation"> 译文

export interface ValidationResult {
  healthy: boolean;
  reason?: string;
  blockCount: number;
  translatedCount: number;
}

/**
 * 校验缓存的 HTML 是否包含完整的翻译。
 *
 * @param html 缓存的 HTML
 * @param expectedBlockCount 预期的 block 数量（可选，不传则只检查结构 + 标记）
 */
export function validateTranslationCompleteness(
  html: string,
  expectedBlockCount?: number,
): ValidationResult {
  // 1. 基本结构检查
  if (!html || html.length < 100) {
    return { healthy: false, reason: 'HTML 过短或为空', blockCount: 0, translatedCount: 0 };
  }

  if (!html.includes('<html')) {
    return { healthy: false, reason: '缺少 <html> 标签', blockCount: 0, translatedCount: 0 };
  }

  // 2. 翻译标记检查
  // fanyi-extension 的双语标记：.fanyi-translation / .fanyi-original / data-fanyi-* 属性
  const translationMarkers = [
    'fanyi-translation',
    'data-fanyi-translated',
    'fanyi-original',
  ];

  let hasTranslationMarker = false;
  for (const marker of translationMarkers) {
    if (html.includes(marker)) {
      hasTranslationMarker = true;
      break;
    }
  }

  if (!hasTranslationMarker) {
    return {
      healthy: false,
      reason: '未找到翻译标记（fanyi-translation / fanyi-original 等）',
      blockCount: 0,
      translatedCount: 0,
    };
  }

  // 3. 统计翻译的 block 数量
  const translationCount = (html.match(/fanyi-translation/g) || []).length;
  const originalCount = (html.match(/fanyi-original/g) || []).length;
  const blockCount = Math.max(translationCount, originalCount);

  // 4. 如果传了预期数量，检查是否足够（允许 10% 误差）
  if (expectedBlockCount !== undefined && expectedBlockCount > 0) {
    const minRequired = Math.floor(expectedBlockCount * 0.9);
    if (translationCount < minRequired) {
      return {
        healthy: false,
        reason: `翻译不完整: ${translationCount}/${expectedBlockCount}（需要至少 ${minRequired}）`,
        blockCount,
        translatedCount: translationCount,
      };
    }
  }

  // 5. 检查翻译内容是否为空（只有标记没有内容）
  // 至少 50% 的 .fanyi-translation 必须有非空文本。
  // 用 [^<]*（零个或多个）而非 [^<]+（一个或多个），
  // 这样空译文（<span class="fanyi-translation"></span>）也会被计入 totalTranslations，
  // 才能让 50% 非空校验真正生效。
  const translationRegex = /class="[^"]*fanyi-translation[^"]*"[^>]*>([^<]*)</g;
  let totalTranslations = 0;
  let nonEmptyTranslations = 0;
  let match: RegExpExecArray | null;
  while ((match = translationRegex.exec(html)) !== null) {
    totalTranslations++;
    if (match[1].trim().length > 0) {
      nonEmptyTranslations++;
    }
  }

  if (totalTranslations > 0 && nonEmptyTranslations / totalTranslations < 0.5) {
    return {
      healthy: false,
      reason: `超过 50% 的翻译为空（${nonEmptyTranslations}/${totalTranslations}）`,
      blockCount,
      translatedCount: nonEmptyTranslations,
    };
  }

  return {
    healthy: true,
    blockCount,
    translatedCount: nonEmptyTranslations,
  };
}

/**
 * 简化版健康检查（向后兼容原有 isHealthyCachedHtml 的 boolean 返回值）
 */
export function isHealthyTranslation(html: string, expectedBlockCount?: number): boolean {
  return validateTranslationCompleteness(html, expectedBlockCount).healthy;
}
