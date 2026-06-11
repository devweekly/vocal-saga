export function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & 0x7fffffff;
  }
  return hash;
}

export function generateTranslationCacheKey(
  jsonContent: string,
  sourceLang: string,
  targetLang: string
): string {
  const contentHash = simpleHash(jsonContent);
  const contentPrefix = jsonContent.substring(0, 200);
  const prefixHash = simpleHash(contentPrefix);
  return `translation_${sourceLang}_${targetLang}_${contentHash}_${prefixHash}`;
}
