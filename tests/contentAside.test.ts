import { describe, it, expect, beforeEach } from 'vitest';
import { extractBlocks } from '../lib/translate/blockExtractor';
import { isContentAside } from '../lib/translate/blockExtractor/rules';

/**
 * 正文内 <aside>（Key takeaways / TL;DR / 结论卡）必须被翻译。
 *
 * 回归背景：cube.dev 的 "Key takeaways" 卡片用 `<aside>` 承载，walker 曾把它
 * 当作语义噪声整棵拒绝，导致整块内容完全不翻译，而紧随其后的段落正常翻译。
 * 与 fanyi-extension 的 `src/__tests__/contentAside.test.ts` 保持同语义。
 */

const PAGE_URL = 'https://example.com/article';

function blocksOf(html: string): string[] {
  document.body.innerHTML = html;
  return extractBlocks(document, PAGE_URL).map((b) => b.text);
}

describe('isContentAside (server)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('treats an aside interleaved with article prose as content', () => {
    document.body.innerHTML = `
      <article>
        <h1>Title</h1>
        <p>${'Intro paragraph. '.repeat(6)}</p>
        <aside class="KeyTakeaways_KeyTakeaways__szMNW" aria-label="Key takeaways">
          <p>Key takeaways</p>
          <ul>
            <li>First takeaway that is reasonably long.</li>
            <li>Second takeaway that is reasonably long.</li>
          </ul>
        </aside>
        <p>${'Body paragraph. '.repeat(6)}</p>
      </article>`;
    expect(isContentAside(document.querySelector('aside')!)).toBe(true);
  });

  it('keeps a layout sidebar aside out of content', () => {
    document.body.innerHTML = `
      <div class="layout">
        <article><p>${'Body paragraph. '.repeat(6)}</p></article>
        <aside class="sidebar"><p>${'Related links. '.repeat(20)}</p></aside>
      </div>`;
    expect(isContentAside(document.querySelector('aside')!)).toBe(false);
  });

  it('rejects aside with noise class even when interleaved with prose', () => {
    document.body.innerHTML = `
      <article>
        <p>${'Intro paragraph. '.repeat(6)}</p>
        <aside class="related-posts"><p>${'Other posts. '.repeat(20)}</p></aside>
        <p>${'Body paragraph. '.repeat(6)}</p>
      </article>`;
    expect(isContentAside(document.querySelector('aside')!)).toBe(false);
  });

  it('rejects a short aside with no prose siblings', () => {
    document.body.innerHTML = `
      <div class="article-body">
        <div class="row"><p>${'Body paragraph. '.repeat(6)}</p><aside><span>Ad</span></aside></div>
      </div>`;
    expect(isContentAside(document.querySelector('aside')!)).toBe(false);
  });
});

describe('extractBlocks - in-article aside (server)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('extracts key-takeaway list items inside an aside', () => {
    const texts = blocksOf(`
      <article class="Article_article__nl_Zc">
        <h1>What Is a Semantic Layer?</h1>
        <div class="Article_article__body__5ks9P">
          <aside class="KeyTakeaways_KeyTakeaways__szMNW">
            <p>Key takeaways</p>
            <ul class="KeyTakeaways_KeyTakeaways__list__X__6v">
              <li class="KeyTakeaways_KeyTakeaways__item__SsVQh">It is not a database and not a BI tool.</li>
              <li class="KeyTakeaways_KeyTakeaways__item__SsVQh">Governance and flexibility stop being a tradeoff.</li>
            </ul>
          </aside>
          <p>A semantic layer is the governed layer between your data warehouse and the tools that consume data.</p>
        </div>
      </article>`);

    expect(texts).toContain('It is not a database and not a BI tool.');
    expect(texts).toContain('Governance and flexibility stop being a tradeoff.');
    expect(texts).toContain('Key takeaways');
    expect(texts.some((t) => t.startsWith('A semantic layer is the governed layer'))).toBe(true);
  });

  it('still drops site-chrome aside, nav and footer', () => {
    const texts = blocksOf(`
      <div class="page">
        <nav><a href="/">Home</a> <a href="/about">About us</a></nav>
        <article>
          <p>${'Body paragraph. '.repeat(6)}</p>
        </article>
        <aside class="sidebar"><p>${'Related reading. '.repeat(20)}</p></aside>
        <footer><p>Copyright 2026 Example Inc.</p></footer>
      </div>`);

    expect(texts.some((t) => t.includes('Home'))).toBe(false);
    expect(texts.some((t) => t.includes('Related reading'))).toBe(false);
    expect(texts.some((t) => t.includes('Copyright'))).toBe(false);
    expect(texts.some((t) => t.startsWith('Body paragraph.'))).toBe(true);
  });
});
