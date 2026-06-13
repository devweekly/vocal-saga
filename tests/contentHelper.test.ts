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

    const { blocks, fullText } = prepareDocument(document, "https://example.com/test");

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

    const { fullText } = prepareDocument(document, "https://example.com/test");

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

    const { fullText } = prepareDocument(document, "https://example.com/test");

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

    const { fullText } = prepareDocument(document, "https://example.com/test");

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

    const { fullText } = prepareDocument(document, "https://example.com/test");

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

    const { fullText } = prepareDocument(document, "https://example.com/test");

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

    const { fullText } = prepareDocument(document, "https://example.com/test");

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

    const { fullText } = prepareDocument(document, "https://example.com/test");

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
    const { fullText } = prepareDocument(customRoot, "https://example.com/test");

    expect(fullText).toContain('Custom root content');
  });

  it('should throw when no translatable content found', () => {
    document.body.innerHTML = '<div></div>';

    expect(() => prepareDocument(document, "https://example.com/test")).toThrow('No translatable content found');
  });

  it('should use .u-rich-text-blog for Webflow sites (claude.com)', () => {
    // claude.com/blog 使用 Webflow，文章内容在 .u-rich-text-blog.w-richtext 内
    document.body.innerHTML = `
      <nav>Navigation</nav>
      <div class="hero">Hero section</div>
      <div class="u-rich-text-blog u-margin-trim w-richtext">
        <h2>Types of skills</h2>
        <p>After cataloging all of our internal skills at Anthropic, we noticed they cluster into nine categories.</p>
        <h3>Research skills</h3>
        <p>Research skills help Claude find and synthesize information.</p>
      </div>
      <footer>Footer</footer>
    `;

    const { fullText } = prepareDocument(document, "https://claude.com/blog/test");

    expect(fullText).toContain('Types of skills');
    expect(fullText).toContain('After cataloging');
    expect(fullText).toContain('Research skills');
    expect(fullText).not.toContain('Navigation');
    expect(fullText).not.toContain('Hero section');
    expect(fullText).not.toContain('Footer');
  });

  it('expands multiple .u-rich-text-blog siblings (Webflow real-world layout)', () => {
    // claude.com/blog 的真实结构：文章内容被拆到多个 .u-rich-text-blog 容器，
    // 分布在 .blog_post_wrap 的三个 .blog_post_layout 兄弟节点中。
    // querySelector('.u-rich-text-blog') 只返回第一个，expandIfFragmented
    // 必须向上展开到 .blog_post_wrap 才能覆盖全部内容。
    document.body.innerHTML = `
      <main>
        <section class="hero_blog_post_wrap">
          <p>Hero section（不应被提取）</p>
        </section>
        <section class="blog_post_section_wrap u-section">
          <div class="blog_post_contain u-container">
            <div class="blog_post_component">
              <div class="blog_post_wrap u-grid-custom">
                <div class="blog_post_layout u-column-custom">
                  <div class="blog_post_content_wrap">
                    <div class="u-rich-text-blog u-margin-trim w-richtext">
                      <h2>What are skills?</h2>
                      <p>Skills are folders of instructions, scripts, and resources.</p>
                    </div>
                  </div>
                </div>
                <div class="blog_post_layout u-column-custom is-cc">
                  <div class="blog_post_content_wrap">
                    <div class="u-rich-text-blog u-margin-trim w-richtext">
                      <h2>Types of skills</h2>
                      <p>After cataloging all of our internal skills at Anthropic, we noticed they cluster into nine categories.</p>
                      <h3>Research skills</h3>
                      <p>Research skills help Claude find and synthesize information.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section class="blog_related_section_wrap">
          <p>Related posts（不应被提取）</p>
        </section>
      </main>
    `;

    const { fullText, blocks } = prepareDocument(document, "https://claude.com/blog/test");

    // 第一个 .u-rich-text-blog 的内容
    expect(fullText).toContain('What are skills?');
    expect(fullText).toContain('Skills are folders of instructions');
    // 第二个 .u-rich-text-blog 的内容（之前被漏掉的部分）
    expect(fullText).toContain('Types of skills');
    expect(fullText).toContain('After cataloging all of our internal skills');
    expect(fullText).toContain('Research skills');
    expect(fullText).toContain('Research skills help Claude');
    // 不应包含 hero 和 related posts
    expect(fullText).not.toContain('Hero section');
    expect(fullText).not.toContain('Related posts');
    // 应包含两个 .u-rich-text-blog 的全部 content block
    expect(blocks.length).toBeGreaterThanOrEqual(6);
  });

  it('should refine to .post-content inside <article> (Jane Street)', () => {
    // Jane Street blog: <article> 包含 .post-header + .post-content + .bios-container
    // 需要下钻到 .post-content 只取正文
    document.body.innerHTML = `
      <article>
        <div class="post-header">
          <h3>Formal methods and the future of programming</h3>
          <span class="date">Jun 07, 2026</span>
          <ul class="social-share">
            <li><a href="#">Share on Facebook</a></li>
          </ul>
          <div class="author">By: Yaron Minsky</div>
        </div>
        <div class="post-content">
          <p>I've been telling people for the last 25 years that Jane Street was not interested in formal methods.</p>
          <p>I'm not saying that anymore.</p>
          <h1>Why the change of heart?</h1>
          <p>Agentic coding upsets the formal-methods apple-cart in a few ways.</p>
        </div>
        <div class="bios-container">
          <p class="bio">Yaron Minsky joined Jane Street back in 2002.</p>
        </div>
      </article>
    `;

    const { fullText, blocks } = prepareDocument(document, "https://blog.janestreet.com/test");

    expect(fullText).toContain("I've been telling people");
    expect(fullText).toContain("I'm not saying that anymore");
    expect(fullText).toContain("Why the change of heart");
    expect(fullText).toContain("Agentic coding upsets");
    expect(fullText).not.toContain('Share on Facebook');
    expect(fullText).not.toContain('Yaron Minsky joined Jane Street');
    expect(blocks.length).toBeGreaterThanOrEqual(4);
  });
});
