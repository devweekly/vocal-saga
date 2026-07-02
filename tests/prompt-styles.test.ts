import { describe, it, expect } from 'vitest';
import { buildSystemContent, buildDefaultSystemContent } from '../lib/translate/service/shared';
import { buildAchengSystemContent } from '../lib/translate/service/acheng-prompt';
import { buildJinyongSystemContent } from '../lib/translate/service/jinyong-prompt';

describe('System prompt styles', () => {
  it('buildSystemContent returns Jin Yong-style prompt by default', () => {
    const content = buildSystemContent('en', 'zh');
    expect(content).toContain('Jin Yong');
    expect(content).toContain('金庸');
    expect(content).toContain('走火入魔');
    expect(content).toContain('门派');
    // 保留输出格式约束
    expect(content).toContain('{"translations":[{"id":"x","translated_text":"y"}]}');
    expect(content).toContain('Translate English to Simplified Chinese');
  });

  it('buildDefaultSystemContent returns the plain legacy prompt', () => {
    const content = buildDefaultSystemContent('en', 'zh');
    expect(content).toContain('Use natural, idiomatic Simplified Chinese');
    expect(content).not.toContain('金庸');
    expect(content).not.toContain('Jin Yong');
  });

  it('buildAchengSystemContent returns Acheng-style prompt', () => {
    const content = buildAchengSystemContent('en', 'zh');
    expect(content).toContain('Acheng');
    expect(content).toContain('阿城');
    expect(content).toContain('白描');
    expect(content).toContain('动词驱动');
  });

  it('buildJinyongSystemContent returns Jin Yong-style prompt', () => {
    const content = buildJinyongSystemContent('en', 'zh');
    expect(content).toContain('Jin Yong');
    expect(content).toContain('金庸');
    expect(content).toContain('走火入魔');
  });

  it('appends glossary terms to default (Jin Yong) prompt', () => {
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

  it('appends glossary terms to Acheng prompt', () => {
    const glossary = { document_terms: ['React', 'Kubernetes'] };
    const content = buildAchengSystemContent('en', 'zh', glossary);
    expect(content).toContain('This page mentions:');
    expect(content).toContain('React');
    expect(content).toContain('Kubernetes');
  });

  it('appends glossary terms to Jin Yong prompt', () => {
    const glossary = { document_terms: ['React', 'Kubernetes'] };
    const content = buildJinyongSystemContent('en', 'zh', glossary);
    expect(content).toContain('This page mentions:');
    expect(content).toContain('React');
    expect(content).toContain('Kubernetes');
  });
});
