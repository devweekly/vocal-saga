import { describe, it, expect } from 'vitest';
import { buildSystemContent, buildDefaultSystemContent } from '../lib/translate/service/shared';

describe('Acheng prompt as default system content', () => {
  it('buildSystemContent returns Acheng-style prompt by default', () => {
    const content = buildSystemContent('en', 'zh');
    expect(content).toContain('Acheng');
    expect(content).toContain('阿城');
    expect(content).toContain('白描');
    expect(content).toContain('动词驱动');
    // 保留输出格式约束
    expect(content).toContain('{"translations":[{"id":"x","translated_text":"y"}]}');
    expect(content).toContain('Translate English to Simplified Chinese');
  });

  it('buildDefaultSystemContent returns the plain legacy prompt', () => {
    const content = buildDefaultSystemContent('en', 'zh');
    expect(content).toContain('Use natural, idiomatic Simplified Chinese');
    expect(content).not.toContain('阿城');
    expect(content).not.toContain('Acheng');
  });

  it('appends glossary terms to Acheng prompt', () => {
    const glossary = { document_terms: ['React', 'Kubernetes'] };
    const content = buildSystemContent('en', 'zh', glossary);
    expect(content).toContain('This page mentions:');
    expect(content).toContain('React');
    expect(content).toContain('Kubernetes');
  });

  it('appends glossary terms to legacy prompt', () => {
    const glossary = { document_terms: ['React', 'Kubernetes'] };
    const content = buildDefaultSystemContent('en', 'zh', glossary);
    expect(content).toContain('This page mentions:');
    expect(content).toContain('React');
    expect(content).toContain('Kubernetes');
  });
});
