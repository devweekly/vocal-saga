import { describe, it, expect, beforeEach } from 'vitest';
import {
  getGlossary,
  addUserTerms,
  removeUserTerm,
  clearUserTerms,
  setDocumentTerms,
  clearDocumentTerms,
  setHardTerms,
  clearHardTerms,
  setSoftTerms,
  clearSoftTerms,
  mergeForPrompt,
} from '../lib/translate/glossaryStore';
import { setDefaultStorage, MapStorage } from '../lib/storage';

describe('glossaryStore', () => {
  beforeEach(() => {
    // 每个测试都注入全新的 default storage，避免污染
    setDefaultStorage(new MapStorage('test:glossary-' + Math.random().toString(36).slice(2)));
  });

  it('getGlossary returns empty arrays when nothing stored', async () => {
    const g = await getGlossary();
    expect(g).toEqual({
      user_terms: [],
      document_terms: [],
      hard_terms: [],
      soft_terms: [],
    });
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
    const g = {
      user_terms: ['B', 'A'],
      document_terms: ['C', 'A'],
      hard_terms: [],
      soft_terms: [],
    };
    expect(mergeForPrompt(g)).toEqual(['A', 'B', 'C']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hard_terms / soft_terms（2026-09-11 新增的「生产端」）
//
// 这两个字段由 service/glossaryTerms.ts 的 renderTermTranslations 消费；
// 在此之前两端都没有任何代码构造它们，属「只有消费端没有生产端」。
// ─────────────────────────────────────────────────────────────────────────────

describe('glossaryStore — hard_terms / soft_terms', () => {
  beforeEach(() => {
    setDefaultStorage(new MapStorage('test:glossary-pairs-' + Math.random().toString(36).slice(2)));
  });

  it('setHardTerms 持久化并按 source 排序', async () => {
    await setHardTerms([
      { source: 'Repository', target: '仓库' },
      { source: 'API', target: '接口' },
    ]);
    const g = await getGlossary();
    expect(g.hard_terms).toEqual([
      { source: 'API', target: '接口' },
      { source: 'Repository', target: '仓库' },
    ]);
  });

  it('setHardTerms 会 trim、丢弃空 source/target、去重', async () => {
    await setHardTerms([
      { source: '  API  ', target: '  接口 ' },
      { source: 'API', target: '接口' }, // 与上一条归一化后重复
      { source: '', target: '空 source' },
      { source: 'NoTarget', target: '' },
    ]);
    const g = await getGlossary();
    expect(g.hard_terms).toEqual([{ source: 'API', target: '接口' }]);
  });

  it('source 相同但 target 不同的条目都保留', async () => {
    await setHardTerms([
      { source: 'API', target: '接口' },
      { source: 'API', target: 'API' },
    ]);
    const g = await getGlossary();
    expect(g.hard_terms).toHaveLength(2);
  });

  it('条目总数上限 50', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      source: `Term${i}`,
      target: `术语${i}`,
    }));
    await setHardTerms(many);
    const g = await getGlossary();
    expect(g.hard_terms).toHaveLength(50);
  });

  it('setHardTerms 整体替换（不是追加）', async () => {
    await setHardTerms([{ source: 'Old', target: '旧' }]);
    await setHardTerms([{ source: 'New', target: '新' }]);
    const g = await getGlossary();
    expect(g.hard_terms).toEqual([{ source: 'New', target: '新' }]);
  });

  it('clearHardTerms 只清 hard_terms，不影响 soft / doc / user', async () => {
    await addUserTerms(['A']);
    await setDocumentTerms(['doc1']);
    await setHardTerms([{ source: 'API', target: '接口' }]);
    await setSoftTerms([{ source: 'Repo', target: '仓库' }]);

    const g = await clearHardTerms();
    expect(g.hard_terms).toEqual([]);
    expect(g.soft_terms).toEqual([{ source: 'Repo', target: '仓库' }]);
    expect(g.document_terms).toEqual(['doc1']);
    expect(g.user_terms).toEqual(['A']);
  });

  it('clearSoftTerms 只清 soft_terms，不影响 hard / doc / user', async () => {
    await addUserTerms(['A']);
    await setDocumentTerms(['doc1']);
    await setHardTerms([{ source: 'API', target: '接口' }]);
    await setSoftTerms([{ source: 'Repo', target: '仓库' }]);

    const g = await clearSoftTerms();
    expect(g.soft_terms).toEqual([]);
    expect(g.hard_terms).toEqual([{ source: 'API', target: '接口' }]);
    expect(g.document_terms).toEqual(['doc1']);
    expect(g.user_terms).toEqual(['A']);
  });

  it('存储层被写脏时读取仍返回合法 TermPair[]', async () => {
    // 模拟历史脏数据：混入 null / 非对象 / 缺字段 / 非字符串
    const storage = new MapStorage('test:glossary-dirty-' + Math.random().toString(36).slice(2));
    setDefaultStorage(storage);
    await storage.setJSON('glossary:hard_terms', [
      { source: 'API', target: '接口' },
      null,
      'not-an-object',
      { source: 'OnlySource' },
      { source: 42, target: 'x' },
      { source: 'OK', target: '好' },
    ]);

    const g = await getGlossary();
    expect(g.hard_terms).toEqual([
      { source: 'API', target: '接口' },
      { source: 'OK', target: '好' },
    ]);
  });
});
