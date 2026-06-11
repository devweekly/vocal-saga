import { describe, it, expect, beforeEach } from 'vitest';
import { prepareDocument } from '../lib/translate/contentHelper';

describe('prepareDocument', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should use article element as root when present', () => {
    document.body.innerHTML = `
      <nav>Navigation content</nav>
      <article>
        <h1>Article Title</h1>
        <p>Article paragraph one.</p>
        <p>Article paragraph two.</p>
      </article>
      <footer>Footer content</footer>
    `;

    const { blocks, fullText } = prepareDocument(document);

    // 应该只提取 article 内的内容
    expect(fullText).toContain('Article Title');
    expect(fullText).toContain('Article paragraph one');
    expect(fullText).toContain('Article paragraph two');
    expect(fullText).not.toContain('Navigation content');
    expect(fullText).not.toContain('Footer content');
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('should use role="main" when article is not present', () => {
    document.body.innerHTML = `
      <nav>Navigation</nav>
      <div role="main">
        <h1>Main Content</h1>
        <p>Main paragraph.</p>
      </div>
      <aside>Sidebar</aside>
    `;

    const { fullText } = prepareDocument(document);

    expect(fullText).toContain('Main Content');
    expect(fullText).toContain('Main paragraph');
    expect(fullText).not.toContain('Navigation');
    expect(fullText).not.toContain('Sidebar');
  });

  it('should use main element when available', () => {
    document.body.innerHTML = `
      <header>Header</header>
      <main>
        <h1>Main Element Content</h1>
        <p>Paragraph in main.</p>
      </main>
    `;

    const { fullText } = prepareDocument(document);

    expect(fullText).toContain('Main Element Content');
    expect(fullText).not.toContain('Header');
  });

  it('should use class-based article container', () => {
    document.body.innerHTML = `
      <div class="article-content">
        <h1>Class Article</h1>
        <p>Content here.</p>
      </div>
    `;

    const { fullText } = prepareDocument(document);

    expect(fullText).toContain('Class Article');
    expect(fullText).toContain('Content here');
  });

  it('should fallback to body when no article container found', () => {
    document.body.innerHTML = `
      <div>
        <h1>Plain Page</h1>
        <p>Some content.</p>
      </div>
    `;

    const { fullText } = prepareDocument(document);

    expect(fullText).toContain('Plain Page');
    expect(fullText).toContain('Some content');
  });

  it('should prefer article over role=main', () => {
    document.body.innerHTML = `
      <div role="main">
        <p>Main role content</p>
      </div>
      <article>
        <p>Article content</p>
      </article>
    `;

    const { fullText } = prepareDocument(document);

    // article 优先级更高，应该只提取 article 内容
    expect(fullText).toContain('Article content');
    expect(fullText).not.toContain('Main role content');
  });

  it('should keep <article> root when heading lives outside .article-body (bankingdive-style)', () => {
    // bankingdive.com 用 <article> 包裹整页：标题在 .first-page-pdf，
    // 正文在 .article-body。如果直接用 .article-body 作为范围，会把
    // 标题丢掉；如果直接用 <article>，分享菜单/署名等噪声又会污染
    // chunk。当前策略：保留 <article>，但 SKIP_CLASS_PATTERNS 会
    // 过滤掉 share-menu / byline / branding 等，标题和正文都进翻译。
    document.body.innerHTML = `
      <article>
        <div class="first-page-pdf">
          <h1>Page wrapper title (should be translated)</h1>
          <ul class="social-icon-list--inner">
            <li>Copy link (should be filtered)</li>
            <li>Email (should be filtered)</li>
          </ul>
        </div>
        <div class="row">
          <div class="article-body">
            <p>Real article body paragraph one.</p>
            <p>Real article body paragraph two.</p>
          </div>
        </div>
      </article>
    `;

    const { fullText } = prepareDocument(document);

    expect(fullText).toContain('Page wrapper title (should be translated)');
    expect(fullText).toContain('Real article body paragraph one');
    expect(fullText).toContain('Real article body paragraph two');
    expect(fullText).not.toContain('Copy link (should be filtered)');
    expect(fullText).not.toContain('Email (should be filtered)');
  });

  it('should refine to .article-body when heading is inside it (generic CMS)', () => {
    // Generic CMS 把 <article> 标题和正文都放在 .article-body 内时，
    // 仍然下钻到 .article-body 减少噪声。
    document.body.innerHTML = `
      <article>
        <div class="row">
          <div class="article-body">
            <h1>Real article heading</h1>
            <p>Real article body paragraph one.</p>
            <p>Real article body paragraph two.</p>
          </div>
        </div>
      </article>
    `;

    const { fullText } = prepareDocument(document);

    expect(fullText).toContain('Real article heading');
    expect(fullText).toContain('Real article body paragraph one');
  });

  it('should work with Element root parameter', () => {
    document.body.innerHTML = `
      <div id="custom-root">
        <p>Custom root content.</p>
      </div>
    `;

    const customRoot = document.getElementById('custom-root')!;
    const { fullText } = prepareDocument(customRoot);

    expect(fullText).toContain('Custom root content');
  });

  it('should throw when no translatable content found', () => {
    document.body.innerHTML = '<div></div>';

    expect(() => prepareDocument(document)).toThrow('No translatable content found');
  });
});
