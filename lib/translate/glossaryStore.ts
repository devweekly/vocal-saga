/**
 * 术语表持久层。
 *
 * 存储模型：所有词条都存在同一个 default storage 上，按前缀区分：
 *   glossary:user_terms       string[]
 *   glossary:document_terms   string[]
 *
 * 入口（lib/app.ts 的 createApp）会在启动时注入一个 storage adapter
 * （Netlify Blobs / Cloudflare KV / 内存 Map）。
 * 单测时由 tests/setup.ts 注入 MapStorage。
 */
import { getDefaultStorage } from '../storage';

const USER_TERMS_KEY = 'glossary:user_terms';
const DOC_TERMS_KEY = 'glossary:document_terms';

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

export interface Glossary {
  user_terms: string[];
  document_terms: string[];
}

export async function getGlossary(): Promise<Glossary> {
  const [user_terms, document_terms] = await Promise.all([
    loadTerms(USER_TERMS_KEY),
    loadTerms(DOC_TERMS_KEY),
  ]);
  return { user_terms, document_terms };
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

/**
 * 同步 user + document 两种 term，过滤掉重复，得到传给 LLM 的最终列表。
 */
export function mergeForPrompt(glossary: Glossary): string[] {
  return Array.from(new Set([...glossary.user_terms, ...glossary.document_terms])).sort();
}
