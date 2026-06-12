import { describe, it, expect, beforeEach } from 'vitest';
import {
  getGlossary,
  addUserTerms,
  removeUserTerm,
  clearUserTerms,
  setDocumentTerms,
  clearDocumentTerms,
  mergeForPrompt,
} from '../lib/translate/glossaryStore';
import { setDefaultStorage, MapStorage } from '../lib/storage';

class CountingStorage extends MapStorage {
  getJSONCount = 0;

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    this.getJSONCount++;
    return super.getJSON<T>(key);
  }
}

describe('glossaryStore', () => {
  beforeEach(() => {
    // 每个测试都注入全新的 default storage，避免污染
    setDefaultStorage(new MapStorage('test:glossary-' + Math.random().toString(36).slice(2)));
  });

  it('getGlossary returns empty arrays when nothing stored', async () => {
    const g = await getGlossary();
    expect(g).toEqual({ user_terms: [], document_terms: [] });
  });

  it('addUserTerms dedupes and persists', async () => {
    await addUserTerms(['React', 'API', 'React', ' Vue ']);
    const g = await getGlossary();
    expect(g.user_terms).toContain('React');
    expect(g.user_terms).toContain('API');
    expect(g.user_terms).toContain('Vue'); // trimmed
    expect(g.user_terms).toHaveLength(3);
    expect([...g.user_terms].sort()).toEqual([...g.user_terms]);
  });

  it('addUserTerms appends, does not replace', async () => {
    await addUserTerms(['A']);
    await addUserTerms(['B']);
    const g = await getGlossary();
    expect(g.user_terms).toEqual(['A', 'B']);
  });

  it('removeUserTerm is case-insensitive', async () => {
    await addUserTerms(['React', 'API']);
    const g = await removeUserTerm('react');
    expect(g.user_terms).toEqual(['API']);
  });

  it('removeUserTerm handles missing term gracefully', async () => {
    await addUserTerms(['A']);
    const g = await removeUserTerm('nonexistent');
    expect(g.user_terms).toEqual(['A']);
  });

  it('clearUserTerms empties only user_terms', async () => {
    await addUserTerms(['A']);
    await setDocumentTerms(['doc1']);
    const g = await clearUserTerms();
    expect(g.user_terms).toEqual([]);
    expect(g.document_terms).toEqual(['doc1']);
  });

  it('setDocumentTerms replaces previous value', async () => {
    await setDocumentTerms(['old']);
    await setDocumentTerms(['new1', 'new2']);
    const g = await getGlossary();
    expect(g.document_terms).toEqual(['new1', 'new2']);
  });

  it('clearDocumentTerms empties only document_terms', async () => {
    await addUserTerms(['A']);
    await setDocumentTerms(['doc1']);
    const g = await clearDocumentTerms();
    expect(g.document_terms).toEqual([]);
    expect(g.user_terms).toEqual(['A']);
  });

  it('mergeForPrompt combines + dedupes + sorts', () => {
    const g = { user_terms: ['B', 'A'], document_terms: ['C', 'A'] };
    expect(mergeForPrompt(g)).toEqual(['A', 'B', 'C']);
  });

  it('mutation returns updated glossary without rereading both term lists', async () => {
    const storage = new CountingStorage('test:glossary-count');
    setDefaultStorage(storage);
    await setDocumentTerms(['Doc']);
    storage.getJSONCount = 0;

    const g = await addUserTerms(['React']);

    expect(g).toEqual({ user_terms: ['React'], document_terms: ['Doc'] });
    // addUserTerms 只需读 user_terms 合并，再读 document_terms 组装返回值。
    expect(storage.getJSONCount).toBe(2);
  });
});
