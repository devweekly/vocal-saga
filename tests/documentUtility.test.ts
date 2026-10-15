import { describe, it, expect } from 'vitest';
import { createStructuredDocument, parseDocument } from '../lib/translate/document';
import { buildSegmentBatches } from '../lib/translate/document/batcher';

describe('shared document utilities', () => {
  it('parses plain text for utility callers without exposing a cloud workflow route', async () => {
    const doc = await parseDocument({ fileName: 'a.txt', text: 'Hello\n\nWorld' });
    expect(doc.segments.map((segment) => segment.text)).toEqual(['Hello', 'World']);
  });

  it('rejects binary formats in the server-side parser utility', async () => {
    await expect(parseDocument({ fileName: 'a.pdf', text: 'x' })).rejects.toThrow(/服务端不支持解析/);
    await expect(parseDocument({ fileName: 'a.docx', text: 'x' })).rejects.toThrow(/服务端不支持解析/);
    await expect(parseDocument({ fileName: 'a.epub', text: 'x' })).rejects.toThrow(/服务端不支持解析/);
  });

  it('validates unique IDs when constructing structured input', () => {
    expect(() => createStructuredDocument({
      fileName: 'demo.pdf',
      format: 'pdf',
      segments: [{ id: 'dup', text: 'one' }, { id: 'dup', text: 'two' }],
    })).toThrow(/重复片段 ID/);
  });

  it('splits batches on context boundaries when requested', () => {
    const segments = [
      { id: 'a', index: 0, text: 'one', kind: 'paragraph' as const, contextPath: 'Chapter One', page: 1 },
      { id: 'b', index: 1, text: 'two', kind: 'paragraph' as const, contextPath: 'Chapter One', page: 1 },
      { id: 'c', index: 2, text: 'three', kind: 'paragraph' as const, contextPath: 'Chapter Two', page: 1 },
      { id: 'd', index: 3, text: 'four', kind: 'paragraph' as const, contextPath: 'Chapter Two', page: 2 },
    ];
    expect(buildSegmentBatches(segments, {
      maxChars: 1000, maxSegments: 10, splitOnContextChange: true,
    }).map((batch) => batch.map((segment) => segment.id))).toEqual([['a', 'b'], ['c'], ['d']]);
  });
});
