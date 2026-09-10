/**
 * 术语表持久层。
 *
 * 存储模型：所有词条都存在同一个 default storage 上，按前缀区分：
 *   glossary:user_terms       string[]
 *   glossary:document_terms   string[]
 *   glossary:hard_terms       TermPair[]  —— 强制术语（必须按 target 翻译）
 *   glossary:soft_terms       TermPair[]  —— 建议术语（语境合适时优选）
 *
 * 前两者是「保留原文」的单词列表；后两者是 `{source, target}` 术语对，
 * 由 `service/glossaryTerms.ts` 的 `renderTermTranslations` 渲染进 system prompt。
 *
 * 入口（lib/app.ts 的 createApp）会在启动时注入一个 storage adapter
 * （Netlify Blobs / Cloudflare KV / 内存 Map）。
 * 单测时由 tests/setup.ts 注入 MapStorage。
 */
import { getDefaultStorage } from '../storage';

const USER_TERMS_KEY = 'glossary:user_terms';
const DOC_TERMS_KEY = 'glossary:document_terms';
const HARD_TERMS_KEY = 'glossary:hard_terms';
const SOFT_TERMS_KEY = 'glossary:soft_terms';

/**
 * 单条术语对的上限，与 `service/glossaryTerms.ts` 的 `MAX_TERM_COUNT` 保持一致。
 * 超出部分在 prompt 侧也会被截断，这里提前截断避免存无用数据。
 */
const MAX_PAIR_COUNT = 50;

async function loadTerms(key: string): Promise<string[]> {
  try {
    const data = await getDefaultStorage().getJSON<string[]>(key);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`[glossaryStore] load ${key} failed:`, (err as Error).message);
    return [];
  }
}

async function saveTerms(key: string, terms: string[]): Promise<void> {
  // 去重 + 排序（保稳定）
  const unique = Array.from(new Set(terms.map((t) => t.trim()).filter(Boolean))).sort();
  try {
    await getDefaultStorage().setJSON(key, unique);
  } catch (err) {
    console.warn(`[glossaryStore] save ${key} failed:`, (err as Error).message);
    throw err;
  }
}

/** 一条 `{source, target}` 术语对（`hard_terms` / `soft_terms` 的元素）。 */
export interface TermPair {
  source: string;
  target: string;
}

async function loadPairs(key: string): Promise<TermPair[]> {
  try {
    const data = await getDefaultStorage().getJSON<TermPair[]>(key);
    if (!Array.isArray(data)) return [];
    // 存储层可能被外部写脏：读取时再过滤一遍，保证调用方拿到的一定是合法 TermPair[]
    return data
      .filter((p): p is TermPair => !!p && typeof p === 'object')
      .map((p) => ({
        source: typeof p.source === 'string' ? p.source.trim() : '',
        target: typeof p.target === 'string' ? p.target.trim() : '',
      }))
      .filter((p) => p.source && p.target)
      .slice(0, MAX_PAIR_COUNT);
  } catch (err) {
    console.warn(`[glossaryStore] load ${key} failed:`, (err as Error).message);
    return [];
  }
}

async function savePairs(key: string, pairs: readonly TermPair[]): Promise<void> {
  // 归一化：trim → 丢弃空 source/target → 按 source+target 去重 → 按 source 排序（保稳定）
  const cleaned: TermPair[] = [];
  const seen = new Set<string>();
  for (const raw of pairs) {
    if (!raw || typeof raw !== 'object') continue;
    const source = typeof raw.source === 'string' ? raw.source.trim() : '';
    const target = typeof raw.target === 'string' ? raw.target.trim() : '';
    if (!source || !target) continue;
    const dedupeKey = source + '\u0000' + target;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    cleaned.push({ source, target });
    if (cleaned.length >= MAX_PAIR_COUNT) break;
  }
  cleaned.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  try {
    await getDefaultStorage().setJSON(key, cleaned);
  } catch (err) {
    console.warn(`[glossaryStore] save ${key} failed:`, (err as Error).message);
    throw err;
  }
}

export interface Glossary {
  user_terms: string[];
  document_terms: string[];
  hard_terms: TermPair[];
  soft_terms: TermPair[];
}

export async function getGlossary(): Promise<Glossary> {
  const [user_terms, document_terms, hard_terms, soft_terms] = await Promise.all([
    loadTerms(USER_TERMS_KEY),
    loadTerms(DOC_TERMS_KEY),
    loadPairs(HARD_TERMS_KEY),
    loadPairs(SOFT_TERMS_KEY),
  ]);
  return { user_terms, document_terms, hard_terms, soft_terms };
}

export async function addUserTerms(terms: string[]): Promise<Glossary> {
  const existing = await loadTerms(USER_TERMS_KEY);
  const merged = Array.from(new Set([...existing, ...terms.map((t) => t.trim()).filter(Boolean)]));
  await saveTerms(USER_TERMS_KEY, merged);
  return getGlossary();
}

export async function removeUserTerm(term: string): Promise<Glossary> {
  const existing = await loadTerms(USER_TERMS_KEY);
  const filtered = existing.filter((t) => t.toLowerCase() !== term.toLowerCase());
  await saveTerms(USER_TERMS_KEY, filtered);
  return getGlossary();
}

export async function clearUserTerms(): Promise<Glossary> {
  await saveTerms(USER_TERMS_KEY, []);
  return getGlossary();
}

export async function setDocumentTerms(terms: string[]): Promise<Glossary> {
  await saveTerms(DOC_TERMS_KEY, terms);
  return getGlossary();
}

export async function clearDocumentTerms(): Promise<Glossary> {
  await saveTerms(DOC_TERMS_KEY, []);
  return getGlossary();
}

/** 整体替换 hard_terms（强制术语对）。 */
export async function setHardTerms(pairs: readonly TermPair[]): Promise<Glossary> {
  await savePairs(HARD_TERMS_KEY, pairs);
  return getGlossary();
}

export async function clearHardTerms(): Promise<Glossary> {
  await savePairs(HARD_TERMS_KEY, []);
  return getGlossary();
}

/** 整体替换 soft_terms（建议术语对）。 */
export async function setSoftTerms(pairs: readonly TermPair[]): Promise<Glossary> {
  await savePairs(SOFT_TERMS_KEY, pairs);
  return getGlossary();
}

export async function clearSoftTerms(): Promise<Glossary> {
  await savePairs(SOFT_TERMS_KEY, []);
  return getGlossary();
}

/**
 * 同步 user + document 两种 term，过滤掉重复，得到传给 LLM 的最终列表。
 */
export function mergeForPrompt(glossary: Glossary): string[] {
  return Array.from(new Set([...glossary.user_terms, ...glossary.document_terms])).sort();
}
