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
  const unique = normalizeTerms(terms);
  try {
    await getDefaultStorage().setJSON(key, unique);
  } catch (err) {
    console.warn(`[glossaryStore] save ${key} failed:`, (err as Error).message);
    throw err;
  }
}

// 去重 + 排序（保稳定），保存和 API 返回共用同一套规整逻辑。
function normalizeTerms(terms: string[]): string[] {
  return Array.from(new Set(terms.map((t) => t.trim()).filter(Boolean))).sort();
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
  const merged = normalizeTerms([...existing, ...terms]);
  await saveTerms(USER_TERMS_KEY, merged);
  return { user_terms: merged, document_terms: await loadTerms(DOC_TERMS_KEY) };
}

export async function removeUserTerm(term: string): Promise<Glossary> {
  const existing = await loadTerms(USER_TERMS_KEY);
  const filtered = normalizeTerms(existing.filter((t) => t.toLowerCase() !== term.toLowerCase()));
  await saveTerms(USER_TERMS_KEY, filtered);
  return { user_terms: filtered, document_terms: await loadTerms(DOC_TERMS_KEY) };
}

export async function clearUserTerms(): Promise<Glossary> {
  await saveTerms(USER_TERMS_KEY, []);
  return { user_terms: [], document_terms: await loadTerms(DOC_TERMS_KEY) };
}

export async function setDocumentTerms(terms: string[]): Promise<Glossary> {
  const document_terms = normalizeTerms(terms);
  await saveTerms(DOC_TERMS_KEY, document_terms);
  return { user_terms: await loadTerms(USER_TERMS_KEY), document_terms };
}

export async function clearDocumentTerms(): Promise<Glossary> {
  await saveTerms(DOC_TERMS_KEY, []);
  return { user_terms: await loadTerms(USER_TERMS_KEY), document_terms: [] };
}

/**
 * 同步 user + document 两种 term，过滤掉重复，得到传给 LLM 的最终列表。
 */
export function mergeForPrompt(glossary: Glossary): string[] {
  return Array.from(new Set([...glossary.user_terms, ...glossary.document_terms])).sort();
}
