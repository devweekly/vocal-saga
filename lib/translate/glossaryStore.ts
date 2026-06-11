/**
 * 术语表持久层。
 *
 * 存储模型：单个 Netlify Blobs store `glossary`，所有词条存为
 *   key: "user_terms"   value: string[]
 *   key: "document_terms" value: string[]（自动从文章抽取的，可清空）
 *
 * Netlify Blobs 部署时使用真实 store；单测时使用 tests/setup.ts mock。
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'glossary';
const USER_TERMS_KEY = 'user_terms';
const DOC_TERMS_KEY = 'document_terms';

function getGlossaryStore() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

async function loadTerms(key: string): Promise<string[]> {
  try {
    const data = await getGlossaryStore().get(key, { type: 'json' });
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
    await getGlossaryStore().setJSON(key, unique);
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
