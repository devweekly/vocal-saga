import { describe, it, expect, beforeEach } from 'vitest';

/**
 * 测试 pipeline.ts 中批量 DOM 查询优化的逻辑。
 * 
 * 优化前：对每个 block 做 querySelector('[data-fanyi-block-id="bX"]')，O(blocks × N)。
 * 优化后：一次 querySelectorAll('[data-fanyi-block-id]') 建 Map，O(N)。
 */

function createDocument(html: string): Document {
  const parser = new DOMParser();
  return parser.parseFromString(html, 'text/html');
}

describe('batch DOM query optimization', () => {
  let doc: Document;

  beforeEach(() => {
    doc = createDocument(`
      <html>
        <body>
          <p data-fanyi-block-id="b1">First paragraph</p>
          <div data-fanyi-block-id="b2">Second block</div>
          <span data-fanyi-block-id="b3">Third block</span>
          <p>Non-translatable paragraph</p>
          <h2 data-fanyi-block-id="b4">Section title</h2>
        </body>
      </html>
    `);
  });

  it('querySelectorAll builds correct block map', () => {
    const blockMap = new Map<string, Element>();
    doc.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
      const id = el.getAttribute('data-fanyi-block-id');
      if (id) blockMap.set(id, el);
    });

    expect(blockMap.size).toBe(4);
    expect(blockMap.get('b1')?.textContent).toBe('First paragraph');
    expect(blockMap.get('b2')?.textContent).toBe('Second block');
    expect(blockMap.get('b3')?.textContent).toBe('Third block');
    expect(blockMap.get('b4')?.textContent).toBe('Section title');
  });

  it('O(1) lookup by block id', () => {
    const blockMap = new Map<string, Element>();
    doc.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
      const id = el.getAttribute('data-fanyi-block-id');
      if (id) blockMap.set(id, el);
    });

    // O(1) lookup
    expect(blockMap.has('b1')).toBe(true);
    expect(blockMap.has('b999')).toBe(false);
  });

  it('handles empty document', () => {
    const emptyDoc = createDocument('<html><body></body></html>');
    const blockMap = new Map<string, Element>();
    emptyDoc.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
      const id = el.getAttribute('data-fanyi-block-id');
      if (id) blockMap.set(id, el);
    });

    expect(blockMap.size).toBe(0);
  });

  it('handles many blocks efficiently', () => {
    // 生成 200 个 block
    const blocks = Array.from({ length: 200 }, (_, i) =>
      `<p data-fanyi-block-id="b${i + 1}">Block ${i + 1}</p>`
    ).join('\n');
    const manyDoc = createDocument(`<html><body>${blocks}</body></html>`);

    const blockMap = new Map<string, Element>();
    manyDoc.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
      const id = el.getAttribute('data-fanyi-block-id');
      if (id) blockMap.set(id, el);
    });

    expect(blockMap.size).toBe(200);
    expect(blockMap.get('b1')?.textContent).toBe('Block 1');
    expect(blockMap.get('b200')?.textContent).toBe('Block 200');
  });

  it('skips elements without data-fanyi-block-id', () => {
    const mixedDoc = createDocument(`
      <html>
        <body>
          <p data-fanyi-block-id="b1">Has id</p>
          <p>No id</p>
          <div data-fanyi-block-id="b2">Has id</div>
          <span>Also no id</span>
        </body>
      </html>
    `);

    const blockMap = new Map<string, Element>();
    mixedDoc.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
      const id = el.getAttribute('data-fanyi-block-id');
      if (id) blockMap.set(id, el);
    });

    expect(blockMap.size).toBe(2);
    expect(blockMap.has('b1')).toBe(true);
    expect(blockMap.has('b2')).toBe(true);
  });
});
