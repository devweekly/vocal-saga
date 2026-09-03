/**
 * pipeline.withSiteDocumentTerms 单测。
 *
 * 站点规则里的 documentTerms（GitHub / Hacker News / Fortune 手工维护的
 * 专有名词表）长期是**死数据**：除了一个没有生产调用方的 buildSitePrompt
 * 之外没人读它。现在由本函数合并进 glossary，最终进入 system prompt。
 *
 * 这里锁定合并语义，避免后人改成"替换"（会丢掉调用方传入的自定义术语）。
 */
import { describe, it, expect } from 'vitest';
import { withSiteDocumentTerms } from '../lib/translate/pipeline';

describe('withSiteDocumentTerms', () => {
  it('命中站点规则时合并该站点的 documentTerms', () => {
    const out = withSiteDocumentTerms(undefined, 'https://github.com/foo/bar');
    expect(out?.document_terms).toContain('Pull requests');
    expect(out?.document_terms).toContain('README');
  });

  it('保留调用方已有的自定义术语（追加而非替换）', () => {
    const out = withSiteDocumentTerms(
      { document_terms: ['MyProduct'] },
      'https://github.com/foo/bar'
    );
    expect(out?.document_terms).toContain('MyProduct');
    expect(out?.document_terms).toContain('Pull requests');
  });

  it('未命中站点规则时原样返回（不新增字段）', () => {
    const glossary = { document_terms: ['LLM'] };
    // undefined 入参：直接返回原引用
    expect(withSiteDocumentTerms(glossary, 'https://example.com/a')).toBe(glossary);
  });

  it('未命中站点规则且 glossary 为 undefined 时返回 undefined', () => {
    expect(withSiteDocumentTerms(undefined, 'https://example.com/a')).toBeUndefined();
  });

  it('Reddit 的 UI 术语同样被合并', () => {
    const out = withSiteDocumentTerms(undefined, 'https://reddit.com/r/programming/');
    expect(out?.document_terms).toContain('Upvote');
    expect(out?.document_terms).toContain('Subreddit');
  });

  it('命中站点规则但该站点没有 documentTerms 时不改动 glossary', () => {
    // arxiv 只有 skipSelectors / skipTextPatterns，没有 documentTerms
    const glossary = { document_terms: ['LLM'] };
    expect(withSiteDocumentTerms(glossary, 'https://arxiv.org/abs/2401.00001')).toBe(glossary);
  });

  it('hostPattern 是精确匹配，www 子域不命中', () => {
    // reddit.com 的 hostPattern 是 'reddit.com'（非通配），www.reddit.com 不命中
    const glossary = { document_terms: ['LLM'] };
    expect(withSiteDocumentTerms(glossary, 'https://www.reddit.com/r/programming/')).toBe(
      glossary
    );
  });

  it('URL 非法时安全降级（matchSiteRule 返回 null，不抛错）', () => {
    const glossary = { document_terms: ['LLM'] };
    expect(() => withSiteDocumentTerms(glossary, 'not-a-url')).not.toThrow();
    expect(withSiteDocumentTerms(glossary, 'not-a-url')).toBe(glossary);
  });
});
