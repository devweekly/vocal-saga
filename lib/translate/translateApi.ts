import { translationCache } from './cacheManager';

export async function getCachedTranslation(cacheKey: string): Promise<Map<string, string> | null> {
  const raw = await translationCache.get<Record<string, string>>(cacheKey);
  if (!raw) return null;
  
  // Convert plain object back to Map for compatibility
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    map.set(key, value);
  }
  return map;
}

export async function cacheTranslation(cacheKey: string, data: Map<string, string>) {
  // Convert Map to plain object for storage compatibility
  const obj: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    obj[key] = value;
  }
  await translationCache.set(cacheKey, obj, 7 * 24 * 60 * 60 * 1000);
}

export function processTranslationResult(jsonResult: string): Map<string, string> {
  const parsed = JSON.parse(jsonResult);
  const translations = parsed.translations || parsed;
  const result = new Map<string, string>();
  for (const item of translations) {
    if (typeof item?.id !== 'string') continue;
    // 模型可能用 `text` / `translated_text` / `translation` 中的任意一个——
    // 都接受。prompt 里说的是 `translated_text`，但实际跑下来模型经常
    // 自由发挥用 `text`，硬编码 `translated_text` 会让 result Map 是空。
    const translated =
      typeof item.translated_text === 'string'
        ? item.translated_text
        : typeof item.text === 'string'
        ? item.text
        : typeof item.translation === 'string'
        ? item.translation
        : null;
    if (translated === null) continue;
    result.set(item.id, translated);
  }
  return result;
}

/**
 * Compare a raw LLM translation response against the original blocks to flag
 * cases where the model silently returned the source text unchanged — a sign
 * that the model refused, hit a content filter, or ignored instructions.
 *
 * LLM-agnostic: works for any translation service that returns the
 * {"translations":[{"id","translated_text"}]} shape. Returns the same JSON
 * string untouched so callers can pass it through to the parser.
 */
export function logUnchangedBlocks(
  rawJson: string,
  originalBlocks: Array<{ id: string; text: string }>
): string {
  try {
    const parsed = JSON.parse(rawJson);
    const translations = parsed.translations || parsed;
    if (!Array.isArray(translations)) return rawJson;

    const byId = new Map(originalBlocks.map((b) => [b.id, b.text]));
    const seenIds = new Set<string>();
    let unchanged = 0;
    let extraIds = 0;
    for (const item of translations) {
      // 同样的字段名宽松：text / translated_text / translation 都认
      const translatedText =
        typeof item.translated_text === 'string'
          ? item.translated_text
          : typeof item.text === 'string'
          ? item.text
          : typeof item.translation === 'string'
          ? item.translation
          : null;
      seenIds.add(item.id);
      const original = byId.get(item.id);
      if (original === undefined) {
        extraIds++;
        continue;
      }
      if (translatedText !== null && translatedText === original) {
        unchanged++;
        console.warn(
          '[TranslateApi] Block',
          item.id,
          'came back unchanged (LLM refused / no-op). Original:',
          original.substring(0, 80)
        );
      }
    }
    // Count input blocks that the model never produced output for.
    const inputMissing = originalBlocks.length - seenIds.size;
    const totalMissing = extraIds + inputMissing;
    const total = originalBlocks.length;
    if (total > 0 && unchanged === translations.length) {
      console.error(
        '[TranslateApi] ALL',
        translations.length,
        'translated blocks came back unchanged — prompt may be too weak or content was filtered'
      );
    } else if (totalMissing > 0) {
      console.warn(
        '[TranslateApi]',
        totalMissing,
        'blocks missing from response (input had',
        total,
        'blocks)'
      );
    } else if (unchanged > 0) {
      console.warn(
        '[TranslateApi]',
        unchanged,
        '/',
        translations.length,
        'blocks returned unchanged'
      );
    }
  } catch {
    // If the raw string isn't valid JSON the downstream parser will throw
    // with a more useful error.
  }
  return rawJson;
}

export async function clearAllCache(): Promise<void> {
  await translationCache.clear();
}
