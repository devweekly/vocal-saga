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

describe('glossaryStore', () => {
  beforeEach(() => {
    // 重置 blob store 状态
    const all = (globalThis as any).__blobStores as Record<string, Map<string, unknown>>;
    if (all) for (const m of Object.values(all)) m.clear();
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
});
