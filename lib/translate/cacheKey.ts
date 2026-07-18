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
  targetLang: string,
  provider?: string,
  promptStyle?: string,
): string {
  // 把 provider 和 promptStyle 纳入 hash 计算，避免切换 LLM/文风后读到旧 provider 的脏缓存。
  // 仅在显式传入时才参与计算，保证旧调用方（不传 provider/promptStyle）的 key 不变，向后兼容。
  const extra = provider || promptStyle ? `${provider ?? ''}:${promptStyle ?? ''}` : '';
  const contentHash = simpleHash(jsonContent + extra);
  const contentPrefix = jsonContent.substring(0, 200);
  const prefixHash = simpleHash(contentPrefix + extra);
  return `translation_${sourceLang}_${targetLang}_${contentHash}_${prefixHash}`;
}
