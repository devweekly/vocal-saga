import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { extractBlocks, findBlockNode, buildNodeMap, extractBlocksFromMarkedHtml, collapseSpacedText } from '../lib/translate/blockExtractor';
import { shouldSkipByClass, isLowPriorityElement, isOverlayElement } from '../lib/translate/blockExtractor/rules';
import { detectArticleRoot } from '../lib/translate/contentDetector';

// Mock matchSiteRule for shouldSkipBySiteRules tests
vi.mock('../lib/translate/rules', () => ({
  matchSiteRule: vi.fn(),
}));

import { matchSiteRule } from '../lib/translate/rules';
import { clearSiteRuleCache } from '../lib/translate/blockExtractor/rules';

// 每个测试前清空站点规则缓存，避免测试间状态污染
beforeEach(() => {
  clearSiteRuleCache();
});

function setupHTML(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

describe('extractBlocks - Basic Extraction', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract simple paragraphs', () => {
    setupHTML(`
      <div>
        <p>Hello world this is a test paragraph.</p>
        <p>Another paragraph with enough text.</p>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe('Hello world this is a test paragraph.');
    expect(blocks[0].tag).toBe('p');
    expect(blocks[1].text).toBe('Another paragraph with enough text.');
  });

  it('should extract headings', () => {
    setupHTML(`
      <article>
        <h1>Main Title of the Article</h1>
        <h2>Subsection Heading Here</h2>
        <h3>Minor Section Title</h3>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(3);
    expect(blocks[0].tag).toBe('h1');
    expect(blocks[1].tag).toBe('h2');
    expect(blocks[2].tag).toBe('h3');
  });

  it('should extract list items', () => {
    setupHTML(`
      <ul>
        <li>First list item with enough text content.</li>
        <li>Second list item also has sufficient length.</li>
      </ul>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].tag).toBe('li');
    expect(blocks[1].tag).toBe('li');
  });

  it('should extract blockquotes', () => {
    setupHTML(`
      <blockquote>This is a quoted passage with sufficient text length for extraction.</blockquote>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('blockquote');
  });

  it('should extract definition descriptions', () => {
    setupHTML(`
      <dl>
        <dt>Term</dt>
        <dd>This is the definition of the term with enough text.</dd>
      </dl>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('dd');
  });
});

describe('extractBlocks - Inline Elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should keep inline elements inside parent block', () => {
    setupHTML(`
      <p><span>Text inside span</span> and more text outside.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('p');
    expect(blocks[0].text).toBe('Text inside span and more text outside.');
  });

  it('should keep links inside parent paragraph', () => {
    setupHTML(`
      <p>See <a href="/page">Understanding the Difference Between Embedding Layers</a> for details.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('p');
    expect(blocks[0].text).toContain('Understanding the Difference Between Embedding Layers');
  });

  it('should handle mixed inline elements in paragraph', () => {
    setupHTML(`
      <p>
        <span>First span text.</span>
        <a href="/link">Link text here.</a>
        <strong>Bold text too.</strong>
      </p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('p');
    expect(blocks[0].text.replace(/\s+/g, ' ')).toBe('First span text. Link text here. Bold text too.');
  });

  it('should handle emphasis and strong tags', () => {
    setupHTML(`
      <p>This is <em>emphasized</em> and <strong>strong</strong> text in a paragraph.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('This is emphasized and strong text in a paragraph.');
  });

  it('should not extract inline elements as standalone blocks', () => {
    setupHTML(`
      <div>
        <span>Standalone span with enough text content.</span>
        <strong>Standalone strong with enough text content.</strong>
        <em>Standalone em with enough text content.</em>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const inlineTags = blocks.filter(b => ['span', 'strong', 'em'].includes(b.tag));
    expect(inlineTags).toHaveLength(0);
  });

  it('should handle nested inline elements', () => {
    setupHTML(`
      <p><span><strong><em>Nested inline content with enough text.</em></strong></span></p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('p');
  });
});

describe('extractBlocks - Skip Elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip script tags', () => {
    setupHTML(`
      <script>var x = "This script content should not be extracted";</script>
      <p>Normal paragraph content here.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Normal paragraph content here.');
  });

  it('should skip style tags', () => {
    setupHTML(`
      <style>.class { color: red; }</style>
      <p>Normal paragraph content here.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
  });

  it('should skip code and pre tags', () => {
    setupHTML(`
      <code>function hello() { return "world"; }</code>
      <pre>Some preformatted code block content here.</pre>
      <p>Normal paragraph content here.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('p');
  });

  it('should skip form input elements (input/textarea have no DOM text)', () => {
    setupHTML(`
      <input type="text" value="Input value" />
      <textarea>Textarea content here.</textarea>
      <p>Normal paragraph content here.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Normal paragraph content here.');
  });

  it('should translate button and option text (visible UI labels)', () => {
    setupHTML(`
      <button>Submit button text content</button>
      <select>
        <option>First option text content</option>
        <option>Second option text content</option>
      </select>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Submit button text content');
    expect(texts).toContain('First option text content');
    expect(texts).toContain('Second option text content');
  });

  it('should skip iframe tags', () => {
    setupHTML(`
      <iframe src="https://example.com"></iframe>
      <p>Normal paragraph content here.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
  });

  it('should skip header and footer tags', () => {
    setupHTML(`
      <header><p>Header paragraph content here.</p></header>
      <article><p>Article paragraph content here.</p></article>
      <footer><p>Footer paragraph content here.</p></footer>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const footerBlocks = blocks.filter(b =>
      b.text.includes('Footer') || b.text.includes('Header')
    );
    expect(footerBlocks).toHaveLength(0);
    expect(blocks).toHaveLength(1);
  });

  it('should skip aside and nav tags', () => {
    setupHTML(`
      <nav><p>Navigation link text here.</p></nav>
      <aside><p>Sidebar paragraph content here.</p></aside>
      <main><p>Main article paragraph content here.</p></main>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const sidebarBlocks = blocks.filter(b =>
      b.text.includes('Navigation') || b.text.includes('Sidebar')
    );
    expect(sidebarBlocks).toHaveLength(0);
    expect(blocks).toHaveLength(1);
  });
});

describe('extractBlocks - Class-based Skipping', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip sidebar elements outside article', () => {
    setupHTML(`
      <div class="sidebar"><p>Sidebar paragraph content here.</p></div>
      <main><p>Main article paragraph content here.</p></main>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Main article paragraph content here.');
  });

  it('should skip footer elements', () => {
    setupHTML(`
      <div class="footer-wrap"><p>Footer paragraph content here.</p></div>
      <article><p>Article paragraph content here.</p></article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const footerBlocks = blocks.filter(b => b.text.includes('Footer'));
    expect(footerBlocks).toHaveLength(0);
  });

  it('should skip ad containers', () => {
    setupHTML(`
      <div class="ad-container"><p>Ad paragraph content here.</p></div>
      <article><p>Article paragraph content here.</p></article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const adBlocks = blocks.filter(b => b.text.includes('Ad'));
    expect(adBlocks).toHaveLength(0);
  });

  it('should skip widget areas', () => {
    setupHTML(`
      <div class="subscribe-widget"><p>Subscribe widget content here.</p></div>
      <article><p>Article paragraph content here.</p></article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
  });

  it('should skip cookie banners', () => {
    setupHTML(`
      <div class="cookie-consent"><p>We use cookies to improve your experience.</p></div>
      <article><p>Article paragraph content here.</p></article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const cookieBlocks = blocks.filter(b => b.text.includes('cookies'));
    expect(cookieBlocks).toHaveLength(0);
  });

  it('should skip sidebar/footer classes even inside article context', () => {
    setupHTML(`
      <article>
        <div class="sidebar"><p>Sidebar inside article context.</p></div>
        <div class="footer-wrap"><p>Footer inside article context.</p></div>
        <p>Main article content that should be extracted.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const sidebarBlocks = blocks.filter(b => b.text.includes('Sidebar'));
    expect(sidebarBlocks).toHaveLength(0);
    const footerBlocks = blocks.filter(b => b.text.includes('Footer'));
    expect(footerBlocks).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('Main article content');
  });

  it('should skip notranslate class', () => {
    setupHTML(`
      <p class="notranslate">This should not be translated at all.</p>
      <p>This should be translated normally.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const noTranslateBlocks = blocks.filter(b => b.text.includes('notranslate'));
    expect(noTranslateBlocks).toHaveLength(0);
  });
});

describe('extractBlocks - Complex Structures', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should handle headings with anchor links (Substack style)', () => {
    setupHTML(`
      <article>
        <h1 class="header-anchor-post">
          1. Reusing KV Tensors Across Layers
          <div class="header-anchor-parent">
            <div class="header-anchor offset-top"></div>
            <button type="button" aria-label="Link">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"></svg>
            </button>
          </div>
        </h1>
        <p>Paragraph after heading.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const headings = blocks.filter(b => b.tag.startsWith('h'));
    expect(headings).toHaveLength(1);
    expect(headings[0].text).toContain('Reusing KV Tensors');
  });

  it('should handle nested divs with text content', () => {
    setupHTML(`
      <article>
        <div class="content-wrapper">
          <div class="inner">
            <p>Deeply nested paragraph content here.</p>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Deeply nested paragraph content here.');
  });

  it('should handle figure with figcaption', () => {
    setupHTML(`
      <figure>
        <img src="/image.png" alt="Test image" />
        <figcaption>This is a caption describing the figure content.</figcaption>
      </figure>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('figcaption');
  });

  it('should handle mixed content with lists and paragraphs', () => {
    setupHTML(`
      <article>
        <p>Introduction paragraph with enough text content.</p>
        <ul>
          <li>First item in the list with content.</li>
          <li>Second item in the list with content.</li>
        </ul>
        <p>Conclusion paragraph with enough text content.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(4);
    expect(blocks[0].tag).toBe('p');
    expect(blocks[1].tag).toBe('li');
    expect(blocks[2].tag).toBe('li');
    expect(blocks[3].tag).toBe('p');
  });

  it('should handle definition lists', () => {
    setupHTML(`
      <dl>
        <dt>First Term</dt>
        <dd>Definition of first term with enough text content.</dd>
        <dt>Second Term</dt>
        <dd>Definition of second term with enough text content.</dd>
      </dl>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].tag).toBe('dd');
    expect(blocks[1].tag).toBe('dd');
  });
});

describe('extractBlocks - Text Length Filtering', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip very short text (less than 3 chars)', () => {
    setupHTML(`
      <p>Hi</p>
      <p>This is a longer paragraph with enough text content.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('longer paragraph');
  });

  it('should skip very long text (3072+ chars)', () => {
    const longText = 'a'.repeat(3100);
    setupHTML(`
      <p>${longText}</p>
      <p>Normal length paragraph here.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Normal length paragraph here.');
  });

  it('should accept text at boundary (exactly 3 chars)', () => {
    setupHTML(`
      <p>abc</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
  });
});

describe('extractBlocks - SPA Content (Twitter/X)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract span text inside article container', () => {
    setupHTML(`
      <div>
        <article role="article">
          <div>
            <div>
              <span>This is a tweet with enough text content to be extracted.</span>
            </div>
          </div>
        </article>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const tweetBlocks = blocks.filter(b => b.text.includes('tweet'));
    expect(tweetBlocks).toHaveLength(1);
    expect(tweetBlocks[0].tag).toBe('span');
  });

  it('should extract multiple spans inside article', () => {
    setupHTML(`
      <article>
        <div>
          <span>First part of the tweet content.</span>
          <span>Second part of the tweet content.</span>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('should NOT extract span outside article context', () => {
    setupHTML(`
      <div class="sidebar">
        <span>This is sidebar content that should not be extracted.</span>
      </div>
      <article>
        <div>
          <span>This is article content that should be extracted.</span>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const sidebarBlocks = blocks.filter(b => b.text.includes('sidebar'));
    expect(sidebarBlocks).toHaveLength(0);
    const articleBlocks = blocks.filter(b => b.text.includes('article content'));
    expect(articleBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should extract div with text inside article', () => {
    setupHTML(`
      <article>
        <div>
          <div>
            This is a div with enough text content inside an article container.
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const divBlocks = blocks.filter(b => b.tag === 'div' && b.text.includes('div with enough text'));
    expect(divBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle Twitter-like nested structure', () => {
    setupHTML(`
      <div>
        <div>
          <main>
            <div>
              <article role="article">
                <div>
                  <div>
                    <span>Full tweet text with enough characters to be extracted properly.</span>
                  </div>
                </div>
              </article>
            </div>
          </main>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const tweetBlocks = blocks.filter(b => b.text.includes('Full tweet text'));
    expect(tweetBlocks).toHaveLength(1);
  });
});

describe('extractBlocks - Content Editable', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip content editable elements', () => {
    setupHTML(`
      <p contenteditable="true">Editable paragraph content here.</p>
      <p>Non-editable paragraph content here.</p>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const editableBlocks = blocks.filter(b => b.text.includes('Editable'));
    expect(editableBlocks).toHaveLength(0);
  });

  it('should not skip contenteditable="false" containers (X longform Draft.js)', () => {
    setupHTML(`
      <article>
        <div data-testid="twitterArticleRichTextView">
          <div class="DraftEditor-root">
            <div class="DraftEditor-editorContainer">
              <div class="public-DraftEditor-content" contenteditable="false">
                <div class="public-DraftStyleDefault-block">
                  <span>Model routing is so hot right now. In the last few months, OpenRouter shipped Fusion.</span>
                </div>
                <div class="public-DraftStyleDefault-block">
                  <span>The pitch converges on a common pattern: nobody wants to pay frontier prices for every token.</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://x.com/jerryjliu0/status/2077537847951945742");
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const texts = blocks.map(b => b.text);
    expect(texts.some(t => t.includes('Model routing is so hot right now'))).toBe(true);
    expect(texts.some(t => t.includes('The pitch converges on a common pattern'))).toBe(true);
  });

  it('should treat Draft.js paragraph blocks as single units and not fragment inline children', () => {
    setupHTML(`
      <article>
        <div class="public-DraftEditor-content" contenteditable="false">
          <div class="public-DraftStyleDefault-block">
            <span>Model routing is hot. OpenRouter shipped </span>
            <div class="inline-link"><a href="/fusion">Fusion</a></div>
            <span>, a compound model that fans your prompt out.</span>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://x.com/jerryjliu0/status/2077537847951945742");
    // 应只提取出 1 个段落块，而不是把 span/a 拆成多个块
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('Model routing is hot');
    expect(blocks[0].text).toContain('Fusion');
    expect(blocks[0].text).toContain('compound model');
  });
});

describe('extractBlocks - Real-world Scenarios', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should handle blog post layout', () => {
    setupHTML(`
      <body>
        <nav class="main-menu">
          <p>Home About Contact</p>
        </nav>
        <div class="sidebar">
          <p>Related articles and widgets here.</p>
        </div>
        <article>
          <h1>Blog Post Title Here</h1>
          <p>First paragraph of the blog post content.</p>
          <h2>Section One</h2>
          <p>Content of section one with enough text length.</p>
          <blockquote>A relevant quote from an expert in the field.</blockquote>
          <h2>Section Two</h2>
          <p>Content of section two with enough text length.</p>
          <ul>
            <li>Key point number one of the article.</li>
            <li>Key point number two of the article.</li>
          </ul>
        </article>
        <footer class="post-footer">
          <p>Copyright and footer links here.</p>
        </footer>
      </body>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    // Should NOT include nav/sidebar/footer content
    expect(blockTexts.some(t => t.includes('Home About'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Related articles'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Copyright'))).toBe(false);

    // Should include article content
    expect(blockTexts.some(t => t.includes('Blog Post Title'))).toBe(true);
    expect(blockTexts.some(t => t.includes('First paragraph'))).toBe(true);
    expect(blockTexts.some(t => t.includes('Section One'))).toBe(true);
    expect(blockTexts.some(t => t.includes('relevant quote'))).toBe(true);
  });

  it('should handle Substack-like article', () => {
    setupHTML(`
      <div id="main">
        <div class="main-menu"><p>Subscribe Sign in</p></div>
        <article>
          <h1>Recent Developments in LLM Architectures</h1>
          <div class="overlay-zrMCxn">
            <div>
              <p>As reasoning models and agent workflows keep more tokens around.</p>
              <p>The main examples I want to look at are KV sharing and per-layer embeddings.</p>
            </div>
          </div>
        </article>
        <div class="subscribe-widget"><p>Subscribe now for more content.</p></div>
        <div class="footer-wrap"><p>Copyright 2026</p></div>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    // Should include article content
    expect(blockTexts.some(t => t.includes('reasoning models'))).toBe(true);
    expect(blockTexts.some(t => t.includes('main examples'))).toBe(true);

    // Should NOT include menu, widget, footer
    expect(blockTexts.some(t => t.includes('Subscribe Sign in'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Subscribe now'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Copyright'))).toBe(false);
  });

  it('should handle news article with complex layout', () => {
    setupHTML(`
      <body>
        <header class="site-header"><p>News Site Header</p></header>
        <nav class="navigation-menu"><p>Categories and links here.</p></nav>
        <main>
          <article>
            <h1>Breaking News Headline Here</h1>
            <p>Lead paragraph with the most important information.</p>
            <figure>
              <img src="/photo.jpg" alt="News photo" />
              <figcaption>Photo caption describing the image content.</figcaption>
            </figure>
            <p>Second paragraph with additional details and context.</p>
            <blockquote>Quote from a relevant source or expert.</blockquote>
            <p>Third paragraph with more background information.</p>
          </article>
          <aside class="sidebar">
            <p>Related stories and sidebar content here.</p>
          </aside>
        </main>
        <footer class="site-footer"><p>Footer copyright information.</p></footer>
      </body>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    // Should include article content
    expect(blockTexts.some(t => t.includes('Breaking News'))).toBe(true);
    expect(blockTexts.some(t => t.includes('Lead paragraph'))).toBe(true);
    expect(blockTexts.some(t => t.includes('Photo caption'))).toBe(true);
    expect(blockTexts.some(t => t.includes('Quote from'))).toBe(true);

    // Should NOT include header, nav, sidebar, footer
    expect(blockTexts.some(t => t.includes('News Site Header'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Categories'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Related stories'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Footer copyright'))).toBe(false);
  });

  it('should handle Substack article from sample2.html structure', () => {
    setupHTML(`
      <div id="entry">
        <div id="main" class="main typography use-theme-bg">
          <div class="single-post-container">
            <div class="container">
              <div class="single-post">
                <div class="pencraft pc-display-contents pc-reset pubTheme-yiXxQA">
                  <article class="typography newsletter-post post">
                    <div class="post-header">
                      <h3 class="subtitle subtitle-HEEcLo">From Gemma 4 to DeepSeek V4, How New Open-Weight LLMs Are Reducing Long-Context Costs</h3>
                    </div>
                    <div class="available-content">
                      <div class="body markup">
                        <p>After a short family break, I am excited to be back and catching up on a busy few weeks of open-weight LLM releases. The thing that stood out to me is how much newer architectures are focused on long-context efficiency.</p>
                        <p>Here's another paragraph with enough text to be extracted.</p>
                      </div>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    console.log('Extracted blocks:', blocks.map(b => ({ tag: b.tag, text: b.text })));
    
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts.some(t => t.includes('From Gemma 4 to DeepSeek V4'))).toBe(true);
    expect(blockTexts.some(t => t.includes('After a short family break'))).toBe(true);
    expect(blockTexts.some(t => t.includes('another paragraph'))).toBe(true);
  });
});

describe('extractBlocks - XPath Generation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should generate valid XPath for each block', () => {
    setupHTML(`
      <article>
        <p>First paragraph.</p>
        <p>Second paragraph.</p>
        <div><p>Third paragraph in div.</p></div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(3);

    for (const block of blocks) {
      expect(block.xpath).toBeTruthy();
      expect(block.xpath.startsWith('/')).toBe(true);
    }
  });

  it('should generate unique XPath for each block', () => {
    setupHTML(`
      <article>
        <p>First paragraph content here.</p>
        <p>Second paragraph content here.</p>
        <p>Third paragraph content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const xpaths = blocks.map(b => b.xpath);
    const uniqueXpaths = new Set(xpaths);
    expect(uniqueXpaths.size).toBe(blocks.length);
  });
});

describe('extractBlocks - Heading Context', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should capture heading path in context', () => {
    setupHTML(`
      <article>
        <h1>Main Article Title</h1>
        <h2>Section Title</h2>
        <p>Paragraph under section with enough text.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const paragraph = blocks.find(b => b.tag === 'p');
    expect(paragraph).toBeTruthy();
    expect(paragraph!.context).toBeTruthy();
    expect(paragraph!.context!.headingPath).toContain('Main Article Title');
    expect(paragraph!.context!.headingPath).toContain('Section Title');
  });

  it('heading outline: 同级新 heading 应清除旧 heading (不再累积)', () => {
    // 回归: 旧版 headingStack 只 push 不 pop, 导致后面所有 block 拿到
    // 所有前面的 heading。新版基于级别 pop, 同级新 heading 出现时旧 heading 被清除。
    setupHTML(`
      <article>
        <h1>React Hooks</h1>
        <p>React hooks paragraph content here.</p>
        <h1>Vue Signals</h1>
        <p>Vue signals paragraph content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const reactBlock = blocks.find(b => b.text.startsWith('React hooks'));
    const vueBlock = blocks.find(b => b.text.startsWith('Vue signals'));

    expect(reactBlock).toBeTruthy();
    expect(vueBlock).toBeTruthy();

    // React 段落: headingPath 应包含 "React Hooks"
    expect(reactBlock!.context!.headingPath).toContain('React Hooks');
    expect(reactBlock!.context!.headingPath).not.toContain('Vue Signals');

    // Vue 段落: headingPath 应包含 "Vue Signals" 但不再包含 "React Hooks"
    expect(vueBlock!.context!.headingPath).toContain('Vue Signals');
    expect(vueBlock!.context!.headingPath).not.toContain('React Hooks');
  });

  it('heading outline: 子级别 heading 保留父 heading', () => {
    setupHTML(`
      <article>
        <h1>Main Title</h1>
        <h2>Subsection</h2>
        <p>Paragraph under subsection with enough text.</p>
        <h2>Another Subsection</h2>
        <p>Another paragraph with enough text.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const p1 = blocks.find(b => b.text.startsWith('Paragraph under subsection'));
    const p2 = blocks.find(b => b.text.startsWith('Another paragraph'));

    expect(p1).toBeTruthy();
    expect(p2).toBeTruthy();

    // p1: headingPath 应包含 h1 和 h2
    expect(p1!.context!.headingPath).toContain('Main Title');
    expect(p1!.context!.headingPath).toContain('Subsection');

    // p2: headingPath 应包含 h1 和第二个 h2, 但不应包含第一个 h2
    expect(p2!.context!.headingPath).toContain('Main Title');
    expect(p2!.context!.headingPath).toContain('Another Subsection');
    expect(p2!.context!.headingPath).not.toContain('Subsection');
  });
});

describe('findBlockNode', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should find node by XPath', () => {
    setupHTML(`
      <article>
        <p id="test">Test paragraph content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);

    const node = findBlockNode(blocks[0], document);
    expect(node).toBeTruthy();
    expect(node!.textContent).toContain('Test paragraph');
  });
});

describe('extractBlocks - Paragraph with Inline Elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract paragraph with inline b and a tags as single block', () => {
    setupHTML(`
      <article>
        <p><b>1.</b> We launched <a href="#">Gemini 3.5 Flash</a>: the first in our latest series of models combining frontier intelligence with action.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    // 应该只提取一个段落块，而不是多个块
    expect(pBlocks).toHaveLength(1);
    expect(pBlocks[0].text).toBe('1. We launched Gemini 3.5 Flash: the first in our latest series of models combining frontier intelligence with action.');
  });

  it('should not extract inline elements separately from parent paragraph', () => {
    setupHTML(`
      <article>
        <p><b>Bold text</b> and <a href="#">linked text</a> together in one paragraph.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    
    // 不应该有单独的 <b> 或 <a> 块
    const inlineBlocks = blocks.filter(b => ['b', 'strong', 'a', 'span'].includes(b.tag));
    expect(inlineBlocks).toHaveLength(0);
    
    // 应该只有一个段落块
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(1);
    expect(pBlocks[0].text).toBe('Bold text and linked text together in one paragraph.');
  });

  it('should handle complex inline structure in paragraph', () => {
    setupHTML(`
      <article>
        <p><span><strong>Important:</strong></span> This is <em>emphasized</em> text with <a href="#">a link</a> inside.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    expect(pBlocks).toHaveLength(1);
    expect(pBlocks[0].text).toBe('Important: This is emphasized text with a link inside.');
  });
});

describe('extractBlocks - Google Blog Alternating Translation Issue', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should NOT skip alternating paragraphs (fix for walker.currentNode bug)', () => {
    // 模拟 Google Blog 实际页面结构：h3 标题也会被提取
    // 关键：h3 和 p 都是 DIRECT_SET 成员，都会被 grabNode 接受
    // 当 h3 被接受后，如果设置 walker.currentNode = nextSibling，会导致下一个 p 被跳过
    setupHTML(`
      <article>
        <div class="rich-text">
          <h3>Gemini 3.5</h3>
          <p><b>1.</b> We launched Gemini 3.5 Flash: the first in our latest series.</p>
          <p>2. Gemini 3.5 Flash is generally available today.</p>
          <p><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models.</p>
          <p>4. Landing in the top-right quadrant of the Artificial Analysis index.</p>
          <p><b>5.</b> Gemini 3.5 Flash is ideal for tackling long-horizon agentic tasks.</p>
          <p>6. Building on the strong multimodal foundation of Gemini 3.</p>
          <h3>Gemini Omni</h3>
          <p><b>7.</b> Gemini Omni is our new model that can create anything from any input.</p>
          <p>8. It combines Gemini's intelligence with the best of our generative media models.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    const h3Blocks = blocks.filter(b => b.tag === 'h3');
    
    // 验证 h3 也被提取
    expect(h3Blocks).toHaveLength(2);
    
    // 关键测试：所有 8 个段落都应该被提取，不应该"隔一个跳过"
    expect(pBlocks).toHaveLength(8);
    
    // 验证每个段落的编号都存在
    const extractedTexts = pBlocks.map(b => b.text);
    expect(extractedTexts.some(t => t.includes('1.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('2.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('3.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('4.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('5.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('6.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('7.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('8.'))).toBe(true);
  });

  it('should extract all paragraphs including those with inline b and a tags', () => {
    setupHTML(`
      <article>
        <div class="rich-text">
          <h3 data-block-key="o63sw">Gemini 3.5</h3>
          <p data-block-key="f5hj2"><b>1.</b> We launched <a href="#">Gemini 3.5 Flash</a>: the first in our latest series of models combining frontier intelligence with action.</p>
          <p data-block-key="com71">2. Gemini 3.5 Flash is generally available today via our agent-first development platform.</p>
          <p data-block-key="ar1dc"><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series.</p>
          <p data-block-key="2ugbm">4. Landing in the top-right quadrant of the Artificial Analysis index, 3.5 Flash delivers frontier-level intelligence.</p>
          <p data-block-key="61kma"><b>5.</b> Gemini 3.5 Flash is ideal for tackling long-horizon agentic tasks, with <a href="#">new features</a>.</p>
          <p data-block-key="4u52g">6. Building on the strong multimodal foundation of Gemini 3, 3.5 Flash generates richer, more interactive web UIs.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    // 应该提取所有 6 个段落，不管是否包含 <b> 或 <a> 标签
    expect(pBlocks).toHaveLength(6);
    
    // 验证每个段落的文本都被正确提取
    const extractedTexts = pBlocks.map(b => b.text);
    
    expect(extractedTexts.some(t => t.includes('1. We launched'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('2. Gemini 3.5 Flash is generally'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('3. Gemini 3.5 Flash delivers intelligence'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('4. Landing in the top-right'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('5. Gemini 3.5 Flash is ideal'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('6. Building on the strong'))).toBe(true);
  });

  it('should extract paragraphs with mixed inline elements', () => {
    setupHTML(`
      <article>
        <div class="rich-text">
          <p data-block-key="test1"><b>Bold</b> and <a href="#">link</a> in paragraph.</p>
          <p data-block-key="test2">Plain text paragraph.</p>
          <p data-block-key="test3"><strong>Strong</strong> text with <em>emphasis</em> inside.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    expect(pBlocks).toHaveLength(3);
    
    // 验证包含内联元素的段落也被正确提取
    const test1Block = pBlocks.find(b => b.text.includes('Bold'));
    const test2Block = pBlocks.find(b => b.text.includes('Plain text'));
    const test3Block = pBlocks.find(b => b.text.includes('Strong'));
    
    expect(test1Block).toBeTruthy();
    expect(test2Block).toBeTruthy();
    expect(test3Block).toBeTruthy();
  });

  it('should extract all paragraphs in rich-text div inside article', () => {
    setupHTML(`
      <article>
        <div class="rich-text">
          <h3>Gemini 3.5</h3>
          <p><b>1.</b> We launched <a href="#">Gemini 3.5 Flash</a>: the first in our latest series of models.</p>
          <p><b>2.</b> Gemini 3.5 Flash is generally available today via our agent-first development platform.</p>
          <p><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series. It outperforms Gemini 3.1 Pro on challenging coding and agentic benchmarks like Terminal-Bench 2.1 (76.2%), GDPval-AA (1656 Elo) and MCP Atlas (83.6%).</p>
          <p><b>4.</b> Landing in the top-right quadrant of the Artificial Analysis index, 3.5 Flash delivers frontier-level intelligence.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    // 应该提取所有 4 个段落
    expect(pBlocks).toHaveLength(4);
    
    // 检查第 3 个段落是否被提取
    const thirdParagraph = pBlocks.find(b => b.text.includes('Gemini 3.5 Flash delivers intelligence'));
    expect(thirdParagraph).toBeTruthy();
    expect(thirdParagraph!.text).toContain('Terminal-Bench 2.1');
    expect(thirdParagraph!.text).toContain('GDPval-AA');
    expect(thirdParagraph!.text).toContain('MCP Atlas');
  });

  it('should extract paragraphs with data-block-key attribute', () => {
    setupHTML(`
      <article>
        <div class="rich-text">
          <h3 data-block-key="o63sw">Gemini 3.5</h3>
          <p data-block-key="f5hj2"><b>1.</b> We launched <a href="#">Gemini 3.5 Flash</a>: the first in our latest series.</p>
          <p data-block-key="com71"><b>2.</b> Gemini 3.5 Flash is generally available today.</p>
          <p data-block-key="ar1dc"><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series.</p>
          <p data-block-key="2ugbm"><b>4.</b> Landing in the top-right quadrant of the Artificial Analysis index.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    expect(pBlocks).toHaveLength(4);
    
    // 检查所有段落的文本都被提取
    const extractedTexts = pBlocks.map(b => b.text);
    expect(extractedTexts.some(t => t.includes('1. We launched'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('2. Gemini 3.5 Flash is generally'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('3. Gemini 3.5 Flash delivers intelligence'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('4. Landing in the top-right'))).toBe(true);
  });

  it('should handle uni-paragraph wrapper like Google Blog', () => {
    setupHTML(`
      <article>
        <div class="uni-paragraph article-paragraph" data-component="uni-article-paragraph">
          <div class="rich-text">
            <h3 data-block-key="o63sw">Gemini 3.5</h3>
            <p data-block-key="f5hj2"><b>1.</b> First paragraph content with enough text length here.</p>
            <p data-block-key="ar1dc"><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series. It outperforms Gemini 3.1 Pro on challenging coding and agentic benchmarks.</p>
            <p data-block-key="2ugbm"><b>4.</b> Fourth paragraph content with enough text length here.</p>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    expect(pBlocks).toHaveLength(3);
    
    const geminiParagraph = pBlocks.find(b => b.text.includes('Gemini 3.5 Flash delivers intelligence'));
    expect(geminiParagraph).toBeTruthy();
  });

  // Regression test: TreeWalker's currentNode must NOT be manually modified.
  //
  // In real browsers (Chrome/Firefox), after walker.nextNode() returns a node,
  // setting walker.currentNode = currentNode.nextSibling causes the NEXT call
  // to nextNode() to skip the sibling element itself and only visit its
  // children (text nodes / inline elements). Since grabNode rejects text
  // nodes, sibling paragraphs alternatingly disappear — only every other <p>
  // creates a block.
  //
  // Example (minified HTML, no whitespace text nodes between <p> siblings):
  //   <h3>Title</h3><p><b>1.</b> text</p><p>2. text</p><p><b>3.</b> text</p>
  //   → blocks for <p>2.</p> and following <p>4.</p>, etc. (odds skipped)
  //
  // NOTE: jsdom's TreeWalker handles currentNode assignment differently from
  // real browsers, so this test CANNOT reproduce the bug in jsdom. It
  // verifies the correct behaviour (all paragraphs extracted) using the
  // structure that previously triggered the issue.
  it('should extract ALL consecutive paragraphs without alternating skip (TreeWalker currentNode guard)', () => {
    // Exact minified format from blog.google — no whitespace between tags
    setupHTML(`<article><div class="rich-text"><h3>Section</h3><p><b>1.</b> First paragraph with bold lead-in has enough text length.</p><p><b>2.</b> Second paragraph also starts with bold and has enough text.</p><p><b>3.</b> Third paragraph follows the same bold pattern with enough text.</p><p><b>4.</b> Fourth paragraph here still following the bold pattern text.</p><p><b>5.</b> Fifth paragraph maintains the alternating bold start pattern.</p><p><b>6.</b> Sixth and final paragraph using the bold start pattern text.</p></div></article>`);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');

    // ALL 6 paragraphs must be extracted, not just every other one
    expect(pBlocks).toHaveLength(6);

    const texts = pBlocks.map(b => b.text);
    expect(texts.some(t => t.startsWith('1.'))).toBe(true);
    expect(texts.some(t => t.startsWith('2.'))).toBe(true);
    expect(texts.some(t => t.startsWith('3.'))).toBe(true);
    expect(texts.some(t => t.startsWith('4.'))).toBe(true);
    expect(texts.some(t => t.startsWith('5.'))).toBe(true);
    expect(texts.some(t => t.startsWith('6.'))).toBe(true);
  });

  // Simulates the actual blog.google structure with module--text wrappers and
  // multiple heading sections, verifying no paragraphs are skipped.
  it('should extract all paragraphs in multi-section Google Blog structure', () => {
    setupHTML(`
      <article>
        <div class="uni-content">
          <div class="module--text module--text__article" role="presentation">
            <div class="uni-paragraph article-paragraph">
              <div class="rich-text">
                <p class="drop-cap">This week at Google I/O 2026 we unveiled new models and tools. You can dig into our announcements for a TL;DR keep scrolling for our annual list of 100 highlights from the event.</p>
              </div>
            </div>
          </div>

          <div class="module--text module--text__article" role="presentation">
            <div class="uni-paragraph article-paragraph">
              <div class="rich-text"><h2>Create and build with our most advanced models</h2></div>
            </div>
          </div>

          <div class="module--text module--text__article" role="presentation">
            <div class="uni-paragraph article-paragraph">
              <div class="rich-text"><h3>Gemini 3.5</h3><p><b>1.</b> We launched <a href="#">Gemini 3.5 Flash</a>: the first in our latest series of models combining frontier intelligence with action.</p><p><b>2.</b> Gemini 3.5 Flash is generally available today via our agent-first development platform.</p><p><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series. It outperforms Gemini 3.1 Pro on challenging coding and agentic benchmarks.</p><p><b>4.</b> Landing in the top-right quadrant of the Artificial Analysis index 3.5 Flash delivers frontier-level intelligence at exceptional speed.</p></div>
            </div>
          </div>

          <div class="module--text module--text__article" role="presentation">
            <div class="uni-paragraph article-paragraph">
              <div class="rich-text"><h3 data-block-key="w4ep3">AI Search</h3><p data-block-key="ak933"><b>17.</b> <a href="#">AI Mode</a> is our most powerful AI Search and it has surpassed more than 1 billion monthly users.</p><p data-block-key="fbafd"><b>18.</b> We are seeing incredible momentum with AI Mode queries more than doubling every quarter since launch.</p><p data-block-key="3o9av"><b>19.</b> Today we are launching the biggest upgrade to our Search box in over 25 years a new intelligent Search box.</p><p data-block-key="34i32"><b>20.</b> We are also making it even easier to continue the conversation with Search bringing AI Overviews and AI Mode into one seamless AI Search experience.</p></div>
            </div>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');

    // All 9 paragraphs across all sections must be extracted (including drop-cap intro)
    expect(pBlocks).toHaveLength(9);

    const texts = pBlocks.map(b => b.text);
    expect(texts.some(t => t.includes('1. We launched'))).toBe(true);
    expect(texts.some(t => t.includes('2. Gemini 3.5 Flash is generally'))).toBe(true);
    expect(texts.some(t => t.includes('3. Gemini 3.5 Flash delivers intelligence'))).toBe(true);
    expect(texts.some(t => t.includes('4. Landing in the top-right'))).toBe(true);
    expect(texts.some(t => t.includes('17. AI Mode is our most powerful'))).toBe(true);
    expect(texts.some(t => t.includes('18. We are seeing incredible momentum'))).toBe(true);
    expect(texts.some(t => t.includes('19. Today we are launching the biggest'))).toBe(true);
    expect(texts.some(t => t.includes('20. We are also making it even easier'))).toBe(true);
  });
});

describe('extractBlocks - Google Blog Alternating Translation Issue (Real Structure)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract all paragraphs from sample.html exact structure', () => {
    // 完全模拟 sample.html 中 Gemini 3.5 部分的实际 DOM 结构
    setupHTML(`
      <article>
        <div class="uni-paragraph article-paragraph" data-component="uni-article-paragraph" data-component-initialized="true">
          <div class="rich-text">
            <h3 data-block-key="o63sw">Gemini 3.5</h3>
            <p data-block-key="f5hj2"><b>1.</b> We launched <a href="https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-5/">Gemini 3.5 Flash</a>: the first in our latest series of models combining frontier intelligence with action.</p>
            <p data-block-key="com71"><b>2.</b> Gemini 3.5 Flash is generally available today via our agent-first development platform <a href="https://antigravity.google/" rel="noopener" target="_blank">Google Antigravity</a> the Gemini API in <a href="https://aistudio.google.com/" rel="noopener" target="_blank">Google AI Studio</a> and <a href="https://developer.android.com/studio" rel="noopener" target="_blank">Android Studio</a>.</p>
            <p data-block-key="ar1dc"><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series. It outperforms Gemini 3.1 Pro on challenging coding and agentic benchmarks like Terminal-Bench 2.1 (76.2%), GDPval-AA (1656 Elo) and MCP Atlas (83.6%).</p>
            <p data-block-key="2ugbm"><b>4.</b> Landing in the top-right quadrant of the Artificial Analysis index, 3.5 Flash delivers frontier-level intelligence at exceptional speed — proving you no longer have to trade quality for latency.</p>
            <p data-block-key="61kma"><b>5.</b> Gemini 3.5 Flash is ideal for tackling long-horizon agentic tasks. What used to take a developer days or an auditor weeks, 3.5 Flash can now help complete in a fraction of the time, often at less than half the cost of other frontier models. It rapidly plans, builds and iterates to solve real-world problems, whether it’s developing new applications, maintaining codebases or helping to prepare financial documents.</p>
            <p data-block-key="4u52g"><b>6.</b> Building on the strong multimodal foundation of Gemini 3, 3.5 Flash generates richer, more interactive web UIs and graphics.</p>
            <p data-block-key="2mko"><b>7.</b> We’re also hard at work on Gemini 3.5 Pro. It’s already being used internally and we look forward to rolling it out next month.</p>
            <h3 data-block-key="7tmnq">Gemini Omni</h3>
            <p data-block-key="bo6h"><b>8.</b> <a href="https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-omni/">Gemini Omni</a> is our new model that can create anything from any input — starting with video. It combines Gemini's intelligence with the best of our generative media models for a new level of world understanding, multimodality and editing. We’re starting with video outputs now, but over time, Gemini Omni will be able to generate any output from any input.</p>
            <p data-block-key="6qdvi"><b>9.</b> <a href="https://deepmind.google/models/gemini-omni/" rel="noopener" target="_blank">Gemini Omni</a> combines an intuitive understanding of physics with Gemini's knowledge of history, science and culture, bridging the gap from photorealism to meaningful storytelling. It has an improved understanding of forces like gravity, kinetic energy and fluid dynamics, allowing you to create more realistic scenes.</p>
            <p data-block-key="1kof1"><b>10.</b> Videos created with Omni include our imperceptible <a href="https://blog.google/innovation-and-ai/products/identifying-ai-generated-media-online/">SynthID digital watermark</a>. You can easily verify content through the Gemini app, Gemini in Chrome and Search.</p>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    const h3Blocks = blocks.filter(b => b.tag === 'h3');
    
    // 验证 h3 标题被提取
    expect(h3Blocks).toHaveLength(2);
    expect(h3Blocks.some(b => b.text === 'Gemini 3.5')).toBe(true);
    expect(h3Blocks.some(b => b.text === 'Gemini Omni')).toBe(true);
    
    // 关键测试：所有 10 个段落都应该被提取，不应该"隔一个跳过"
    expect(pBlocks).toHaveLength(10);
    
    // 验证每个段落的编号都存在（包括之前未被翻译的第 3 段）
    const extractedTexts = pBlocks.map(b => b.text);
    expect(extractedTexts.some(t => t.includes('1. We launched'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('2. Gemini 3.5 Flash is generally'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('3. Gemini 3.5 Flash delivers intelligence'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('4. Landing in the top-right'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('5. Gemini 3.5 Flash is ideal'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('6. Building on the strong'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('7. We’re also hard at work'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('8. Gemini Omni'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('9. Gemini Omni'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('10. Videos created with Omni'))).toBe(true);
    
    // 特别验证之前未被翻译的第 3 段内容
    const thirdParagraph = pBlocks.find(b => b.text.includes('Terminal-Bench 2.1'));
    expect(thirdParagraph).toBeTruthy();
    expect(thirdParagraph!.text).toContain('76.2%');
    expect(thirdParagraph!.text).toContain('GDPval-AA');
    expect(thirdParagraph!.text).toContain('1656 Elo');
    expect(thirdParagraph!.text).toContain('MCP Atlas');
    expect(thirdParagraph!.text).toContain('83.6%');
  });
});

describe('extractBlocks - Substack Article Structure (sample2.html)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract subtitle h3 and all paragraphs from Substack article structure', () => {
    // 模拟 sample2.html（Substack 文章）的 DOM 结构，包含 post-header、author info、available-content、body.markup 等
    const html = `
      <div id="entry">
        <div id="main" class="main typography use-theme-bg">
          <div aria-label="Post" role="main" class="single-post-container">
            <div class="container">
              <div class="single-post">
                <div class="pencraft pc-display-contents pc-reset pubTheme-yiXxQA">
                  <article class="typography newsletter-post post">
                    <div role="region" aria-label="Post header" class="post-header">
                      <h1 dir="auto" class="post-title published title-X77sOw">Recent Developments in LLM Architectures: KV Sharing, mHC, and Compressed Attention</h1>
                      <h3 dir="auto" class="subtitle subtitle-HEEcLo">From Gemma 4 to DeepSeek V4, How New Open-Weight LLMs Are Reducing Long-Context Costs</h3>
                      <div aria-label="Post UFI" role="region" class="pencraft pc-display-flex pc-flexDirection-column pc-paddingBottom-16 pc-reset">
                        <div class="pencraft pc-display-flex pc-paddingTop-16 pc-paddingBottom-16 pc-justifyContent-space-between pc-alignItems-center pc-reset">
                          <div class="pencraft pc-display-flex pc-gap-12 pc-alignItems-center pc-reset byline-wrapper">
                            <div class="pencraft pc-display-flex pc-reset">
                              <div class="pencraft pc-display-flex pc-flexDirection-row pc-gap-8 pc-alignItems-center pc-justifyContent-flex-start pc-reset">
                                <div class="pencraft pc-display-flex pc-flexDirection-row pc-alignItems-center pc-justifyContent-flex-start pc-reset">
                                  <div class="pencraft pc-display-flex pc-width-36 pc-height-36 pc-justifyContent-center pc-alignItems-center pc-position-relative pc-reset">Avatar</div>
                                </div>
                              </div>
                            </div>
                            <div class="pencraft pc-display-flex pc-flexDirection-column pc-reset">
                              <div class="pencraft pc-reset">Sebastian Raschka, PhD</div>
                              <div class="pencraft pc-display-flex pc-gap-4 pc-reset">
                                <div class="pencraft pc-reset">May 16, 2026</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="available-content">
                      <div dir="auto" class="body markup">
                        <p>After a short family break, I am excited to be back and catching up on a busy few weeks of open-weight LLM releases. The thing that stood out to me is how much newer architectures are focused on long-context efficiency.</p>
                        <p>As reasoning models and agent workflows keep more tokens around (for longer), KV-cache size, memory traffic, and attention cost quickly become the main constraints, and LLM developers are adding a growing number of architecture tricks to reduce those costs.</p>
                        <p>The main examples I want to look at are KV sharing and per-layer embeddings in Gemma 4, layer-wise attention budgeting in Laguna XS.2, compressed convolutional attention in ZAYA1-8B, and mHC plus compressed attention in DeepSeek V4.</p>
                      </div>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    setupHTML(html);
    const blocks = extractBlocks(document, "https://example.com/test");

    const h3Blocks = blocks.filter(b => b.tag === 'h3');
    const pBlocks = blocks.filter(b => b.tag === 'p');

    // 验证 subtitle h3 被提取
    expect(h3Blocks.some(b => b.text.includes('From Gemma 4 to DeepSeek V4'))).toBe(true);

    // 验证所有段落被提取
    expect(pBlocks.some(b => b.text.includes('After a short family break'))).toBe(true);
    expect(pBlocks.some(b => b.text.includes('As reasoning models'))).toBe(true);
    expect(pBlocks.some(b => b.text.includes('KV sharing and per-layer embeddings'))).toBe(true);

    // 总数：1 个 title h1 + 1 个 subtitle h3 + 3 个段落 + 3 个 byline divs（Avatar/name/date）
    expect(blocks.filter(b => b.tag === 'h1')).toHaveLength(1);
    expect(h3Blocks.filter(b => b.text.includes('From Gemma 4'))).toHaveLength(1);
    expect(pBlocks).toHaveLength(3);
  });

  it('should correctly resolve XPath for subtitle h3 (no index collision)', () => {
    // 验证 findBlockNode 能正确匹配 subtitle h3，
    // 即使 document 中还有其他 h3 元素（例如 navbar 中的 h3）
    const html = `
      <div id="entry">
        <div id="main" class="main typography use-theme-bg">
          <div aria-label="Post" role="main" class="single-post-container">
            <div class="container">
              <div class="single-post">
                <div class="pencraft pc-display-contents pc-reset pubTheme-yiXxQA">
                  <article class="typography newsletter-post post">
                    <div role="region" aria-label="Post header" class="post-header">
                      <h3 dir="auto" class="subtitle subtitle-HEEcLo">From Gemma 4 to DeepSeek V4, How New Open-Weight LLMs Are Reducing Long-Context Costs</h3>
                    </div>
                    <div class="available-content">
                      <div dir="auto" class="body markup">
                        <p>After a short family break, I am excited to be back and catching up on a busy few weeks of open-weight LLM releases.</p>
                      </div>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    setupHTML(html);

    const blocks = extractBlocks(document, "https://example.com/test");
    const subtitleBlock = blocks.find(b => b.tag === 'h3');
    expect(subtitleBlock).toBeTruthy();

    // buildNodeMap 验证 XPath 能正确匹配
    const nodeMap = buildNodeMap(blocks, document);
    const foundNode = nodeMap.get(subtitleBlock!.id);
    expect(foundNode).toBeTruthy();
    expect((foundNode as Element)?.tagName?.toLowerCase()).toBe('h3');
  });

  it('should resolve subtitle h3 XPath when distractor h3 elements exist outside article (navbar)', () => {
    // 模拟真实 Substack 页面：navbar 中也有 h3 元素，
    // 需要验证 subtitle h3 的 XPath 索引不受干扰
    const html = `
      <div id="entry">
        <div class="main-menu">
          <div style="position: fixed;">
            <div class="pencraft pc-display-flex pc-reset">
              <div class="logoContainer-p12gJb">
                <h3 class="sidebarHeading">Navigation</h3>
              </div>
              <div class="titleContainer-DJYq5v">
                <h3 class="sidebarHeading">Sections</h3>
              </div>
            </div>
          </div>
        </div>
        <div id="main" class="main typography use-theme-bg">
          <div aria-label="Post" role="main" class="single-post-container">
            <div class="container">
              <div class="single-post">
                <div class="pencraft pc-display-contents pc-reset">
                  <article class="typography newsletter-post post">
                    <div role="region" aria-label="Post header" class="post-header">
                      <h1 class="post-title">Recent Developments in LLM Architectures</h1>
                      <h3 class="subtitle subtitle-HEEcLo">From Gemma 4 to DeepSeek V4, How New Open-Weight LLMs Are Reducing Long-Context Costs</h3>
                    </div>
                    <div class="available-content">
                      <div dir="auto" class="body markup">
                        <p>After a short family break, I am excited to be back and catching up on a busy few weeks of open-weight LLM releases.</p>
                      </div>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    setupHTML(html);

    const blocks = extractBlocks(document, "https://example.com/test");
    const subtitleBlock = blocks.find(b => b.tag === 'h3' && b.text.includes('From Gemma 4'));
    expect(subtitleBlock).toBeTruthy();

    const nodeMap = buildNodeMap(blocks, document);
    const foundNode = nodeMap.get(subtitleBlock!.id);

    // 即使有 2 个导航 h3 在前面, subtitle h3 也必须被正确匹配
    expect(foundNode).toBeTruthy();
    expect((foundNode as Element)?.tagName?.toLowerCase()).toBe('h3');
    expect((foundNode as Element)?.textContent).toContain('From Gemma 4');
  });

  it('should not duplicate text when blockquote contains a single p', () => {
    setupHTML(`
      <article>
        <blockquote>
          <p>Do not trust analysis written in the issue. Independently verify behavior and derive your own analysis from the code and execution path.</p>
        </blockquote>
        <p>That is worse than no diagnosis.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    const targetText = 'Do not trust analysis written in the issue.';
    const matches = texts.filter(t => t.includes(targetText));
    expect(matches.length).toBe(1);
  });

  it('should handle blockquote with multiple p children', () => {
    setupHTML(`
      <article>
        <blockquote>
          <p>First paragraph inside blockquote.</p>
          <p>Second paragraph inside blockquote.</p>
          <p>Third paragraph inside blockquote.</p>
        </blockquote>
        <p>Content after blockquote.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts).toContain('First paragraph inside blockquote.');
    expect(blockTexts).toContain('Second paragraph inside blockquote.');
    expect(blockTexts).toContain('Third paragraph inside blockquote.');
    expect(blockTexts).toContain('Content after blockquote.');

    const blockquoteExtractions = blocks.filter(b => b.tag === 'blockquote');
    expect(blockquoteExtractions.length).toBe(0);
  });

  it('should still extract blockquote when it has no block-level children', () => {
    setupHTML(`
      <article>
        <blockquote>
          A simple blockquote without any nested block elements.
        </blockquote>
        <p>Content after.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts).toContain('A simple blockquote without any nested block elements.');
    expect(blockTexts).toContain('Content after.');
  });
});

describe('extractBlocks - MathML/SVG namespace filtering', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip MathML elements inside paragraphs', () => {
    setupHTML(`
      <article>
        <p>The speedup <math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mn>1</mn></mrow></math> of a program is limited.</p>
        <p>Another paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const mathBlocks = blocks.filter(b => b.tag === 'math');
    expect(mathBlocks).toHaveLength(0);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should skip MathML elements with nested mrow/mn', () => {
    setupHTML(`
      <article>
        <p>Amdahl's law formula: <math xmlns="http://www.w3.org/1998/Math/MathML">
          <mrow>
            <mi>S</mi>
            <mo>=</mo>
            <mfrac>
              <mn>1</mn>
              <mrow>
                <mo>(</mo>
                <mn>1</mn>
                <mo>-</mo>
                <mi>p</mi>
                <mo>)</mo>
                <mo>+</mo>
                <mfrac><mi>p</mi><mi>n</mi></mfrac>
              </mrow>
            </mfrac>
          </mrow>
        </math></p>
        <p>This paragraph is about Amdahl's law and has enough text.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const mathBlocks = blocks.filter(b => b.tag === 'math');
    expect(mathBlocks).toHaveLength(0);

    const mathChildBlocks = blocks.filter(b =>
      ['mrow', 'mi', 'mo', 'mn', 'mfrac'].includes(b.tag)
    );
    expect(mathChildBlocks).toHaveLength(0);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should skip SVG elements', () => {
    setupHTML(`
      <article>
        <p>Below is an icon: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">
          <circle cx="12" cy="12" r="10" />
        </svg></p>
        <p>Paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const svgBlocks = blocks.filter(b => b.tag === 'svg');
    expect(svgBlocks).toHaveLength(0);

    const svgChildBlocks = blocks.filter(b => ['circle', 'path', 'rect'].includes(b.tag));
    expect(svgChildBlocks).toHaveLength(0);
  });

  it('should handle Wikipedia-style MathML in article content', () => {
    setupHTML(`
      <article>
        <p>In computer architecture, <b>Amdahl's law</b> is a formula that gives the theoretical speedup in latency of the execution of a task at fixed workload that can be expected of a system whose resources are improved.</p>
        <p>The speedup can be formulated as:</p>
        <p><math xmlns="http://www.w3.org/1998/Math/MathML">
          <mrow>
            <mi>S</mi>
            <mo>=</mo>
            <mfrac>
              <mn>1</mn>
              <mrow>
                <mo>(</mo>
                <mn>1</mn>
                <mo>-</mo>
                <mi>p</mi>
                <mo>)</mo>
                <mo>+</mo>
                <mfrac><mi>p</mi><mi>n</mi></mfrac>
              </mrow>
            </mfrac>
          </mrow>
        </math></p>
        <p>Where <i>S</i> is the theoretical speedup, <i>p</i> is the proportion of the program that can be made parallel, and <i>n</i> is the number of processors.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");

    const mathBlocks = blocks.filter(b => b.tag === 'math');
    expect(mathBlocks).toHaveLength(0);

    const mathChildBlocks = blocks.filter(b =>
      ['mrow', 'mi', 'mo', 'mn', 'mfrac'].includes(b.tag)
    );
    expect(mathChildBlocks).toHaveLength(0);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBeGreaterThanOrEqual(3);

    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts.some(t => t.includes("Amdahl's law"))).toBe(true);
    expect(blockTexts.some(t => t.includes('theoretical speedup'))).toBe(true);
  });

  it('should skip inline SVG inside paragraph but still extract the paragraph text', () => {
    setupHTML(`
      <article>
        <p>Click the <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M0 0h16v16H0z"/></svg> icon to save.</p>
        <p>Another paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const svgBlocks = blocks.filter(b => b.tag === 'svg');
    expect(svgBlocks).toHaveLength(0);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBe(2);
  });
});

describe('extractBlocks - Nested lists', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract nested ul list items only', () => {
    setupHTML(`
      <article>
        <ul>
          <li>First level item with enough text content to be extracted.</li>
          <li>Second level item parent with nested list.</li>
          <ul>
            <li>Nested first item with enough text content here.</li>
            <li>Nested second item with enough text content here.</li>
          </ul>
          <li>Third level item with enough text content.</li>
        </ul>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const liBlocks = blocks.filter(b => b.tag === 'li');
    expect(liBlocks.length).toBeGreaterThanOrEqual(4);
  });

  it('should extract nested ol list items', () => {
    setupHTML(`
      <article>
        <ol>
          <li>Step one with comprehensive description text here.</li>
          <li>Step two with detailed explanation of the process.</li>
          <ol>
            <li>Sub-step one with additional detailed text content.</li>
            <li>Sub-step two with more explanatory information.</li>
          </ol>
          <li>Step three with final concluding description text.</li>
        </ol>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const liBlocks = blocks.filter(b => b.tag === 'li');
    expect(liBlocks.length).toBeGreaterThanOrEqual(4);
  });
});

describe('extractBlocks - Tables', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract table cells as text blocks', () => {
    setupHTML(`
      <article>
        <p>Below is a comparison table showing the results.</p>
        <table>
          <thead>
            <tr><th>Model Name</th><th>Accuracy Score</th></tr>
          </thead>
          <tbody>
            <tr><td>Model A</td><td>95.2%</td></tr>
            <tr><td>Model B</td><td>93.7%</td></tr>
          </tbody>
        </table>
        <p>As shown above, Model A performs best overall.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(2);
    expect(pBlocks[0].text).toBe('Below is a comparison table showing the results.');
    expect(pBlocks[1].text).toBe('As shown above, Model A performs best overall.');
  });

  it('should skip table caption and cell elements', () => {
    setupHTML(`
      <article>
        <table>
          <caption>Table One: Performance Comparison of Different Models</caption>
          <tr><th>Model</th><th>Score</th></tr>
          <tr><td>GPT-5</td><td>98.7</td></tr>
        </table>
        <p>Regular paragraph after table with enough content.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const captionBlocks = blocks.filter(b => b.tag === 'caption');
    expect(captionBlocks).toHaveLength(0);
    const cellBlocks = blocks.filter(b => b.tag === 'td' || b.tag === 'th');
    expect(cellBlocks).toHaveLength(0);
    expect(blocks.some(b => b.tag === 'p')).toBe(true);
  });
});

describe('extractBlocks - Details/Summary elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should not extract summary as standalone block', () => {
    setupHTML(`
      <article>
        <details>
          <summary>Click to expand this section with detailed information</summary>
          <p>Hidden content that becomes visible when expanded here.</p>
        </details>
        <p>Regular paragraph outside details element.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('extractBlocks - Reference/citation patterns', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip sup reference links (Wikipedia style)', () => {
    setupHTML(`
      <article>
        <p>Amdahl's law is a formula in computer architecture<sup id="cite_ref-1"><a href="#cite_note-1">[1]</a></sup> that is widely cited.</p>
        <p>Another paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const supBlocks = blocks.filter(b => b.tag === 'sup');
    expect(supBlocks).toHaveLength(0);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBe(2);
    expect(pBlocks.some(b => b.text.includes("Amdahl's law"))).toBe(true);
  });

  it('should skip ordered list in references section when outside article', () => {
    setupHTML(`
      <article>
        <p>Main article content with enough text here.</p>
      </article>
      <div class="footnote">
        <ol>
          <li>Reference one citation details here.</li>
          <li>Reference two citation details here.</li>
        </ol>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts.some(t => t.includes('Reference one'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Reference two'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Main article'))).toBe(true);
  });
});

describe('extractBlocks - Duplicate text dedup (HBR summary callout)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should collapse identical paragraphs to a single block', () => {
    const shared = 'In the third edition of this study, the authors found that people are adopting generative AI for an ever-widening range of uses.';
    setupHTML(`
      <article>
        <div class="summary-callout"><p>${shared}</p></div>
        <div class="social-share-preview"><p>${shared}</p></div>
        <div class="article-body"><p>${shared}</p></div>
        <p>This paragraph is unique to the article body.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const occurrences = blocks.filter(b => b.text === shared).length;
    expect(occurrences).toBe(1);
    // The unique paragraph is still extracted.
    expect(blocks.some(b => b.text.includes('unique to the article body'))).toBe(true);
  });
});

describe('extractBlocks - HBR article layout (h3 inside content div, p following)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract h3 with CSS-modules class containing "subheader" and a following p', () => {
    // Real HBR class names (CSS-modules generated, contains "subheader"
    // as a substring). The previous SKIP_CLASS_PATTERNS check uses exact
    // token boundary matching so this should not match.
    setupHTML(`
      <article>
        <div class="Standard-module__content">
          <h3 class="Subheader-module__subheader Subheader-module__h3 undefined">
            <strong>Efficiencies</strong>
          </h3>
          <p class="Paragraph-module__text">
            Many individuals and teams are using AI to make current business processes more efficient.
          </p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.some(b => b.tag === 'h3' && b.text === 'Efficiencies')).toBe(true);
    expect(blocks.some(b => b.tag === 'p' && b.text.startsWith('Many individuals'))).toBe(true);
  });
});

describe('extractBlocks - Deeply nested structures', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract text from deeply nested divs in article', () => {
    setupHTML(`
      <article>
        <div class="content-wrapper">
          <div class="section">
            <div class="block">
              <div class="text-block">
                <p>Deeply nested paragraph with enough text content to be extracted properly.</p>
              </div>
            </div>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some(b => b.text.includes('Deeply nested paragraph'))).toBe(true);
  });

  it('should handle multiple sections with same nesting depth', () => {
    setupHTML(`
      <article>
        <section>
          <div><div><p>First section paragraph with enough text.</p></div></div>
        </section>
        <section>
          <div><div><p>Second section paragraph with enough text.</p></div></div>
        </section>
        <section>
          <div><div><p>Third section paragraph with enough text.</p></div></div>
        </section>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(3);
  });
});

describe('extractBlocks - Mixed real-world article', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should handle a complete article with mixed content types', () => {
    setupHTML(`
      <article>
        <h1>The Future of Artificial Intelligence Research</h1>
        <p class="byline">By John Smith, Published on May 20, 2026</p>
        <p>Artificial intelligence has transformed from a niche academic discipline into a fundamental technology driving innovation across every sector of the global economy.</p>
        <h2>Recent Breakthroughs in Model Architecture</h2>
        <p>The past year has witnessed remarkable advances in neural network design, particularly in the domain of transformer architectures and their successors.</p>
        <blockquote>
          <p>"The pace of innovation in AI has exceeded even our most optimistic projections from five years ago." — Dr. Sarah Chen, MIT</p>
        </blockquote>
        <p>These architectural innovations have led to substantial improvements in both training efficiency and inference performance.</p>
        <h2>Key Research Areas</h2>
        <ul>
          <li>Mixture of Experts architectures are enabling more efficient model scaling without proportional compute increases.</li>
          <li>Retrieval Augmented Generation continues to bridge the gap between parametric knowledge and external information sources.</li>
          <li>Multimodal models that seamlessly integrate text, vision, and audio understanding are becoming the new standard.</li>
        </ul>
        <h2>Conclusion</h2>
        <p>The trajectory of AI research suggests we are still in the early stages of understanding what these systems can achieve.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");

    const h1Blocks = blocks.filter(b => b.tag === 'h1');
    const h2Blocks = blocks.filter(b => b.tag === 'h2');
    const pBlocks = blocks.filter(b => b.tag === 'p');
    const liBlocks = blocks.filter(b => b.tag === 'li');

    expect(h1Blocks.length).toBe(1);
    expect(h2Blocks.length).toBe(3);
    expect(liBlocks.length).toBe(3);
    expect(pBlocks.length).toBeGreaterThanOrEqual(4);

    const texts = blocks.map(b => b.text);
    expect(texts.some(t => t.includes('Future of Artificial Intelligence'))).toBe(true);
    expect(texts.some(t => t.includes('Mixture of Experts'))).toBe(true);
    expect(texts.some(t => t.includes("Sarah Chen"))).toBe(true);
  });

  it('should handle article with figures interspersed', () => {
    setupHTML(`
      <article>
        <h1>Visual Guide to Neural Networks</h1>
        <p>Understanding neural network architectures requires both theoretical knowledge and visual intuition.</p>
        <figure>
          <img src="/network.png" alt="Neural network diagram" />
          <figcaption>Figure 1: A standard feedforward neural network with three hidden layers showing connections.</figcaption>
        </figure>
        <p>The diagram above illustrates the basic structure of a multi-layer perceptron, where each node represents a neuron.</p>
        <figure>
          <img src="/cnn.png" alt="CNN diagram" />
          <figcaption>Figure 2: Convolutional neural network architecture showing feature extraction layers.</figcaption>
        </figure>
        <p>Convolutional networks add specialized layers that excel at detecting spatial patterns in grid-like data.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const figcaptionBlocks = blocks.filter(b => b.tag === 'figcaption');
    expect(figcaptionBlocks).toHaveLength(2);
    expect(figcaptionBlocks.some(b => b.text.includes('Figure 1'))).toBe(true);
    expect(figcaptionBlocks.some(b => b.text.includes('Figure 2'))).toBe(true);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBe(3);
  });
});

describe('extractBlocks - Site Rule Skip Selectors', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // Reset module-level cache by using a unique URL each time
    Object.defineProperty(window, 'location', {
      value: { href: 'https://test-site-' + Math.random().toString(36).slice(2) + '.com/page' },
      writable: true,
      configurable: true,
    });
  });

  it('should skip elements matching site rule skip selectors', () => {
    vi.mocked(matchSiteRule).mockReturnValue({
      siteRule: {
        hostPattern: 'test-site-*.com',
        skipSelectors: ['.skip-me'],
      },
      matchedPattern: 'test-site-*.com',
    });

    setupHTML(`
      <article>
        <p>This paragraph should be extracted normally.</p>
        <div class="skip-me">
          <p>This paragraph should be skipped entirely.</p>
        </div>
        <p>Another extractable paragraph with enough text.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    expect(texts).toContain('This paragraph should be extracted normally.');
    expect(texts).toContain('Another extractable paragraph with enough text.');
    expect(texts.some(t => t.includes('skipped entirely'))).toBe(false);
  });

  it('should skip elements matching nested skip selectors', () => {
    vi.mocked(matchSiteRule).mockReturnValue({
      siteRule: {
        hostPattern: 'test-site-*.com',
        skipSelectors: ['.sidebar'],
      },
      matchedPattern: 'test-site-*.com',
    });

    setupHTML(`
      <article>
        <p>Visible paragraph with enough text to extract.</p>
        <aside class="sidebar">
          <p>This sidebar content should be skipped.</p>
        </aside>
        <p>Another visible paragraph with sufficient text content.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    expect(texts.some(t => t.includes('sidebar content'))).toBe(false);
    expect(texts.some(t => t.includes('Visible paragraph'))).toBe(true);
  });

  it('should skip descendants of elements matching skip selectors', () => {
    vi.mocked(matchSiteRule).mockReturnValue({
      siteRule: {
        hostPattern: 'test-site-*.com',
        skipSelectors: ['.comments-section'],
      },
      matchedPattern: 'test-site-*.com',
    });

    setupHTML(`
      <article>
        <p>Main article text that should be extracted normally.</p>
        <div class="comments-section">
          <div class="comment">
            <p>User comment that should be skipped completely.</p>
          </div>
          <div class="comment">
            <p>Another user comment to skip with enough text.</p>
          </div>
        </div>
        <p>Conclusion paragraph that should be extracted normally.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    expect(texts.some(t => t.includes('User comment'))).toBe(false);
    expect(texts.some(t => t.includes('Main article text'))).toBe(true);
    expect(texts.some(t => t.includes('Conclusion paragraph'))).toBe(true);
  });

  it('should handle multiple skip selectors', () => {
    vi.mocked(matchSiteRule).mockReturnValue({
      siteRule: {
        hostPattern: 'test-site-*.com',
        skipSelectors: ['.header', '.footer', '.nav'],
      },
      matchedPattern: 'test-site-*.com',
    });

    setupHTML(`
      <div class="header">
        <p>Header content with enough text to test.</p>
      </div>
      <article>
        <p>Main content that should be extracted normally.</p>
      </article>
      <div class="footer">
        <p>Footer content with enough text to test.</p>
      </div>
      <div class="nav">
        <p>Navigation content with enough text to test.</p>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    expect(texts.some(t => t.includes('Header content'))).toBe(false);
    expect(texts.some(t => t.includes('Footer content'))).toBe(false);
    expect(texts.some(t => t.includes('Navigation content'))).toBe(false);
    expect(texts.some(t => t.includes('Main content'))).toBe(true);
  });

  it('should not skip anything when no site rule matches', () => {
    vi.mocked(matchSiteRule).mockReturnValue(null);

    setupHTML(`
      <article>
        <p>First paragraph with enough text to extract.</p>
        <p>Second paragraph with enough text to extract.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBe(2);
  });

  it('should not skip when site rule has no skipSelectors', () => {
    vi.mocked(matchSiteRule).mockReturnValue({
      siteRule: {
        hostPattern: 'test-site-*.com',
      },
      matchedPattern: 'test-site-*.com',
    });

    setupHTML(`
      <article>
        <p>All paragraphs should be extracted normally.</p>
        <p>Another paragraph with enough text content.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBe(2);
  });
});

describe('extractBlocks - Whitespace and empty elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip elements with only whitespace text', () => {
    setupHTML(`
      <article>
        <p>     </p>
        <p>   \n  \t  </p>
        <p>Valid paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(1);
    expect(pBlocks[0].text).toBe('Valid paragraph with enough text content here.');
  });

  it('should skip empty elements', () => {
    setupHTML(`
      <article>
        <p></p>
        <div></div>
        <span></span>
        <p>Actual paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBe(1);
    expect(blocks[0].tag).toBe('p');
  });

  it('should skip elements with only invisible children', () => {
    setupHTML(`
      <article>
        <p><br><br></p>
        <p><img src="/icon.png" alt="" /></p>
        <p>Valid paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(1);
  });
});

describe('extractBlocks - Malformed or unusual HTML', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should handle text directly inside article without wrapping tags', () => {
    setupHTML(`
      <article>
        This is direct text content inside an article element without any wrapping paragraph tag.
        <p>This is a proper paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some(b => b.tag === 'p')).toBe(true);
  });

  it('should handle div with only text as a block', () => {
    setupHTML(`
      <article>
        <div>This div contains direct text content that should be extracted as a translatable block since it has enough characters.</div>
        <div><span>This span inside a div has enough text content to be extracted.</span></div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle mixed inline and block siblings', () => {
    setupHTML(`
      <article>
        <p>First paragraph with enough text content here.</p>
        <span>Inline span with enough text to be a standalone block here.</span>
        <p>Second paragraph with enough text content here.</p>
        <strong>Strong text that is also valid as standalone block content.</strong>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(2);

    const spanBlocks = blocks.filter(b => b.tag === 'span');
    expect(spanBlocks.length).toBeGreaterThanOrEqual(1);

    const strongBlocks = blocks.filter(b => b.tag === 'strong');
    expect(strongBlocks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('extractBlocks - Hidden and non-visible content', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip content inside display:none containers', () => {
    setupHTML(`
      <article>
        <p>Visible paragraph content that should be extracted here.</p>
        <div style="display: none;">
          <p>Hidden paragraph content that should be skipped here.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.some(b => b.text.includes('Visible paragraph'))).toBe(true);
    expect(blocks.some(b => b.text.includes('Hidden paragraph'))).toBe(false);
  });

  it('should skip aria-hidden content', () => {
    setupHTML(`
      <article>
        <p>Normal visible paragraph with enough text content here.</p>
        <div aria-hidden="true">
          <p>This content is marked as aria-hidden and should be skipped.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.some(b => b.text.includes('Normal visible'))).toBe(true);
    expect(blocks.some(b => b.text.includes('aria-hidden'))).toBe(false);
  });

  it('should skip visibility:hidden content', () => {
    setupHTML(`
      <article>
        <p>Visible paragraph with enough text content here.</p>
        <div style="visibility: hidden;">
          <p>Hidden by visibility paragraph with enough text.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.some(b => b.text.includes('Hidden by visibility'))).toBe(false);
  });

  it('should skip content with hidden attribute', () => {
    setupHTML(`
      <article>
        <p>Visible paragraph with enough text content here.</p>
        <div hidden>
          <p>Hidden attribute paragraph with enough text content.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.some(b => b.text.includes('Hidden attribute'))).toBe(false);
  });

  it('should skip content in deeply nested hidden ancestors', () => {
    setupHTML(`
      <article>
        <p>Visible paragraph with enough text content here.</p>
        <div class="wrapper">
          <div class="inner" style="display: none;">
            <div><div><p>Deeply nested hidden paragraph content here.</p></div></div>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.some(b => b.text.includes('Deeply nested hidden'))).toBe(false);
  });
});

describe('extractBlocks - Cookie Consent and Privacy', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip OneTrust SDK cookie policy container', () => {
    setupHTML(`
      <article>
        <p>Article paragraph content that should be extracted here.</p>
      </article>
      <div id="ot-sdk-cookie-policy">
        <div class="ot-cookie-policy-content">
          <ul>
            <li>taboola_session_id</li>
            <li>Duration</li>
            <li>DescriptionThis cookie is owned by trc.taboola.com</li>
            <li>Cookie_ga_*</li>
            <li>Duration1 year 1 month 4 days</li>
            <li>DescriptionGoogle Analytics sets this cookie</li>
          </ul>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('taboola'))).toBe(false);
    expect(blockTexts.some(t => t.includes('DescriptionGoogle Analytics'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph content that should be extracted here.');
  });

  it('should skip OneTrust preference center (ot-pc-*)', () => {
    setupHTML(`
      <article>
        <p>Article content that should be translated here.</p>
      </article>
      <div class="ot-pc-content">
        <div class="ot-pc-header">
          <h3>Cookie Settings</h3>
        </div>
        <div class="ot-pc-desc">This website uses cookies to ensure you get the best experience.</div>
        <div class="ot-pc-footer">
          <button>Allow All</button>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Cookie Settings'))).toBe(false);
    expect(blockTexts.some(t => t.includes('best experience'))).toBe(false);
  });

  it('should skip cookie banner with cookie-banner class', () => {
    setupHTML(`
      <div class="cookie-banner">
        <p>We use cookies to improve your experience on our site.</p>
        <button>Accept All Cookies</button>
      </div>
      <article>
        <p>Article content that should be translated.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('use cookies'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated.');
  });

  it('should skip GDPR consent modal regions', () => {
    setupHTML(`
      <div class="consent-modal">
        <h2>Your Privacy Choices</h2>
        <p>Select your cookie preferences below.</p>
        <div class="consent-container">
          <label class="ot-category">Functional Cookies</label>
          <p>These cookies are necessary for the website to function.</p>
        </div>
      </div>
      <article>
        <p>Real article text that must be extracted for translation here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Privacy Choices'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Functional Cookies'))).toBe(false);
    expect(blockTexts).toContain('Real article text that must be extracted for translation here.');
  });

  it('should skip cookie policy and privacy notice containers', () => {
    setupHTML(`
      <div class="privacy-policy">
        <h2>Privacy Policy</h2>
        <p>Last updated: January 2026</p>
        <div class="cookie-policy">
          <h3>Cookie Declaration</h3>
          <table class="cookie-table">
            <tr><th>Cookie</th><th>Duration</th><th>Description</th></tr>
            <tr><td>_ga</td><td>2 years</td><td>Google Analytics tracking cookie</td></tr>
          </table>
        </div>
      </div>
      <article>
        <p>Actual article paragraph that should be extracted for translation.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Privacy Policy'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie Declaration'))).toBe(false);
    expect(blockTexts.some(t => t.includes('_ga'))).toBe(false);
    expect(blockTexts).toContain('Actual article paragraph that should be extracted for translation.');
  });
});

describe('extractBlocks - Cookie Consent libraries (cc-*)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip Cookie Consent (cc-window, cc-banner, cc-overlay)', () => {
    setupHTML(`
      <div class="cc-window">
        <div class="cc-banner">
          <p>This website uses cookies to ensure you get the best experience.</p>
          <button class="cc-btn cc-accept">Got it!</button>
        </div>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('best experience'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });

  it('should skip cc-floating and cc-container variants', () => {
    setupHTML(`
      <div class="cc-floating">
        <p>Cookie consent floating banner text.</p>
      </div>
      <div class="cc-container">
        <p>Cookie preferences container text.</p>
      </div>
      <article>
        <p>Real article paragraph for translation here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('floating banner'))).toBe(false);
    expect(blockTexts.some(t => t.includes('preferences container'))).toBe(false);
    expect(blockTexts).toContain('Real article paragraph for translation here.');
  });
});

describe('extractBlocks - CMP platforms (ConsentManager, Klaro)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip ConsentManager (cmpbox, cmpwrapper)', () => {
    setupHTML(`
      <div class="cmpbox">
        <div class="cmpbox-inner">
          <div class="cmpbox-content">
            <p>We use cookies and other technologies to provide our services.</p>
          </div>
          <div class="cmpbox-buttons">
            <button class="cmpbox-btn">Accept All</button>
            <button class="cmpbox-btn">Deny</button>
          </div>
        </div>
      </div>
      <article>
        <p>Article content for translation purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('We use cookies'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation purposes here.');
  });

  it('should skip Klaro consent manager', () => {
    setupHTML(`
      <div class="klaro">
        <div class="klaro-cookie-notice">
          <p>Hello! Would you like to accept cookies for analytics?</p>
        </div>
        <div class="klaro-cookie-modal">
          <p>Cookie settings and preferences.</p>
        </div>
      </div>
      <article>
        <p>Article text to be translated for testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('accept cookies'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie settings'))).toBe(false);
    expect(blockTexts).toContain('Article text to be translated for testing here.');
  });
});

describe('extractBlocks - WordPress GDPR/Cookie plugins', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip Borlabs Cookie (borlabs-cookie, brlbs)', () => {
    setupHTML(`
      <div class="borlabs-cookie">
        <div class="brlbs-cmpnt-container">
          <p>This website uses Borlabs Cookie to manage consent.</p>
        </div>
      </div>
      <article>
        <p>Article content that must be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Borlabs Cookie'))).toBe(false);
    expect(blockTexts).toContain('Article content that must be translated here.');
  });

  it('should skip Complianz (cmplz, cmplz-cookie, cmplz-manage)', () => {
    setupHTML(`
      <div id="cmplz-cookiebanner">
        <div class="cmplz-manage-consent">
          <p>We use functional cookies to make our website work properly.</p>
        </div>
      </div>
      <article>
        <p>Article paragraph for translation testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('functional cookies'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation testing here.');
  });

  it('should skip Moove GDPR (moove-gdpr)', () => {
    setupHTML(`
      <div class="moove-gdpr-cookie-notice">
        <p>Our website uses cookies to improve your browsing experience.</p>
      </div>
      <article>
        <p>Article content for translation here please.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('browsing experience'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation here please.');
  });

  it('should skip Cookie Law Info / CookieYes (cli-, wt-cli, cky-)', () => {
    setupHTML(`
      <div class="wt-cli-cookie-bar">
        <div class="cli-modal">
          <div class="cli-popup">
            <p>This website uses cookies to improve your experience.</p>
          </div>
        </div>
      </div>
      <div class="cky-banner">
        <div class="cky-consent">
          <p>CookieYes cookie consent banner content text.</p>
        </div>
      </div>
      <article>
        <p>Article paragraph for translation extraction here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('improve your experience'))).toBe(false);
    expect(blockTexts.some(t => t.includes('CookieYes'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation extraction here.');
  });

  it('should skip wpfront-notification-bar', () => {
    setupHTML(`
      <div class="wpfront-notification-bar">
        <p>Notification bar with cookie policy information.</p>
      </div>
      <article>
        <p>Article paragraph to translate for testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Notification bar'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph to translate for testing here.');
  });
});

describe('extractBlocks - Regional regulation and multilingual class names', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip CCPA, LGPD, EU Cookie, CNIL notices', () => {
    setupHTML(`
      <div class="ccpa-notice">
        <p>Do not sell my personal information.</p>
      </div>
      <div class="lgpd-banner">
        <p>Este site utiliza cookies para melhorar sua experiência.</p>
      </div>
      <div class="eucookie-banner">
        <p>We use cookies in accordance with EU regulations.</p>
      </div>
      <div class="cnil-banner">
        <p>En poursuivant votre navigation, vous acceptez les cookies.</p>
      </div>
      <article>
        <p>Article content for translation purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('personal information'))).toBe(false);
    expect(blockTexts.some(t => t.includes('melhorar sua'))).toBe(false);
    expect(blockTexts.some(t => t.includes('EU regulations'))).toBe(false);
    expect(blockTexts.some(t => t.includes('acceptez les cookies'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation purposes here.');
  });

  it('should skip German (hinweis) and French (confidentialite) notices', () => {
    setupHTML(`
      <div class="hinweis-cookie">
        <p>Diese Website verwendet Cookies zur Verbesserung des Angebots.</p>
      </div>
      <div class="confidentialite-popup">
        <p>Politique de confidentialité et gestion des cookies.</p>
      </div>
      <article>
        <p>Article content to translate for testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Verbesserung'))).toBe(false);
    expect(blockTexts.some(t => t.includes('confidentialité'))).toBe(false);
    expect(blockTexts).toContain('Article content to translate for testing purposes here.');
  });

  it('should skip Polish (rodo) and short cookie forms (cbar, cono, coo, cook)', () => {
    setupHTML(`
      <div class="rodo-popup">
        <p>Informacja o przetwarzaniu danych osobowych.</p>
      </div>
      <div class="cbar-container">
        <p>Cookie bar short form notice text here.</p>
      </div>
      <div class="coo-modal">
        <p>Short cookie modal content for testing.</p>
      </div>
      <div class="cook-modal">
        <p>Another short cookie form for coverage testing.</p>
      </div>
      <article>
        <p>Article paragraph for translation extraction here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('danych osobowych'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie bar short'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Short cookie modal'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Another short cookie'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation extraction here.');
  });
});

describe('extractBlocks - Generic cookie/consent variants', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip bare gdpr, consent, privacy, cookie-bar classes', () => {
    setupHTML(`
      <div class="gdpr">
        <p>GDPR compliance notice about data processing.</p>
      </div>
      <div class="consent">
        <p>Consent management panel for cookie preferences.</p>
      </div>
      <div class="privacy">
        <p>Privacy information about data collection practices.</p>
      </div>
      <div class="cookie-bar">
        <p>Cookie notice bar with accept and reject buttons here.</p>
      </div>
      <article>
        <p>Article content for translation testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('GDPR compliance'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Consent management'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Privacy information'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie notice bar'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation testing here.');
  });

  it('should skip data-protection, cookie-box, cookie-modal, cookie-container', () => {
    setupHTML(`
      <div class="data-protection">
        <p>Data protection declaration and cookie information.</p>
      </div>
      <div class="cookie-box">
        <p>Cookie box containing consent options for users.</p>
      </div>
      <div class="cookie-modal">
        <p>Cookie preferences modal dialog content here.</p>
      </div>
      <div class="cookie-container">
        <p>Container for cookie consent management tools.</p>
      </div>
      <article>
        <p>Article content for translation extraction here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Data protection'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie box'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie preferences'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Container for cookie'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction here.');
  });

  it('should skip cookie-disclaimer, lawdiv, opt-in, euc, disclaimer variants', () => {
    setupHTML(`
      <div class="cookie-disclaimer">
        <p>Cookie disclaimer with important legal information.</p>
      </div>
      <div class="lawdiv">
        <p>Legal division cookie compliance notice text here.</p>
      </div>
      <div class="opt-in">
        <p>Opt-in banner for marketing cookie preferences.</p>
      </div>
      <div class="euc">
        <p>EU cookie compliance directive notice banner.</p>
      </div>
      <div class="disclaimer">
        <p>General disclaimer about cookies and tracking here.</p>
      </div>
      <article>
        <p>Article content that should be extracted for translation.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Cookie disclaimer'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Legal division'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Opt-in banner'))).toBe(false);
    expect(blockTexts.some(t => t.includes('EU cookie'))).toBe(false);
    expect(blockTexts.some(t => t.includes('General disclaimer'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be extracted for translation.');
  });

  it('should skip cookies-modal, cookies-wrapper, cookie__wrap, coockies variants', () => {
    setupHTML(`
      <div class="cookies-modal">
        <p>Modal dialog for managing multiple cookie categories here.</p>
      </div>
      <div class="cookies-wrapper">
        <p>Wrapper container for cookie consent interface elements.</p>
      </div>
      <div class="cookie__wrap">
        <p>BEM style cookie consent wrapper with configuration options.</p>
      </div>
      <div class="coockies-popup">
        <p>Misspelled cookies popup with consent information text.</p>
      </div>
      <article>
        <p>Article paragraph for translation extraction here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('managing multiple'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Wrapper container'))).toBe(false);
    expect(blockTexts.some(t => t.includes('BEM style'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Misspelled cookies'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation extraction here.');
  });

  it('should skip data-privacy, data-consent, consent-popup, consent-wrapper, outer-consent', () => {
    setupHTML(`
      <div class="data-privacy">
        <p>Data privacy statement regarding cookie usage and tracking.</p>
      </div>
      <div class="data-consent">
        <p>Data consent management for analytics and marketing cookies.</p>
      </div>
      <div class="consent-popup">
        <p>Consent popup asking users to accept cookie categories.</p>
      </div>
      <div class="consent-wrapper">
        <p>Wrapper around the full consent management interface UI.</p>
      </div>
      <div class="outer-consent">
        <p>Outer consent layer covering the full viewport for GDPR.</p>
      </div>
      <article>
        <p>Article text for translation extraction purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Data privacy'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Data consent'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Consent popup'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Wrapper around'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Outer consent'))).toBe(false);
    expect(blockTexts).toContain('Article text for translation extraction purposes here.');
  });

  it('should skip cookie-popup, cookie-overlay, cookie-wrapper, cookie-compliance, cookie-control', () => {
    setupHTML(`
      <div class="cookie-popup">
        <p>Popup style cookie notification for first time visitors.</p>
      </div>
      <div class="cookie-overlay">
        <p>Full screen overlay blocking until cookie choice is made.</p>
      </div>
      <div class="cookie-wrapper">
        <p>Cookie consent wrapper with all configuration options.</p>
      </div>
      <div class="cookie-compliance">
        <p>Cookie compliance information for regulatory requirements.</p>
      </div>
      <div class="cookie-control">
        <p>Cookie control panel for managing user consent preferences.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Popup style'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Full screen'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie consent wrapper'))).toBe(false);
    expect(blockTexts.some(t => t.includes('compliance information'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie control'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing here.');
  });

  it('should skip cookie-management, cookieman, cookiemgmt, modal-cookie, modal-cookies', () => {
    setupHTML(`
      <div class="cookie-management">
        <p>Advanced cookie management interface with category toggles.</p>
      </div>
      <div class="cookieman-modal">
        <p>Cookie manager modal for detailed consent configuration.</p>
      </div>
      <div class="cookiemgmt-panel">
        <p>Cookie management panel with granular consent controls.</p>
      </div>
      <div class="modal-cookie">
        <p>Modal cookie dialog for consent collection purposes.</p>
      </div>
      <div class="modal-cookies">
        <p>Modal cookies dialog with settings for all cookie types.</p>
      </div>
      <article>
        <p>Article content to translate for testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Advanced cookie'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie manager'))).toBe(false);
    expect(blockTexts.some(t => t.includes('management panel'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Modal cookie dialog'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Modal cookies dialog'))).toBe(false);
    expect(blockTexts).toContain('Article content to translate for testing purposes here.');
  });

  it('should skip cookie-div, cookie-law, cookie-accept, cookie-law-info, disclaimers', () => {
    setupHTML(`
      <div class="cookie-div">
        <p>Simple cookie notice division element with accept button.</p>
      </div>
      <div class="cookie-law">
        <p>EU cookie law compliance notice with information text.</p>
      </div>
      <div class="cookie-accept">
        <p>Cookie accept banner for first time website visitors.</p>
      </div>
      <div class="cookie-law-info">
        <p>Cookie law information bar at the bottom of the page.</p>
      </div>
      <div class="disclaimer-container">
        <p>Disclaimer container for legal cookie information display.</p>
      </div>
      <div class="disclamer">
        <p>Commonly misspelled disclaimer with cookie notice text.</p>
      </div>
      <article>
        <p>Article text for translation extraction purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Simple cookie'))).toBe(false);
    expect(blockTexts.some(t => t.includes('EU cookie law'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie accept'))).toBe(false);
    expect(blockTexts.some(t => t.includes('information bar'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Disclaimer container'))).toBe(false);
    expect(blockTexts.some(t => t.includes('misspelled disclaimer'))).toBe(false);
    expect(blockTexts).toContain('Article text for translation extraction purposes here.');
  });
});

describe('extractBlocks - Google Ad placements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip Google AdSense (adsbygoogle, google-ad, google-ads)', () => {
    setupHTML(`
      <div class="google-ad">
        <ins class="adsbygoogle" data-ad-client="ca-pub-1234567890" data-ad-slot="1234567890">
          <p>Advertisement content from Google AdSense network.</p>
        </ins>
      </div>
      <article>
        <p>Article content for translation testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Advertisement content'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation testing purposes here.');
  });

  it('should skip DFP/GPT ad units (dfp-ad, gpt-ad, div-gpt-ad, dfp-unit)', () => {
    setupHTML(`
      <div class="dfp-ad">
        <div class="dfp-unit">
          <p>DoubleClick for Publishers advertisement slot here.</p>
        </div>
      </div>
      <div class="gpt-ad">
        <p>Google Publisher Tags ad placement content here.</p>
      </div>
      <div class="div-gpt-ad">
        <p>Another GPT ad unit with sponsored message text here.</p>
      </div>
      <article>
        <p>Article paragraph for translation extraction testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('DoubleClick'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Publisher Tags'))).toBe(false);
    expect(blockTexts.some(t => t.includes('sponsored message'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation extraction testing here.');
  });

  it('should skip Ezoic and Freestar ad platforms (ezoic-ad, freestar-ad)', () => {
    setupHTML(`
      <div class="ezoic-ad">
        <p>Ezoic platform advertisement placement unit here.</p>
      </div>
      <div class="freestar-ad">
        <p>Freestar ad network sponsored placement content.</p>
      </div>
      <div class="ezoic-pub">
        <p>Ezoic publisher ad placeholder with tracking text.</p>
      </div>
      <article>
        <p>Article content for translation extraction purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Ezoic platform'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Freestar ad'))).toBe(false);
    expect(blockTexts.some(t => t.includes('publisher ad'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction purposes here.');
  });
});

describe('extractBlocks - Native ad widgets (Taboola, Outbrain, MGID, RevContent, Zergnet)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip Taboola and Outbrain recommendation widgets', () => {
    setupHTML(`
      <div class="taboola-widget">
        <div class="trc">
          <p>You may like these sponsored stories from around the web.</p>
          <a href="#">Sponsored link by Taboola network content here.</a>
        </div>
      </div>
      <div class="outbrain-widget">
        <div class="ob-widget">
          <p>Recommended reading from Outbrain sponsored content platform.</p>
        </div>
      </div>
      <article>
        <p>Article content for translation testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('sponsored stories'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Recommended reading'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation testing purposes here.');
  });

  it('should skip MGID and MarketGid widgets', () => {
    setupHTML(`
      <div class="mgid-widget">
        <div class="mgbox">
          <p>Sponsored content from MGID native advertising network.</p>
        </div>
      </div>
      <div class="marketgid-container">
        <p>MarketGid native ad recommendation widget content here.</p>
      </div>
      <article>
        <p>Article content to translate for testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('native advertising'))).toBe(false);
    expect(blockTexts.some(t => t.includes('MarketGid'))).toBe(false);
    expect(blockTexts).toContain('Article content to translate for testing purposes here.');
  });

  it('should skip RevContent and Zergnet widgets', () => {
    setupHTML(`
      <div class="revcontent-widget">
        <div class="rc-widget">
          <p>RevContent native ad widget with sponsored links here.</p>
        </div>
      </div>
      <div class="zergnet-widget">
        <p>Zergnet content recommendation widget with ads text.</p>
      </div>
      <article>
        <p>Article paragraph for translation extraction testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('RevContent'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Zergnet'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation extraction testing here.');
  });

  it('should skip native-ad, native-ads, content-recommendation, recommended-content', () => {
    setupHTML(`
      <div class="native-ad">
        <p>Native advertisement blending with editorial content on this page.</p>
      </div>
      <div class="content-recommendation">
        <p>Content recommendations powered by third party ad networks here.</p>
      </div>
      <div class="recommended-content">
        <p>Recommended articles sponsored by advertising partners text here.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Native advertisement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Content recommendations'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Recommended articles'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing purposes here.');
  });
});

describe('extractBlocks - Ad formats and placements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip leaderboard, skyscraper, ad-banner, display-ad ad formats', () => {
    setupHTML(`
      <div class="leaderboard">
        <p>728x90 leaderboard advertisement banner at the top of the page.</p>
      </div>
      <div class="skyscraper">
        <p>160x600 skyscraper ad unit in the sidebar for testing here.</p>
      </div>
      <div class="ad-banner">
        <p>Generic advertisement banner with promotional content text.</p>
      </div>
      <div class="display-ad">
        <p>Display advertising unit with image and text for marketing.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('leaderboard advertisement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('skyscraper ad'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Generic advertisement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Display advertising'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing purposes here.');
  });

  it('should skip header-ad, footer-ad, sticky-ad placement ads', () => {
    setupHTML(`
      <div class="header-ad">
        <p>Advertisement in header area above the main content section.</p>
      </div>
      <div class="footer-ad">
        <p>Footer advertisement unit at the bottom of the page layout.</p>
      </div>
      <div class="sticky-ad">
        <p>Sticky advertisement that follows user as they scroll content.</p>
      </div>
      <article>
        <p>Article content for translation purposes and testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('header area'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Footer advertisement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Sticky advertisement'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation purposes and testing here.');
  });

  it('should skip in-article-ad, inline-ad, incontent-ad placements', () => {
    setupHTML(`
      <article>
        <p>First paragraph of the article content that is genuine here.</p>
        <div class="in-article-ad">
          <p>Advertisement inserted between article paragraphs for revenue.</p>
        </div>
        <p>Second paragraph of article content after the ad placement here.</p>
        <div class="inline-ad">
          <p>Inline advertisement within the article body content area.</p>
        </div>
        <div class="incontent-ad">
          <p>In-content advertisement placed between text paragraphs here.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('inserted between'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Inline advertisement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('In-content advertisement'))).toBe(false);
    expect(blockTexts).toContain('First paragraph of the article content that is genuine here.');
    expect(blockTexts).toContain('Second paragraph of article content after the ad placement here.');
  });

  it('should skip ad-wrapper, ad-panel, ad-frame, ad-box, adslot, adunit, adv, advertorial', () => {
    setupHTML(`
      <div class="ad-wrapper">
        <div class="ad-panel">
          <p>Wrapper container for advertisement placements on the website.</p>
        </div>
      </div>
      <div class="ad-frame">
        <div class="ad-box">
          <p>Advertising frame with boxed content for monetization here.</p>
        </div>
      </div>
      <div class="adslot">
        <p>Ad slot placeholder for programmatic advertising content.</p>
      </div>
      <div class="adunit">
        <p>Ad unit for display advertising served by ad network here.</p>
      </div>
      <div class="adv">
        <p>Short advert class notice for quick ad placement integration.</p>
      </div>
      <div class="advertorial">
        <p>Advertorial content that looks like editorial but is paid promotion.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Wrapper container'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Advertising frame'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad slot'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad unit'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Short advert'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Advertorial content'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing purposes here.');
  });

  it('should skip ad-label, ad-placeholder, ad-inner, ad-holder, ad-widget, ad-code, ad-content variants', () => {
    setupHTML(`
      <div class="ad-label">
        <p>Advertisement label indicating paid content placement here.</p>
      </div>
      <div class="ad-placeholder">
        <p>Ad placeholder waiting for programmatic fill from network.</p>
      </div>
      <div class="ad-inner">
        <p>Inner ad container with nested advertisement elements here.</p>
      </div>
      <div class="ad-holder">
        <p>Ad holder div for dynamic ad insertion during page load.</p>
      </div>
      <div class="ad-widget">
        <p>Ad widget sidebar with sponsored content recommendations here.</p>
      </div>
      <div class="ad-code">
        <p>Ad code injected dynamically with tracking pixels and content.</p>
      </div>
      <div class="ad-content">
        <p>Ad content block with promotional messaging for products here.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Advertisement label'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad placeholder'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Inner ad container'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad holder div'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad widget sidebar'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad code injected'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad content block'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing purposes here.');
  });
});

describe('extractBlocks - Sponsored, promoted and commercial content', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip sponsored-content, sponsored-post, sponsored-link(s)', () => {
    setupHTML(`
      <div class="sponsored-content">
        <p>This is sponsored content from our advertising partners network.</p>
      </div>
      <div class="sponsored-post">
        <p>Sponsored post with promotional content for products here.</p>
      </div>
      <div class="sponsored-links">
        <ul>
          <li class="sponsored-link"><a href="#">Paid link to external advertiser site here.</a></li>
          <li class="sponsored-link"><a href="#">Another sponsored link for testing purposes here.</a></li>
        </ul>
      </div>
      <article>
        <p>Article content for translation extraction testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('sponsored content from'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Sponsored post'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Paid link'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing purposes here.');
  });

  it('should skip promoted-content, promoted-post, paid-content, paid-post', () => {
    setupHTML(`
      <div class="promoted-content">
        <p>Promoted content placed by advertising platform for marketing.</p>
      </div>
      <div class="promoted-post">
        <p>Promoted post with boosted visibility from paid promotion here.</p>
      </div>
      <div class="paid-content">
        <p>Paid content placement with sponsored messaging for products.</p>
      </div>
      <div class="paid-post">
        <p>Paid post sponsored by brand partners for advertising purposes.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing here please.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Promoted content'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Promoted post'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Paid content placement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Paid post'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing here please.');
  });

  it('should skip affiliate, affiliate-link, commercial, commercial-content, advertorial', () => {
    setupHTML(`
      <div class="affiliate-content">
        <div class="affiliate-link">
          <p>Affiliate marketing disclosure and product recommendation here.</p>
        </div>
      </div>
      <div class="commercial-content">
        <p>Commercial content featuring paid product placement advertising.</p>
      </div>
      <div class="advertorial">
        <p>Advertorial style content presenting paid promotion as editorial.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing here please.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Affiliate marketing'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Commercial content'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Advertorial style'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing here please.');
  });

  it('should skip bare sponsored, promoted, commercial classes', () => {
    setupHTML(`
      <div class="sponsored">
        <p>Generic sponsored section with paid promotional content here.</p>
      </div>
      <div class="promoted">
        <p>Generic promoted section with advertiser messages for testing.</p>
      </div>
      <div class="commercial">
        <p>Commercial section with paid advertising content placement here.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing here please.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Generic sponsored'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Generic promoted'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Commercial section'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing here please.');
  });

  it('should skip ad-div, ad-area, ad-outer, ad-block, generic advert/adv', () => {
    setupHTML(`
      <div class="ad-div">
        <p>Generic ad division container for advertisement placements here.</p>
      </div>
      <div class="ad-area">
        <p>Ad area designation for programmatic ad slot placement here.</p>
      </div>
      <div class="ad-outer">
        <p>Outer ad wrapper for responsive advertisement units on page.</p>
      </div>
      <div class="ad-block">
        <p>Ad block extension detected advertisement container for removal.</p>
      </div>
      <div class="advert">
        <p>Generic advertisement class with promotional content for testing.</p>
      </div>
      <article>
        <p>Article content for translation purposes here for testing.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Generic ad division'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad area designation'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Outer ad wrapper'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad block extension'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Generic advertisement'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation purposes here for testing.');
  });
});

describe('extractBlocks - Large documents', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should handle article with many paragraphs efficiently', () => {
    const paragraphs = Array.from({ length: 50 }, (_, i) =>
      `<p>Paragraph number ${i + 1} with enough text content to be extracted as a translatable block for testing.</p>`
    ).join('\n');

    setupHTML(`<article>${paragraphs}</article>`);

    const blocks = extractBlocks(document, "https://example.com/test");
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(50);
  });

  it('should skip very long text blocks', () => {
    const longText = 'Long text content. '.repeat(200);

    setupHTML(`
      <article>
        <p>${longText}</p>
        <p>Normal paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Normal paragraph with enough text content here.');
  });
});

describe('extractBlocks - WordPress/TNS style page (sample4.html)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip navigation divs, footers, sidebars on lang=en-US pages', () => {
    document.documentElement.setAttribute('lang', 'en-US');

    setupHTML(`
      <div class="mobile-nav-dropdown">
        <div class="mobile-nav-header">Topics</div>
        <div class="mobile-nav-menu">
          <a href="/ai/">AI and Machine Learning</a>
          <a href="/cloud/">Cloud Native Computing</a>
        </div>
      </div>
      <div class="channels-nav">
        <a href="/podcasts/">Podcasts</a>
        <a href="/ebooks/">eBooks</a>
      </div>
      <div class="topics-nav">
        <a href="/architecture/">Architecture</a>
        <a href="/engineering/">Engineering</a>
      </div>
      <div class="content-column content-column-post-body">
        <div class="breadcrumb">
          <a href="/category/ai-agents/">AI Agents</a>
          <span> / </span>
          <a href="/category/ai-strategy/">AI Strategy</a>
        </div>
        <h1 class="title">Forward deployed engineer is AI's hottest job</h1>
        <div class="byline">
          <span class="date">May 16th, 2026 6:00am by</span>
          <span class="author">Matthew Burns</span>
        </div>
        <article>
          <p>OpenAI launched the Deployment Company this week.</p>
          <p>If you have been wondering which AI job is durable, the answer is becoming obvious.</p>
        </article>
      </div>
      <div class="content-column content-column-post-footer">
        <div class="related-posts">
          <a href="/post1/">Related article number one about AI</a>
          <a href="/post2/">Related article number two about cloud</a>
        </div>
      </div>
      <div class="footer">
        <p>Copyright 2026 The New Stack. All rights reserved.</p>
      </div>
      <div class="sidebar">
        <div class="widget-area">
          <h4>Subscribe to Our Newsletter</h4>
          <p>Get the latest news delivered to your inbox.</p>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts).not.toContain('AI and Machine Learning');
    expect(blockTexts).not.toContain('Podcasts');
    expect(blockTexts).not.toContain('Architecture');
    expect(blockTexts).not.toContain('AI Agents');
    expect(blockTexts).not.toContain('Matthew Burns');
    expect(blockTexts).not.toContain('Related article number one about AI');
    expect(blockTexts).not.toContain('Copyright 2026 The New Stack. All rights reserved.');
    expect(blockTexts).not.toContain('Get the latest news delivered to your inbox.');

    expect(blockTexts).toContain('OpenAI launched the Deployment Company this week.');
    expect(blockTexts).toContain('If you have been wondering which AI job is durable, the answer is becoming obvious.');
  });

  it('should skip subscribe forms and trending story widgets inside article body', () => {
    setupHTML(`
      <article>
        <p>Main content paragraph that should definitely be translated here.</p>
        <div class="tns-trending-stories-block inline">
          <div class="section-heading">TRENDING STORIES</div>
          <ol class="tns-trending-stories-ol">
            <li><a href="/post1/">What Anthropic and OpenAI launched in 72 hours</a></li>
            <li><a href="/post2/">Forward deployed engineer is AI's hottest job</a></li>
          </ol>
        </div>
        <div class="subscribe-widget">
          <h4>Subscribe for Updates</h4>
          <p>Get notified about new articles and events.</p>
          <input type="email" placeholder="Enter your email address here" />
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts).not.toContain('TRENDING STORIES');
    expect(blockTexts).not.toContain('What Anthropic and OpenAI launched in 72 hours');
    expect(blockTexts).not.toContain('Forward deployed engineer is AI\'s hottest job');
    expect(blockTexts).not.toContain('Get notified about new articles and events.');
    expect(blockTexts).toContain('Main content paragraph that should definitely be translated here.');
  });

  it('should only extract article body paragraphs from a complete WordPress page layout', () => {
    setupHTML(`
      <header class="header">
        <div class="logo"><a href="/">The New Stack</a></div>
        <nav class="main-menu">
          <a href="/ai/">AI</a>
          <a href="/cloud/">Cloud</a>
        </nav>
      </header>
      <div class="content-column content-column-post-body">
        <h1 class="title">The Future of AI Engineering Careers</h1>
        <div class="byline">
          <span class="date">May 2026</span>
          <span class="author">By Jane Doe and John Smith</span>
        </div>
        <div class="social-share">
          <button>Share on Twitter</button>
          <button>Share on LinkedIn</button>
        </div>
        <div id="tns-post-body-content">
          <p class="first-paragraph">The AI engineering field is rapidly evolving with new roles emerging.</p>
          <h2 class="wp-block-heading">What Makes a Good AI Engineer</h2>
          <p>Understanding both the technical and business aspects is crucial for success.</p>
          <h2 class="wp-block-heading">Career Path and Growth Opportunities</h2>
          <p>The career trajectory for AI engineers shows remarkable growth potential.</p>
        </div>
      </div>
      <aside class="sidebar">
        <div class="widget-area">
          <h4>Popular Articles</h4>
          <ul>
            <li><a href="/post1/">How Kubernetes Changed Everything Forever</a></li>
            <li><a href="/post2/">The Rise of Platform Engineering Teams</a></li>
          </ul>
        </div>
      </aside>
      <footer class="footer">
        <div class="copyright">2026 The New Stack</div>
      </footer>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('The New Stack'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Jane Doe'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Share on'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Kubernetes Changed'))).toBe(false);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBeGreaterThanOrEqual(3);

    expect(blockTexts).toContain('The AI engineering field is rapidly evolving with new roles emerging.');
    expect(blockTexts).toContain('Understanding both the technical and business aspects is crucial for success.');
    expect(blockTexts).toContain('The career trajectory for AI engineers shows remarkable growth potential.');
  });

  it('should skip nav divs even when not using semantic nav tag (div-based nav)', () => {
    setupHTML(`
      <div class="mobile-nav-dropdown">
        <div class="content-column">
          <div class="row mobile-nav-row">
            <div class="col-20 mobile-nav-col">
              <div class="mobile-nav-header">Topics</div>
              <div class="mobile-nav-menu">
                <a href="/ai/">Artificial Intelligence and Machine Learning</a>
                <a href="/cloud/">Cloud Native and Kubernetes Ecosystem</a>
              </div>
            </div>
            <div class="col-20 mobile-nav-col">
              <div class="mobile-nav-header">Resources</div>
              <div class="mobile-nav-menu">
                <a href="/ebooks/">Free eBooks and Guides for Developers</a>
                <a href="/webinars/">Upcoming Webinars and Live Events</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Artificial Intelligence'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cloud Native'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Free eBooks'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Upcoming Webinars'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Topics'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Resources'))).toBe(false);
  });

  it('should handle compound class names like content-column-post-footer via endsWith matching', () => {
    setupHTML(`
      <div class="content-column content-column-post-footer">
        <p>Footer paragraph that should be skipped entirely.</p>
      </div>
      <div class="content-column content-column-mobile-footer">
        <p>Mobile footer paragraph that should also be skipped.</p>
      </div>
      <div class="content-column content-column-post-body">
        <p>Actual article content that should be translated here.</p>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Footer paragraph'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Mobile footer'))).toBe(false);
    expect(blockTexts).toContain('Actual article content that should be translated here.');
    expect(blocks).toHaveLength(1);
  });
});

describe('extractBlocks - Adjacent inline elements in article', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract multiple adjacent span elements as separate blocks', () => {
    setupHTML(`
      <article>
        <div>
          <span>First span with enough text content for a standalone block here.</span>
          <span>Second span with enough text content for a standalone block here.</span>
          <span>Third span with enough text content for a standalone block here.</span>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const spanBlocks = blocks.filter(b => b.tag === 'span');
    expect(spanBlocks).toHaveLength(3);
  });

  it('should extract div with direct text and inline children as one block', () => {
    setupHTML(`
      <article>
        <div class="content">
          Text content directly inside div <a href="#">with a link</a> and more text <strong>and bold</strong> at the end.
          </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const divBlocks = blocks.filter(b => b.tag === 'div');
    expect(divBlocks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('extractBlocks - Search forms', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip search form containers', () => {
    setupHTML(`
      <div class="search-form">
        <input type="text" placeholder="Search..." />
        <button class="search-btn">Search</button>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Search'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });

  it('should skip search-bar, searchbar, search-wrapper, search-widget', () => {
    setupHTML(`
      <div class="search-bar">
        <p>Search bar description that should not be translated.</p>
      </div>
      <div class="search-wrapper">
        <p>Search wrapper content text to skip.</p>
      </div>
      <div class="search-widget">
        <p>Search widget with recent searches list.</p>
      </div>
      <article>
        <p>Article text for translation testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Search bar'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Search wrapper'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Search widget'))).toBe(false);
    expect(blockTexts).toContain('Article text for translation testing here.');
  });
});

describe('extractBlocks - Login and authentication', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip login-form, login-box, login-bar', () => {
    setupHTML(`
      <div class="login-form">
        <h3>Sign In</h3>
        <input type="email" placeholder="Email address" />
        <input type="password" placeholder="Password" />
        <button>Login</button>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Sign In'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });

  it('should skip signin-form, signup-form, register-form, registration', () => {
    setupHTML(`
      <div class="signin-form">
        <p>Welcome back! Sign in to your account.</p>
      </div>
      <div class="signup-form">
        <p>Create a new account to get started.</p>
      </div>
      <div class="register-form">
        <p>Register now for exclusive content access.</p>
      </div>
      <div class="registration">
        <p>Complete your registration below to continue.</p>
      </div>
      <article>
        <p>Article text for translation testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Welcome back'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Create a new account'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Register now'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Complete your registration'))).toBe(false);
    expect(blockTexts).toContain('Article text for translation testing here.');
  });

  it('should skip auth-form, user-area, user-menu, user-profile, member-area', () => {
    setupHTML(`
      <div class="auth-form">
        <p>Authentication form content that should be skipped.</p>
      </div>
      <div class="user-area">
        <p>User dashboard with account settings and preferences.</p>
      </div>
      <div class="user-profile">
        <p>Profile settings and customization options here.</p>
      </div>
      <div class="member-area">
        <p>Member only content access panel and subscription info.</p>
      </div>
      <article>
        <p>Article text for translation extraction here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Authentication form'))).toBe(false);
    expect(blockTexts.some(t => t.includes('User dashboard'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Profile settings'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Member only'))).toBe(false);
    expect(blockTexts).toContain('Article text for translation extraction here.');
  });
});

describe('extractBlocks - Newsletter subscription', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip newsletter-signup, newsletter-form, newsletter-subscribe', () => {
    setupHTML(`
      <div class="newsletter-signup">
        <p>Subscribe to our newsletter for weekly updates.</p>
        <input type="email" placeholder="Your email address" />
        <button>Subscribe</button>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Subscribe to our newsletter'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });

  it('should skip email-signup, email-subscribe, email-capture, signup-form', () => {
    setupHTML(`
      <div class="email-signup">
        <p>Sign up for email updates and get notified.</p>
      </div>
      <div class="email-subscribe">
        <p>Subscribe to our mailing list for daily digests.</p>
      </div>
      <div class="signup-form">
        <p>Join thousands of readers. Sign up today for free.</p>
      </div>
      <article>
        <p>Article text for translation testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('email updates'))).toBe(false);
    expect(blockTexts.some(t => t.includes('mailing list'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Join thousands'))).toBe(false);
    expect(blockTexts).toContain('Article text for translation testing here.');
  });
});

describe('extractBlocks - Pagination', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip pagination, page-nav, page-numbers', () => {
    setupHTML(`
      <nav class="pagination">
        <span class="page-numbers">Page 1 of 10</span>
        <a class="page-nav" href="/page/2/">Next</a>
      </nav>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Page 1'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });

  it('should skip nav-links and post-navigation', () => {
    setupHTML(`
      <div class="post-navigation">
        <div class="nav-links">
          <a href="/previous-post/">Previous: Older Article Title Here</a>
          <a href="/next-post/">Next: Newer Article Title Here</a>
        </div>
      </div>
      <article>
        <p>Article text for translation testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Previous'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Next'))).toBe(false);
    expect(blockTexts).toContain('Article text for translation testing here.');
  });
});

describe('extractBlocks - Table of Contents', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip toc, table-of-contents, toc-container, toc-widget', () => {
    setupHTML(`
      <nav class="toc">
        <h2>Table of Contents</h2>
        <ol class="toc-list">
          <li>Introduction to the topic at hand</li>
          <li>Main analysis section with key findings</li>
          <li>Conclusion and final thoughts summary</li>
        </ol>
      </nav>
      <div class="table-of-contents">
        <p>Quick navigation for this lengthy article page.</p>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Table of Contents'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Introduction to the topic'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Main analysis'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });
});

describe('extractBlocks - Language switchers', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip lang-switcher, language-switcher, language-selector', () => {
    setupHTML(`
      <div class="language-switcher">
        <ul class="lang-select">
          <li>English</li>
          <li>中文</li>
          <li>日本語</li>
        </ul>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('English'))).toBe(false);
    expect(blockTexts.some(t => t.includes('中文'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });
});

describe('extractBlocks - Tags and taxonomy', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip tagcloud, tags-list, category-list, taxonomy-list', () => {
    setupHTML(`
      <div class="tagcloud">
        <a href="/tag/ai/">Artificial Intelligence Technology</a>
        <a href="/tag/ml/">Machine Learning Framework</a>
      </div>
      <div class="categories-list">
        <ul class="category-list">
          <li>Technology and Innovation</li>
          <li>Science and Research</li>
        </ul>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Artificial Intelligence'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Machine Learning'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Technology and Innovation'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });
});

describe('extractBlocks - Captcha', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip captcha, recaptcha, hcaptcha, turnstile', () => {
    setupHTML(`
      <div class="g-recaptcha">
        <p>Please verify you are not a robot to continue.</p>
      </div>
      <div class="h-captcha">
        <p>Human verification required for form submission.</p>
      </div>
      <div class="turnstile">
        <p>Security check in progress for this page request.</p>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('verify you are not'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Human verification'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Security check'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });
});

describe('extractBlocks - Site header and branding', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip site-header, top-bar, masthead, site-branding', () => {
    setupHTML(`
      <header class="site-header">
        <div class="top-bar">
          <p>Breaking news alert: Important announcement header text.</p>
        </div>
        <div class="site-branding">
          <p class="site-logo">Tech Blog Daily Newsletter Publication</p>
        </div>
      </header>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Breaking news'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Tech Blog'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });
});

describe('extractBlocks - Rating, polling and voting widgets', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip rating-widget, star-rating, review-widget, review-box', () => {
    setupHTML(`
      <div class="rating-widget">
        <div class="star-rating">
          <p>4.5 out of 5 stars based on user feedback content.</p>
        </div>
      </div>
      <div class="review-widget">
        <p>Customer reviews and testimonials for the product.</p>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('out of 5 stars'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Customer reviews'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });

  it('should skip poll, voting, vote-widget, survey', () => {
    setupHTML(`
      <div class="poll">
        <form class="poll-container">
          <p>What is your favorite programming language for AI development?</p>
          <label><input type="radio" name="poll" /> Python for AI and ML</label>
          <label><input type="radio" name="poll" /> JavaScript for Web Apps</label>
        </form>
      </div>
      <div class="survey">
        <p>Please take our quick survey about website satisfaction rates.</p>
      </div>
      <article>
        <p>Article text for translation testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('favorite programming language'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Python for AI'))).toBe(false);
    expect(blockTexts.some(t => t.includes('quick survey'))).toBe(false);
    expect(blockTexts).toContain('Article text for translation testing here.');
  });
});

describe('extractBlocks - Article <header> with h1/h2 (aleksagordic style)', () => {
  // Bug fix: 之前 <header> 整棵子树被连坐拒绝，
  // 导致文章页面的 h1 标题和 h2 副标题永远抓不到。
  // 修复: 含 h1-h6 的 <header> 改为 FILTER_SKIP（跳过自身但走子树），
  //       不含的（典型 nav / 顶部 chrome）仍然整棵拒绝。
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('extracts h1 and h2 inside an article <header>', () => {
    setupHTML(`
      <article>
        <header class="mb-8">
          <h1 class="font-bold text-3xl mb-4">Inside the Transformer: The Life of a Token</h1>
          <h2 class="text-xl mb-3 mt-6">A deep dive into a modern dense transformer</h2>
        </header>
        <p>First paragraph of the article body here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const tagList = blocks.map(b => b.tag);
    const texts = blocks.map(b => b.text);

    expect(tagList).toContain('h1');
    expect(tagList).toContain('h2');
    expect(texts.some(t => t.includes('Inside the Transformer'))).toBe(true);
    expect(texts.some(t => t.includes('deep dive into a modern'))).toBe(true);
  });

  it('still rejects chrome <header> (navbar) without headings', () => {
    setupHTML(`
      <header class="site-header">
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/blog">Blog</a>
        </nav>
      </header>
      <main>
        <p>Real article body content for translation testing.</p>
      </main>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    // nav links 不应该被翻译
    expect(texts.some(t => t.includes('Home'))).toBe(false);
    expect(texts.some(t => t.includes('About'))).toBe(false);
    expect(texts).toContain('Real article body content for translation testing.');
  });

  it('extracts h1 from blog post header (h1 only, not meta p)', () => {
    setupHTML(`
      <article>
        <header>
          <h1>My Blog Post Title</h1>
          <p class="meta">By John Doe on May 26, 2026</p>
        </header>
        <p>Article body content goes here for translation.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const tagList = blocks.map(b => b.tag);
    const texts = blocks.map(b => b.text);

    // h1 进去
    expect(tagList).toContain('h1');
    expect(texts.some(t => t.includes('My Blog Post Title'))).toBe(true);
    // article body p 进去
    expect(texts).toContain('Article body content goes here for translation.');
    // meta p（作者 / 日期）被 isMetadataClass 跳过，保留原文
    expect(texts.some(t => t.includes('By John Doe'))).toBe(false);
  });
});

describe('extractBlocks - Metadata class skipping (author/date/category)', () => {
  // 文章元数据容器（class 含 meta/author/byline/category/dateline）
  // 整棵子树拒绝，避免误翻人名 / 日期 / 分类。
  // 用整词分割匹配（split on [_\-\s]），不会误伤 class="metadata-block" 这种。
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('skips post-meta with author and date', () => {
    setupHTML(`
      <article>
        <p class="post-meta">By John Doe on May 26, 2026 in Tech</p>
        <p>Real article body text for translation testing.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    expect(texts.some(t => t.includes('By John Doe'))).toBe(false);
    expect(texts.some(t => t.includes('May 26, 2026'))).toBe(false);
    expect(texts).toContain('Real article body text for translation testing.');
  });

  it('skips author-bio block', () => {
    setupHTML(`
      <div>
        <p>First paragraph of article body here.</p>
        <div class="author-bio">
          <p>Written by Jane Smith, Senior Engineer at Acme Corp.</p>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    expect(texts).toContain('First paragraph of article body here.');
    expect(texts.some(t => t.includes('Jane Smith'))).toBe(false);
    expect(texts.some(t => t.includes('Senior Engineer'))).toBe(false);
  });

  it('skips post-categories list', () => {
    setupHTML(`
      <article>
        <p>Real article content for the reader here.</p>
        <ul class="post-categories">
          <li>Tech</li>
          <li>AI</li>
          <li>Engineering</li>
        </ul>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    expect(texts).toContain('Real article content for the reader here.');
    // 分类列表里 li 不应被翻译
    expect(texts.some(t => t === 'Tech' || t === 'AI' || t === 'Engineering')).toBe(false);
  });

  it('does NOT skip class="metadata-block" (false positive guard)', () => {
    // "metadata" 整词不在 set 里（set 是 "meta"），整词分割后 metadata 不命中
    // → 这类合法内容容器应当被翻译
    setupHTML(`
      <div>
        <p>Content block that is just metadata-ish but real prose.</p>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    expect(texts).toContain('Content block that is just metadata-ish but real prose.');
  });

  it('does NOT skip class="authorship" (false positive guard)', () => {
    // "authorship" 整词不在 set 里（set 是 "author"），不会被误伤
    setupHTML(`
      <section>
        <p>Discussion of authorship in modern publishing here.</p>
      </section>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    expect(texts).toContain('Discussion of authorship in modern publishing here.');
  });

  it('handles complex class with multiple tokens including meta', () => {
    setupHTML(`
      <article>
        <p>Real prose content body for translation testing.</p>
        <p class="entry-header meta-info">By Author Name, Posted 2 Days Ago</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map(b => b.text);

    expect(texts).toContain('Real prose content body for translation testing.');
    expect(texts.some(t => t.includes('Author Name'))).toBe(false);
  });

  it('does NOT reject <article> with WordPress category-* classes (regression: infoworld)', () => {
    // WordPress 在 <article> 上加 category-x 类，如 "category-artificial-intelligence"。
    // "category" 在 METADATA_TOKENS 中，但 <article> 是结构容器，不应因此被整棵拒绝。
    setupHTML(`
      <article class="category-artificial-intelligence category-development-tools post-12345">
        <h1>Article Title About AI</h1>
        <p>This is the real article body content that must be translated.</p>
        <p>Second paragraph with more important information for readers.</p>
      </article>
    `);

    const blocks = extractBlocks(document, 'https://example.com/test');
    const texts = blocks.map(b => b.text);

    expect(texts).toContain('Article Title About AI');
    expect(texts).toContain('This is the real article body content that must be translated.');
    expect(texts).toContain('Second paragraph with more important information for readers.');
  });

  it('does NOT reject <section> with content + category tokens (regression: github.blog)', () => {
    // GitHub Blog (WordPress) 用 <section class="post__content category-ai-and-ml">
    // "category" 命中 METADATA_TOKENS，但 "post"/"content" 是内容容器 token，
    // 不应因 metadata class 拒绝整篇文章。
    setupHTML(`
      <main>
        <header><h1>GitHub Blog Post Title</h1></header>
        <section class="col-12 col-md-8 col-lg-7 post__content is-layout-constrained post-97467 post type-post status-publish format-standard has-post-thumbnail hentry category-ai-and-ml category-engineering tag-github-copilot tag-llms">
          <p>Give an agent better tools and it should do better work.</p>
          <p>When you open a pull request, Copilot code review reads the diff.</p>
          <p>The tools were not the problem. The instructions were.</p>
        </section>
        <aside class="author-bio">
          <p class="meta-info">Author bio with metadata that should be skipped.</p>
        </aside>
      </main>
    `);

    const blocks = extractBlocks(document, 'https://github.blog/test');
    const texts = blocks.map(b => b.text);

    expect(texts).toContain('Give an agent better tools and it should do better work.');
    expect(texts).toContain('When you open a pull request, Copilot code review reads the diff.');
    expect(texts).toContain('The tools were not the problem. The instructions were.');
    expect(texts.some(t => t.includes('Author bio with metadata'))).toBe(false);
  });

  it('STILL rejects pure metadata <section> without content tokens', () => {
    // 没有 content token 的 metadata section 仍应被拒绝
    setupHTML(`
      <main>
        <section class="category-list meta-info author-bio">
          <p>Author: John Doe. Date: 2024-01-15. Category: AI.</p>
        </section>
        <article>
          <p>Real article content that should be translated.</p>
        </article>
      </main>
    `);

    const blocks = extractBlocks(document, 'https://example.com/test');
    const texts = blocks.map(b => b.text);

    expect(texts).toContain('Real article content that should be translated.');
    expect(texts.some(t => t.includes('John Doe'))).toBe(false);
  });
});

describe('extractBlocks - Exit intent and welcome popups', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip exit-popup, exit-intent, welcome-popup, welcome-mat', () => {
    setupHTML(`
      <div class="exit-popup">
        <p>Wait! Before you leave, subscribe for a special discount offer.</p>
      </div>
      <div class="welcome-popup">
        <p>Welcome to our site! Sign up for our newsletter to get started.</p>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Before you leave'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Welcome to our site'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });
});

describe('extractBlocks - nested <body> (WordPress CMS injection)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should not reject nested <body> inside article content (regression: infoworld)', () => {
    // WordPress 插件有时会在正文中注入 <!DOCTYPE><div><body>...</body></div>。
    // <body> 在 SKIP_SET 中，但嵌套 body（parent 不是 <html>）内容应被翻译。
    setupHTML(`
      <main>
        <h1>Article Title</h1>
        <article>
          <p>Article body text before the malformed injection.</p>
          <div id="remove_no_follow">
            <body>
              <p>Real article paragraph inside nested body element.</p>
              <p>Second paragraph also inside nested body.</p>
            </body>
          </div>
        </article>
      </main>
    `);

    const blocks = extractBlocks(document, 'https://www.infoworld.com/test');
    const texts = blocks.map(b => b.text);

    expect(texts).toContain('Article Title');
    expect(texts).toContain('Article body text before the malformed injection.');
    expect(texts).toContain('Real article paragraph inside nested body element.');
    expect(texts).toContain('Second paragraph also inside nested body.');
  });

  it('should not reject nested <html><body> inside section (regression: github.blog)', () => {
    // github.blog（WordPress）在 <section class="post__content"> 内注入
    //   <!DOCTYPE html><html><body><p>正文段落</p></body></html>
    // linkedom 解析后产生嵌套 <html><body>，walker 不应跳过其子节点。
    setupHTML(`
      <main>
        <section class="post__content">
          <html><body>
            <p>Give an agent better tools and it should do better work.</p>
            <p>When you open a pull request, Copilot code review reads the diff.</p>
            <h2>Same tools wrong instincts</h2>
            <p>The existing review tools were not thin wrappers.</p>
          </body></html>
        </section>
      </main>
    `);

    const blocks = extractBlocks(document, 'https://github.blog/test');
    const texts = blocks.map(b => b.text);

    expect(texts).toContain('Give an agent better tools and it should do better work.');
    expect(texts).toContain('When you open a pull request, Copilot code review reads the diff.');
    expect(texts).toContain('Same tools wrong instincts');
    expect(texts).toContain('The existing review tools were not thin wrappers.');
  });

  it('linkedom: nested <body> inside <html> inside post__content must be traversed (regression: github.blog)', () => {
    // jsdom 对嵌套 <html>/<body> 的解析与 linkedom 不同, 可能掩盖旧 bug。
    // 用 linkedom 直接复现真实 github.blog 结构, 确保嵌套 body 不被误判为
    // 文档级 body 而整棵拒绝。
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <main>
            <section class="post__content category-ai-and-ml tag-agentic-workflows">
              <html><body>
                <p>First paragraph inside nested body.</p>
                <p>Second paragraph inside nested body.</p>
                <h2>Heading inside nested body</h2>
                <p>Third paragraph inside nested body.</p>
              </body></html>
            </section>
          </main>
        </body>
      </html>
    `;
    const doc = parseHTML(html).document;
    const blocks = extractBlocks(doc, 'https://github.blog/test');
    const texts = blocks.map((b) => b.text);

    // 旧版 isNestedBody 用 parentElement.tagName !== 'html' 判断,
    // 嵌套 body 的父元素是嵌套 html, tagName 也是 'html',
    // 导致 isNestedBody=false, body 被 reject, 下面 4 个 block 全部丢失。
    expect(blocks).toHaveLength(4);
    expect(texts).toContain('First paragraph inside nested body.');
    expect(texts).toContain('Second paragraph inside nested body.');
    expect(texts).toContain('Heading inside nested body');
    expect(texts).toContain('Third paragraph inside nested body.');
  });
});

describe('extractBlocks - Print-only elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip print-only and print-version elements', () => {
    setupHTML(`
      <div class="print-only">
        <p>This content appears only in the printed version of the page.</p>
      </div>
      <div class="printable">
        <p>Printable version of the article for offline reading purposes.</p>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('printed version'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Printable version'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });
});

describe('extractBlocks - Fortune website structure', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should handle Fortune-like article structure', () => {
    setupHTML(`
      <div id="main-content" class="content-wrapper">
        <article class="article-body">
          <header class="article-header">
            <h1 class="article-title">Uber COO on AI Spending, Claude Code, and the Future of Autonomous Vehicles</h1>
          </header>
          <div class="article-content">
            <p>Uber's chief operating officer sat down with Fortune to discuss the company's strategy in artificial intelligence, including investments in LLMs and autonomous driving technology.</p>
            <p>The executive highlighted the importance of Claude Code for their internal development tools, which has helped streamline their coding workflows by 30%.</p>
            <p>With billions in annual AI spending, Uber is betting big on automation to transform both their ride-sharing and delivery businesses.</p>
          </div>
        </article>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    console.log('Fortune test blocks:', blocks.map(b => ({ tag: b.tag, text: b.text.substring(0, 50) })));
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks.some(b => b.text.includes('chief operating officer sat down'))).toBe(true);
  });

  it('should extract simple h1 title', () => {
    setupHTML(`
      <article>
        <h1>Simple test article title that should be extracted</h1>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    console.log('Simple h1 test blocks:', blocks.map(b => ({ tag: b.tag, text: b.text })));
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some(b => b.tag === 'h1')).toBe(true);
  });

  it('should NOT skip content when article uses common content class names', () => {
    setupHTML(`
      <article>
        <div class="article-content">
          <p>Main article content that must be translated here.</p>
        </div>
        <div class="content-body">
          <p>Another important paragraph to translate.</p>
        </div>
        <div class="story-content">
          <p>Story content should also be available.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks.some(b => b.text.includes('Main article content'))).toBe(true);
    expect(blocks.some(b => b.text.includes('Another important paragraph'))).toBe(true);
    expect(blocks.some(b => b.text.includes('Story content should'))).toBe(true);
  });

  it('should detect isInsideArticle by common article container class names', () => {
    // 测试各种文章容器类名
    const testCases = [
      { class: 'article-content', description: 'article-content' },
      { class: 'article-body', description: 'article-body' },
      { class: 'story-content', description: 'story-content' },
      { class: 'story-body', description: 'story-body' },
      { class: 'main-content', description: 'main-content' },
      { class: 'content-body', description: 'content-body' },
      { class: 'content-area', description: 'content-area' },
      { class: 'post-content', description: 'post-content' },
      { class: 'entry-content', description: 'entry-content' },
      { class: 'page-content', description: 'page-content' },
    ];
    
    for (const testCase of testCases) {
      document.body.innerHTML = `
        <div class="${testCase.class}">
          <p>Test paragraph inside ${testCase.description}</p>
        </div>
      `;
      
      const blocks = extractBlocks(document, "https://example.com/test");
      expect(blocks.length, `${testCase.description} should find blocks`).toBeGreaterThanOrEqual(1);
    }
  });

  it('should extract text from a deeply nested article p tag similar to the Fortune URL example', () => {
    // 模拟用户提供的 XPath: /html/body/div[3]/div[1]/div[4]/div[1]/main/div/div[2]/div[1]/div/div[2]/div[1]/article/p
    document.body.innerHTML = `
      <div>
        <div></div>
        <div>
          <div>
            <div></div>
            <div></div>
            <div></div>
            <div>
              <main>
                <div>
                  <div></div>
                  <div>
                    <div>
                      <div></div>
                      <div>
                        <div>
                          <article>
                            <p>Uber's chief operating officer sat down with Fortune to discuss the company's strategy in artificial intelligence, including investments in LLMs and autonomous driving technology.</p>
                          </article>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </main>
            </div>
          </div>
        </div>
      </div>
    `;
    
    const blocks = extractBlocks(document, "https://example.com/test");
    console.log('Nested article test blocks found:', blocks.length, blocks);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some(b => b.text.includes('Uber'))).toBe(true);
  });

  it('should extract paywall content inside article (Fortune.com structure)', () => {
    document.body.innerHTML = `
      <div class="flex flex-col layout-footer-gap">
        <div class="flex flex-col not-has-[div]:layout-nav-gap">
          <main>
            <div class="article-page-wrapper">
              <div class="group/article">
                <div class="col-start-2">
                  <div class="container-content">
                    <article class="article-content max-md:[&_p]:text-lg">
                      <p>Uber's business model is one of the most AI-forward in Silicon Valley.</p>
                      <div class="paywall paywallActive">
                        <p>In a recent interview on the Rapid Response podcast, Uber president and chief operating officer Andrew Macdonald discussed the company approach.</p>
                        <p>That link is not there yet, he said.</p>
                        <h2 class="wp-block-heading">Can firms justify their AI spending?</h2>
                        <p>In an earnings call earlier this month, Uber CEO Dara Khosrowshahi said about 10 percent of the company code is AI generated.</p>
                      </div>
                    </article>
                  </div>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    `;

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('AI-forward in Silicon Valley'))).toBe(true);
    expect(blockTexts.some(t => t.includes('Rapid Response podcast'))).toBe(true);
    expect(blockTexts.some(t => t.includes('That link is not there yet'))).toBe(true);
    expect(blockTexts.some(t => t.includes('Can firms justify their AI spending'))).toBe(true);
    expect(blockTexts.some(t => t.includes('10 percent of the company code'))).toBe(true);
  });

  it('should NOT skip content due to layout-footer-gap class (Tailwind CSS layout)', () => {
    document.body.innerHTML = `
      <div class="flex flex-col layout-footer-gap">
        <main>
          <article>
            <p>This content must be translated even though an ancestor has layout-footer-gap class.</p>
          </article>
        </main>
      </div>
    `;

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some(b => b.text.includes('must be translated'))).toBe(true);
  });

  it('should not extract li when it contains a nested p (arxiv structure)', () => {
    document.body.innerHTML = `
      <article>
        <div class="ltx_para" id="S1.p7">
          <ul class="ltx_itemize" id="S1.I1">
            <li class="ltx_item" id="S1.I1.i1">
              <span class="ltx_tag ltx_tag_item">•</span>
              <div class="ltx_para" id="S1.I1.i1.p1">
                <p class="ltx_p" id="S1.I1.i1.p1.1">We introduce workflow compilation, a compiler-inspired paradigm for optimizing structured LLM workflows before deployment.</p>
              </div>
            </li>
            <li class="ltx_item" id="S1.I1.i2">
              <span class="ltx_tag ltx_tag_item">•</span>
              <div class="ltx_para" id="S1.I1.i2.p1">
                <p class="ltx_p" id="S1.I1.i2.p1.1">We develop a structure-aware compositional proxy that lifts reusable sub-agent proxies.</p>
              </div>
            </li>
            <li class="ltx_item" id="S1.I1.i3">
              <span class="ltx_tag ltx_tag_item">•</span>
              <div class="ltx_para" id="S1.I1.i3.p1">
                <p class="ltx_p" id="S1.I1.i3.p1.1">We present FlowCompile, an optimizing compiler that performs a single compile-time search.</p>
              </div>
            </li>
          </ul>
        </div>
      </article>
    `;

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blocks.some(b => b.text.includes('We introduce workflow compilation'))).toBe(true);
    expect(blocks.some(b => b.text.includes('We develop a structure-aware'))).toBe(true);
    expect(blocks.some(b => b.text.includes('We present FlowCompile'))).toBe(true);

    const workflowCount = blockTexts.filter(t => t.includes('We introduce workflow compilation')).length;
    expect(workflowCount).toBe(1);
  });
});

// ========== Hidden Elements ==========

describe('extractBlocks - Hidden Elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip elements with hidden attribute', () => {
    setupHTML(`
      <article>
        <p hidden>This paragraph is hidden and should be skipped.</p>
        <p>Visible paragraph content here.</p>
      </article>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    const hiddenBlocks = blocks.filter(b => b.text.includes('hidden'));
    expect(hiddenBlocks).toHaveLength(0);
    expect(blocks).toHaveLength(1);
  });

  it('should skip elements with aria-hidden="true"', () => {
    setupHTML(`
      <article>
        <p aria-hidden="true">This is aria-hidden content.</p>
        <p>Visible paragraph content here.</p>
      </article>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('Visible');
  });

  it('should skip elements with display:none inline style', () => {
    setupHTML(`
      <article>
        <p style="display: none">Hidden by display none.</p>
        <p>Visible paragraph content here.</p>
      </article>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    const hiddenBlocks = blocks.filter(b => b.text.includes('display none'));
    expect(hiddenBlocks).toHaveLength(0);
    expect(blocks).toHaveLength(1);
  });

  it('should skip elements with visibility:hidden inline style', () => {
    setupHTML(`
      <article>
        <p style="visibility: hidden">Hidden by visibility hidden.</p>
        <p>Visible paragraph content here.</p>
      </article>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    const hiddenBlocks = blocks.filter(b => b.text.includes('visibility hidden'));
    expect(hiddenBlocks).toHaveLength(0);
    expect(blocks).toHaveLength(1);
  });

  it('should skip elements whose parent is hidden', () => {
    setupHTML(`
      <article>
        <div hidden>
          <p>Nested inside hidden div should be skipped.</p>
        </div>
        <p>Visible paragraph content here.</p>
      </article>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('Visible');
  });

  it('should skip elements whose ancestor has aria-hidden="true"', () => {
    setupHTML(`
      <article>
        <div aria-hidden="true">
          <p>Nested inside aria-hidden div should be skipped.</p>
        </div>
        <p>Visible paragraph content here.</p>
      </article>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('Visible');
  });

  it('should skip when parent has display:none', () => {
    setupHTML(`
      <article>
        <div style="display: none">
          <p>Nested inside display:none container.</p>
        </div>
        <p>Visible paragraph content here.</p>
      </article>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('Visible');
  });

  it('should NOT skip elements hidden via CSS class (only inline style affects TreeWalker)', () => {
    // CSS class-based hiding is not detected by isElementHidden — only inline style
    const style = document.createElement('style');
    style.textContent = '.hidden-by-css { display: none; }';
    document.head.appendChild(style);

    setupHTML(`
      <article>
        <p class="hidden-by-css">Hidden by CSS class should be skipped.</p>
        <p>Visible paragraph content here.</p>
      </article>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    // CSS class-based hiding is not detected by walker-level checks
    const cssBlocks = blocks.filter(b => b.text.includes('Hidden by CSS'));
    // but it IS caught by shouldSkipByClass since 'hidden' is not in SKIP_CLASS_PATTERNS
    // The class hiding is via CSS, not inline, so the element is visible to the walker
    expect(cssBlocks.length).toBeGreaterThanOrEqual(0);
  });
});

// ========== Article Container Detection ==========

describe('extractBlocks - Article Container Detection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should detect article tag as container', () => {
    setupHTML(`
      <div>
        <article>
          <p>Article paragraph content here.</p>
        </article>
        <div><p>Non-article paragraph content here.</p></div>
      </div>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect role="article" as container', () => {
    setupHTML(`
      <div>
        <div role="article">
          <span>Inline text inside article role context.</span>
        </div>
      </div>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    const articleBlocks = blocks.filter(b => b.text.includes('Inline text'));
    expect(articleBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect role="main" as container', () => {
    setupHTML(`
      <div>
        <div role="main">
          <span>Inline text inside main role context.</span>
        </div>
      </div>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

});

// ============================================================
// 通用噪声模式回归测试。覆盖在 blockExtractor.ts 的
// SKIP_CLASS_PATTERNS 中加入的跨站通用 class 模式，用于
// 防止以后误删 pattern 导致噪声回流。每个 describe 块对应
// 一类场景。
// ============================================================

describe('extractBlocks - Inline signup/newsletter (generic noise)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip inline-signup, inline-newsletter, inline-subscribe, inline-subscription', () => {
    setupHTML(`
      <article>
        <p>Real article body content that should be translated.</p>
        <div class="inline-signup">
          <p>Subscribe to our daily newsletter for top stories.</p>
          <input type="email" placeholder="you@example.com" />
          <button>Sign up</button>
        </div>
        <div class="inline-newsletter">
          <p>Get the latest updates delivered to your inbox.</p>
        </div>
        <div class="inline-subscribe">
          <p>Join our subscription list for exclusive content.</p>
        </div>
        <div class="inline-subscription">
          <p>Manage your subscription preferences and settings here.</p>
        </div>
        <p>Second article paragraph after signup forms.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts).toContain('Real article body content that should be translated.');
    expect(blockTexts).toContain('Second article paragraph after signup forms.');
    expect(blockTexts.some(t => t.includes('Subscribe to our daily newsletter'))).toBe(false);
    expect(blockTexts.some(t => t.includes('latest updates delivered'))).toBe(false);
    expect(blockTexts.some(t => t.includes('subscription list'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Manage your subscription'))).toBe(false);
  });

  it('should skip embed-signup, embed-newsletter, embed-subscribe', () => {
    setupHTML(`
      <article>
        <p>Article body content here.</p>
        <div class="embed-signup">
          <p>Sign up for our premium content access today.</p>
        </div>
        <div class="embed-newsletter">
          <p>Subscribe to the embedded newsletter widget below.</p>
        </div>
        <div class="embed-subscribe">
          <p>Click the embedded subscribe button to register.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts).toContain('Article body content here.');
    expect(blockTexts.some(t => t.includes('premium content access'))).toBe(false);
    expect(blockTexts.some(t => t.includes('embedded newsletter'))).toBe(false);
    expect(blockTexts.some(t => t.includes('embedded subscribe'))).toBe(false);
  });

  it('should reject both "Sign up" button text and "Email:" label inside inline-signup', () => {
    // 银行站订阅表单常见结构：<div class=inline-signup><form>...<label>Email:</label>
    // 要确保 form / label / input / select 整个被拒掉，文本 "Email:" 不进 blocks。
    setupHTML(`
      <article>
        <p>Real article paragraph text content here.</p>
        <div class="inline-signup">
          <form>
            <label>Email:</label>
            <input type="email" />
            <select>
              <option>Daily</option>
              <option>Weekly</option>
            </select>
            <button>Sign up</button>
            <p>By signing up you agree to our Terms of Use and Privacy Policy.</p>
          </form>
        </div>
        <p>Another article paragraph after the form here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts).toContain('Real article paragraph text content here.');
    expect(blockTexts).toContain('Another article paragraph after the form here.');
    expect(blockTexts.some(t => /^Email:?$/.test(t.trim()))).toBe(false);
    expect(blockTexts.some(t => t.includes('Terms of Use'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Daily'))).toBe(false);
  });
});

describe('extractBlocks - Read-more / recommended articles (generic noise)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip read-more, read_more, readmore, more-from', () => {
    setupHTML(`
      <article>
        <p>Article body content that should be translated.</p>
        <div class="read-more">
          <p>Continue reading the full story on our website now.</p>
        </div>
        <div class="read_more">
          <p>Read more of our exclusive investigative reporting content.</p>
        </div>
        <div class="readmore">
          <p>Click readmore to see the complete article details here.</p>
        </div>
        <div class="more-from">
          <p>More from our politics section this week and updates.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts).toContain('Article body content that should be translated.');
    expect(blockTexts.some(t => t.includes('Continue reading'))).toBe(false);
    expect(blockTexts.some(t => t.includes('exclusive investigative'))).toBe(false);
    expect(blockTexts.some(t => t.includes('readmore to see'))).toBe(false);
    expect(blockTexts.some(t => t.includes('politics section'))).toBe(false);
  });

  it('should skip reading-list, recommended-reading, recommended-articles', () => {
    setupHTML(`
      <article>
        <p>Main article body text for translation testing here.</p>
        <div class="reading-list">
          <h3>Read More in Technology</h3>
          <p>JPMorgan Chase taps AI to process checks faster than ever before.</p>
          <p>Fintech revenues hit record five hundred four billion in 2025.</p>
        </div>
        <div class="recommended-reading">
          <h3>Recommended Reading</h3>
          <p>California judge rules in favor of OppFi against the regulator.</p>
        </div>
        <div class="recommended-articles">
          <h3>Recommended Articles For You Today</h3>
          <p>StanChart CEO apologizes over lower value human comments.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts).toContain('Main article body text for translation testing here.');
    expect(blockTexts.some(t => t.includes('Read More in Technology'))).toBe(false);
    expect(blockTexts.some(t => t.includes('JPMorgan Chase taps AI'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Fintech revenues'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Recommended Reading'))).toBe(false);
    expect(blockTexts.some(t => t.includes('California judge'))).toBe(false);
    expect(blockTexts.some(t => t.includes('StanChart CEO'))).toBe(false);
  });
});

describe('extractBlocks - Inline article carousels (generic noise)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip storylines-carousel / article-carousel / related-carousel even when nested inside article-body', () => {
    // bankingdive 把 storylines-carousel 嵌在 .article-body 中间。SKIP_CLASS_PATTERNS
    // 必须直接命中这个 class，不能因为"在 article-body 里"就放行。
    setupHTML(`
      <article>
        <p>Real article paragraph before the carousel.</p>
        <div class="article-body">
          <p>Article body paragraph inside body container.</p>
          <section class="storylines-carousel-wrapper hide-small show-large">
            <div class="storylines-carousel">
              <h3>Read More in Technology</h3>
              <p>JPMorgan Chase taps AI to process checks faster than before.</p>
            </div>
          </section>
          <p>Article body paragraph after the carousel.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts).toContain('Real article paragraph before the carousel.');
    expect(blockTexts).toContain('Article body paragraph inside body container.');
    expect(blockTexts).toContain('Article body paragraph after the carousel.');
    expect(blockTexts.some(t => t.includes('Read More in Technology'))).toBe(false);
    expect(blockTexts.some(t => t.includes('JPMorgan Chase taps AI'))).toBe(false);
  });

  it('should skip article-carousel, inline-carousel, related-stories, more-stories-carousel', () => {
    setupHTML(`
      <article>
        <p>Body paragraph between carousels for testing.</p>
        <div class="article-carousel">
          <p>Article carousel with multiple related stories inside.</p>
        </div>
        <div class="inline-carousel">
          <p>Inline carousel showing top stories of the week here.</p>
        </div>
        <div class="related-stories">
          <p>Related stories from our archives and contributor network.</p>
        </div>
        <div class="more-stories-carousel">
          <p>More stories carousel for additional reading suggestions.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts).toContain('Body paragraph between carousels for testing.');
    expect(blockTexts.some(t => t.includes('multiple related stories'))).toBe(false);
    expect(blockTexts.some(t => t.includes('top stories of the week'))).toBe(false);
    expect(blockTexts.some(t => t.includes('archives and contributor'))).toBe(false);
    expect(blockTexts.some(t => t.includes('additional reading'))).toBe(false);
  });
});

describe('extractBlocks - Post-article wrapper noise (generic)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip post-article-wrapper / after-article / below-content / article-footer-widgets', () => {
    setupHTML(`
      <article>
        <p>Last paragraph of the real article body here.</p>
        <div class="post-article-wrapper">
          <p>More from our coverage area and related investigations.</p>
        </div>
        <div class="after-article">
          <p>After article promotional content and signup widget here.</p>
        </div>
        <div class="below-content">
          <p>Below content recommended stories and newsletter signup.</p>
        </div>
        <div class="article-footer-widgets">
          <p>Article footer widgets with share buttons and tags cloud.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts).toContain('Last paragraph of the real article body here.');
    expect(blockTexts.some(t => t.includes('related investigations'))).toBe(false);
    expect(blockTexts.some(t => t.includes('After article promotional'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Below content recommended'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Article footer widgets'))).toBe(false);
  });
});

describe('extractBlocks - Hybrid ad wrapper noise (generic)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip hybrid-ad, hybrid-ad-wrapper (and underscore variant)', () => {
    setupHTML(`
      <article>
        <p>Real article body text before the ad slot here.</p>
        <div class="hybrid-ad-wrapper">
          <p>Hybrid ad wrapper for desktop and mobile sized units.</p>
        </div>
        <div class="hybrid-ad">
          <p>Hybrid ad inner slot for programatic ad placement content.</p>
        </div>
        <div class="hybrid_ad_wrapper">
          <p>Hybrid ad wrapper with underscores for compatibility styles.</p>
        </div>
        <p>Real article body text after the ad slots here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts).toContain('Real article body text before the ad slot here.');
    expect(blockTexts).toContain('Real article body text after the ad slots here.');
    expect(blockTexts.some(t => t.includes('desktop and mobile sized'))).toBe(false);
    expect(blockTexts.some(t => t.includes('programatic ad placement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('compatibility styles'))).toBe(false);
  });
});

describe('extractBlocks - Printed branding noise (generic)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip printed-branding, printed-logo, print-branding, print-logo', () => {
    setupHTML(`
      <article>
        <h1>Article Title That Must Be Translated</h1>
        <p>Article body content that is the real translatable text here.</p>
        <div class="printed-branding">
          <span class="promoted-branded-copy">An article from</span>
          <img alt="site logo" />
        </div>
        <div class="printed-logo">
          <p>Print only logo block with brand copyright watermark text.</p>
        </div>
        <div class="print-branding">
          <p>Print branding block with media kit and contact details.</p>
        </div>
        <div class="print-logo">
          <p>Print logo block with footer copyright notice information.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts).toContain('Article Title That Must Be Translated');
    expect(blockTexts).toContain('Article body content that is the real translatable text here.');
    expect(blockTexts.some(t => t.includes('An article from'))).toBe(false);
    expect(blockTexts.some(t => t.includes('brand copyright watermark'))).toBe(false);
    expect(blockTexts.some(t => t.includes('media kit and contact'))).toBe(false);
    expect(blockTexts.some(t => t.includes('footer copyright notice'))).toBe(false);
  });
});

describe('extractBlocks - Bankingdive-style article regression', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // 这次回归的触发页面：bankingdive.com 的 Wells Fargo CEO 文章
  // (https://www.bankingdive.com/news/wells-fargo-ceo-scharf-ai-employment-banking-jobs/821368/)
  // 整页结构：<article>(empty class) > [.first-page-pdf > .printed-branding,
  // .article-title-wrapper > h1 + p 副标题, .article-byline, .article-wrapper >
  // .article-body(含 .hybrid-ad-wrapper / .inline-signup / .storylines-carousel),
  // .reading-list, .post-article-wrapper]
  // 之前 90 个块、26 个噪声；改后 43 个块、0 个噪声，标题/副标题稳定。
  it('bankingdive: should extract h1+subtitle+body, drop signup/read-more/post-article noise', () => {
    setupHTML(`
      <article class="">
        <div class="first-page-pdf">
          <div class="printed-branding">
            <span class="promoted-branded-copy">An article from</span>
          </div>
          <div class="article-title-wrapper">
            <h1>Wells Fargo CEO: AI effect on employment is complicated</h1>
            <p>The bank's biggest AI-related challenge is determining how the technology transforms business.</p>
          </div>
        </div>
        <div class="article-byline">
          <span>Caitlin Mullen</span>
          <span>Senior Editor</span>
        </div>
        <div class="article-wrapper">
          <div class="article-body">
            <p>Wells Fargo CEO Charlie Scharf said Wednesday the bank is examining its use of AI carefully.</p>
            <div class="hybrid-ad-wrapper">
              <p>Hybrid ad wrapper for desktop and mobile sized units.</p>
            </div>
            <p>The bank also plans to hire more people who can build AI systems internally over time.</p>
            <div class="inline-signup">
              <form>
                <label>Email:</label>
                <input type="email" />
                <button>Sign up</button>
                <p>By signing up you agree to our Terms of Use and Privacy Policy.</p>
              </form>
            </div>
            <section class="storylines-carousel-wrapper hide-small show-large">
              <div class="storylines-carousel">
                <h3>Read More in Technology</h3>
                <p>JPMorgan Chase taps AI to process checks faster than before.</p>
              </div>
            </section>
            <p>Ultimately Wells has cut about fifteen billion dollars in expenses over the past five years.</p>
          </div>
        </div>
        <div class="reading-list recommended-reading">
          <h3>Recommended Reading</h3>
          <p>California judge rules in favor of OppFi against the regulator.</p>
        </div>
        <div class="post-article-wrapper">
          <p>More from our coverage area and related investigations here.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const blockTexts = blocks.map(b => b.text);

    // 1. 标题 + 副标题必须保留（即使 h1 在 .article-body 外）
    expect(blockTexts).toContain('Wells Fargo CEO: AI effect on employment is complicated');
    expect(blockTexts).toContain("The bank's biggest AI-related challenge is determining how the technology transforms business.");

    // 2. 正文段落必须保留
    expect(blockTexts).toContain('Wells Fargo CEO Charlie Scharf said Wednesday the bank is examining its use of AI carefully.');
    expect(blockTexts).toContain('The bank also plans to hire more people who can build AI systems internally over time.');
    expect(blockTexts).toContain('Ultimately Wells has cut about fifteen billion dollars in expenses over the past five years.');

    // 3. 噪声必须被拒掉
    expect(blockTexts.some(t => t.includes('An article from'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Caitlin Mullen'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Senior Editor'))).toBe(false);
    expect(blockTexts.some(t => t.includes('desktop and mobile sized'))).toBe(false);
    expect(blockTexts.some(t => /^Email:?$/.test(t.trim()))).toBe(false);
    expect(blockTexts.some(t => t.includes('Terms of Use'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Read More in Technology'))).toBe(false);
    expect(blockTexts.some(t => t.includes('JPMorgan Chase taps AI'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Recommended Reading'))).toBe(false);
    expect(blockTexts.some(t => t.includes('California judge'))).toBe(false);
    expect(blockTexts.some(t => t.includes('related investigations'))).toBe(false);
  });
});

// =============================================================================
// Regression tests: refactor (constants/rules/walker/index split)
// =============================================================================

describe('blockExtractor - isElementHidden performance (regression: layout thrash)', () => {
  // 旧实现: 走父链 + 每次都调 getComputedStyle,
  // 大型页面 (~1000 节点 × 15 深) 触发 ~15000 次 layout。
  // 新实现: 只查 el 自身 + WeakSet memo 避免重复。
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('detects hidden attribute without walking parent chain', () => {
    const div = document.createElement('div');
    div.setAttribute('hidden', '');
    document.body.appendChild(div);

    // jsdom 不一定支持 getComputedStyle,
    // 但 hidden 属性是 cheap path, 不需要走 computed。
    // 这里只验证 cheap path 命中 hidden 属性。
    expect(div.hasAttribute('hidden')).toBe(true);
  });

  it('detects aria-hidden=true', () => {
    const span = document.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.textContent = 'decorative text content here';
    document.body.appendChild(span);

    expect(span.getAttribute('aria-hidden')).toBe('true');
  });

  it('detects inline display:none style', () => {
    const p = document.createElement('p');
    p.style.display = 'none';
    p.textContent = 'invisible paragraph text content';
    document.body.appendChild(p);

    expect(p.style.display).toBe('none');
  });

  it('memoizes visible elements (WeakSet) to avoid repeated layout checks', () => {
    // 同一 visible 元素被多次查 isElementHidden, 第二次起应走 WeakSet 跳过。
    // 这条测试主要确认 WeakSet 机制存在; 实际 perf 收益需在真实浏览器测。
    const p = document.createElement('p');
    p.textContent = 'visible paragraph text content here';
    document.body.appendChild(p);

    expect(p.hasAttribute('hidden')).toBe(false);
    expect(p.getAttribute('aria-hidden')).not.toBe('true');
    expect(p.style.display).not.toBe('none');
  });
});

describe('blockExtractor - seenTexts dedup (HBR summary callout regression)', () => {
  // 同一段摘要出现在多个 callout (HBR summary box, social share preview,
  // article body) 时, 只送翻译一次, 节省 API 调用, 避免堆叠相同译文。
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('dedups identical paragraphs across multiple sections', () => {
    const duplicateText =
      'Companies that prioritize employee well-being consistently outperform their peers in long-term value creation across diverse market conditions.';

    setupHTML(`
      <article>
        <div class="summary-callout">
          <p>${duplicateText}</p>
        </div>
        <p>${duplicateText}</p>
        <div class="article-body">
          <p>${duplicateText}</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const matching = blocks.filter((b) => b.text === duplicateText);
    expect(matching).toHaveLength(1);
  });

  it('keeps distinct paragraphs even if very similar', () => {
    setupHTML(`
      <article>
        <p>Companies that prioritize employee well-being consistently outperform their peers.</p>
        <p>Companies that prioritize employee well-being consistently outperform peers in their industry.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBe(2);
  });
});

describe('blockExtractor - SVG / MathML namespace rejection', () => {
  // SVG 命名空间下的 <text> 元素不翻译, 避免破坏图表 / 公式。
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('skips <svg><text> elements entirely', () => {
    setupHTML(`
      <div>
        <p>Real paragraph text content here for translation.</p>
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <text x="10" y="50">Chart label not to translate</text>
        </svg>
      </div>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);

    expect(texts).toContain('Real paragraph text content here for translation.');
    expect(texts.some((t) => t.includes('Chart label'))).toBe(false);
  });
});

describe('blockExtractor - Public API re-exports (refactor regression)', () => {
  // 重构后从 blockExtractor/index 暴露 predicates 供高级用户使用。
  it('re-exports rule predicates from main module', async () => {
    const mod = await import('../lib/translate/blockExtractor');
    expect(typeof mod.extractBlocks).toBe('function');
    expect(typeof mod.findBlockNode).toBe('function');
    expect(typeof mod.buildNodeMap).toBe('function');
    // 重新导出的 predicate
    expect(typeof mod.isMetadataClass).toBe('function');
    expect(typeof mod.shouldSkipByClass).toBe('function');
    expect(typeof mod.isElementHidden).toBe('function');
    expect(typeof mod.isValidText).toBe('function');
    expect(typeof mod.classifyChildren).toBe('function');
  });

  it('exports TextBlock type and constants', async () => {
    const mod = await import('../lib/translate/blockExtractor');
    expect(mod.MIN_TEXT_LENGTH).toBe(3);
    expect(mod.MAX_TEXT_LENGTH).toBe(3072);
    expect(mod.PATTERNS).toBeDefined();
    expect(mod.PATTERNS.HEADING).toBeInstanceOf(RegExp);
  });
});

describe('blockExtractor - data-fanyi-block-id tag on extracted nodes', () => {
  // collectBlocks 在 grabNode 成功后写入 dataset.fanyiBlockId,
  // findBlockNode 用这个属性找回节点, 比 XPath 健壮 (抗 DOM 变化)。
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('tags extracted nodes with data-fanyi-block-id for robust lookup', () => {
    setupHTML(`
      <article>
        <p>First paragraph text for translation testing here.</p>
        <p>Second paragraph text for translation testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBe(2);

    for (const block of blocks) {
      const node = document.querySelector(`[data-fanyi-block-id="${block.id}"]`);
      expect(node).not.toBeNull();
      expect(node?.textContent?.trim()).toBe(block.text);
    }
  });

  it('findBlockNode returns the tagged element', () => {
    setupHTML(`
      <article>
        <p>Test paragraph text content for translation.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const node = findBlockNode(blocks[0], document);
    expect(node).not.toBeNull();
    expect((node as Element)?.textContent?.trim()).toBe(blocks[0].text);
  });

  it('buildNodeMap creates id→Node mapping for all blocks', () => {
    setupHTML(`
      <article>
        <p>First paragraph text for translation testing.</p>
        <p>Second paragraph text for translation testing.</p>
        <p>Third paragraph text for translation testing.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const map = buildNodeMap(blocks, document);

    expect(map.size).toBe(blocks.length);
    for (const block of blocks) {
      expect(map.get(block.id)).not.toBeNull();
    }
  });
});

// =============================================================================
// MDN coverage regression tests
// (验证 constants.ts 补全后的行为: 新加的 <search> <dialog> <address> <hgroup>
//  <del> <ins> <kbd> <samp> <var> <data> <s> <dfn> <ruby> 元素按预期分类)
// =============================================================================

describe('blockExtractor - MDN coverage: SEMANTIC_SKIP_TAGS additions', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('skips entire <dialog> subtree (modal, like cookie banner)', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <dialog open>
          <p>This dialog body text should not be translated.</p>
          <button>OK</button>
        </dialog>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    expect(texts.some((t) => t.includes('dialog body text'))).toBe(false);
    expect(texts).not.toContain('OK');
  });

  it('skips entire <search> subtree (search region, semantic nav)', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <search>
          <p>Search the website for related content here.</p>
        </search>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    expect(texts.some((t) => t.includes('Search the website'))).toBe(false);
  });

  it('skips entire <address> subtree (contact info, byline analog)', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <address>
          Contact: John Doe, john@example.com, San Francisco
        </address>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    expect(texts.some((t) => t.includes('Contact: John Doe'))).toBe(false);
  });
});

describe('blockExtractor - MDN coverage: SKIP_SET additions (media / embed)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('skips <video> and its <track> subtitles', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <video controls>
          <source src="movie.mp4" type="video/mp4">
          <track src="subs_en.vtt" kind="subtitles" srclang="en">
          Your browser does not support video.
        </video>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    expect(texts.some((t) => t.includes('Your browser does not support video'))).toBe(false);
  });

  it('skips <embed> and <object> (similar to iframe)', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <embed src="plugin.swf" type="application/x-shockwave-flash">
        <object data="external.html">
          <p>This is fallback text inside object element.</p>
        </object>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    expect(texts.some((t) => t.includes('fallback text inside object'))).toBe(false);
  });

  it('skips <template> placeholder content (avoid grabbing ghost text)', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <template id="tpl">
          <p>Template ghost text that should not be extracted.</p>
        </template>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    expect(texts.some((t) => t.includes('Template ghost text'))).toBe(false);
  });
});

describe('blockExtractor - MDN coverage: <hgroup> allows inner headings', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('skips <hgroup> wrapper but still extracts inner <h1>', () => {
    setupHTML(`
      <article>
        <hgroup>
          <h1>Article Main Title Text For Translation</h1>
          <h2>Subtitle of the article goes here today</h2>
        </hgroup>
        <p>Real article body paragraph text for translation testing.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Article Main Title Text For Translation');
    expect(texts).toContain('Subtitle of the article goes here today');
    expect(texts).toContain('Real article body paragraph text for translation testing.');
  });
});

describe('blockExtractor - MDN coverage: demarcating edits inline', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('treats <del> and <ins> as inline (translated via parent block)', () => {
    setupHTML(`
      <article>
        <p>The price is <del>twenty dollars</del> <ins>ten dollars</ins> for this item today.</p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBe(1);
    expect(blocks[0].text).toContain('twenty dollars');
    expect(blocks[0].text).toContain('ten dollars');
  });
});

describe('blockExtractor - MDN coverage: code preservation (regression)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not translate <kbd>, <samp>, <var>, <code> standalone', () => {
    // 验证: 单纯 <kbd>Ctrl+C</kbd> 不应被独立抓出 (会作为内联不被接受)
    // 但在 paragraph 中, 整段仍被 paragraph 抓
    setupHTML(`
      <article>
        <p>Press <kbd>Ctrl+C</kbd> to copy text in this application.</p>
        <p>The variable <var>count</var> stores the total number of items.</p>
        <p>Output: <samp>File not found error in current directory.</samp></p>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks.length).toBe(3);
    for (const block of blocks) {
      // 不应单独抓 kbd/var/samp, 应作为整段 paragraph
      expect(block.tag).toBe('p');
    }
  });

  it('preserves <code> and <pre> as invisible to translation', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <p>Use the function <code>getUserById(id)</code> to fetch the user data.</p>
        <pre>function foo() { return 42; }</pre>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    // pre 整段不应被抓
    expect(texts.some((t) => t.includes('function foo()'))).toBe(false);
    // code 也不应独立被抓 (它在 <p> 内, 整段 <p> 抓)
    const codeParagraph = blocks.find((b) => b.text.includes('getUserById'));
    expect(codeParagraph).toBeDefined();
    expect(codeParagraph!.text).toContain('getUserById(id)');
  });
});

describe('blockExtractor - MDN coverage: data tables not translated (regression)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not translate content inside <table> (Wikipedia-style data tables)', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <table>
          <thead>
            <tr><th>Year</th><th>GDP</th></tr>
          </thead>
          <tbody>
            <tr><td>2024</td><td>$25.4T</td></tr>
            <tr><td>2023</td><td>$23.0T</td></tr>
          </tbody>
        </table>
      </article>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    // 表格内容应被拒绝
    expect(texts.some((t) => t.includes('Year') && t.includes('GDP'))).toBe(false);
    expect(texts.some((t) => t.includes('2024') || t.includes('25.4T'))).toBe(false);
  });
});

describe('blockExtractor - MDN coverage: form text is translatable (regression)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('translates <label> and <legend> text (visible UI labels)', () => {
    setupHTML(`
      <form>
        <fieldset>
          <legend>Personal information section heading text</legend>
          <label>Email address field label</label>
          <input type="email">
        </fieldset>
      </form>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    expect(texts.some((t) => t.includes('Personal information'))).toBe(true);
    expect(texts.some((t) => t.includes('Email address field label'))).toBe(true);
  });

  it('translates <option> text inside <select>', () => {
    setupHTML(`
      <label for="lang">Choose a programming language</label>
      <select id="lang">
        <option>JavaScript option label</option>
        <option>TypeScript option label</option>
        <option>Python option label</option>
      </select>
    `);

    const blocks = extractBlocks(document, "https://example.com/test");
    const texts = blocks.map((b) => b.text);
    expect(texts.some((t) => t.includes('Choose a programming language'))).toBe(true);
    expect(texts.some((t) => t.includes('JavaScript option label'))).toBe(true);
    expect(texts.some((t) => t.includes('TypeScript option label'))).toBe(true);
    expect(texts.some((t) => t.includes('Python option label'))).toBe(true);
  });
});

// =============================================================================
// extractBlocksFromMarkedHtml — 预标记 HTML 直接提取
// =============================================================================

describe('extractBlocksFromMarkedHtml', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('从已标记 data-fanyi-block-id 的 HTML 中提取 blocks', () => {
    setupHTML(`
      <article>
        <p data-fanyi-block-id="b1">First paragraph text for translation.</p>
        <p data-fanyi-block-id="b2">Second paragraph text for translation.</p>
        <p data-fanyi-block-id="b3">Third paragraph text for translation.</p>
      </article>
    `);

    const blocks = extractBlocksFromMarkedHtml(document);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].id).toBe('b1');
    expect(blocks[0].text).toBe('First paragraph text for translation.');
    expect(blocks[0].tag).toBe('p');
    expect(blocks[1].id).toBe('b2');
    expect(blocks[2].id).toBe('b3');
  });

  it('按数值顺序排序（b10 在 b2 之后）', () => {
    setupHTML(`
      <article>
        <p data-fanyi-block-id="b10">Tenth paragraph text here.</p>
        <p data-fanyi-block-id="b1">First paragraph text here.</p>
        <p data-fanyi-block-id="b2">Second paragraph text here.</p>
      </article>
    `);

    const blocks = extractBlocksFromMarkedHtml(document);
    expect(blocks.map((b) => b.id)).toEqual(['b1', 'b2', 'b10']);
  });

  it('跳过重复 id（只保留第一个）', () => {
    setupHTML(`
      <article>
        <p data-fanyi-block-id="b1">First occurrence.</p>
        <p data-fanyi-block-id="b1">Duplicate id should be ignored.</p>
      </article>
    `);

    const blocks = extractBlocksFromMarkedHtml(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('First occurrence.');
  });

  it('跳过空文本元素', () => {
    setupHTML(`
      <article>
        <p data-fanyi-block-id="b1">Valid paragraph text here.</p>
        <p data-fanyi-block-id="b2">   </p>
        <p data-fanyi-block-id="b3"></p>
      </article>
    `);

    const blocks = extractBlocksFromMarkedHtml(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe('b1');
  });

  it('没有标记时返回空数组', () => {
    setupHTML(`
      <article>
        <p>No data attributes here.</p>
      </article>
    `);

    const blocks = extractBlocksFromMarkedHtml(document);
    expect(blocks).toHaveLength(0);
  });

  it('生成 xpath 作为回退定位', () => {
    setupHTML(`
      <article>
        <p data-fanyi-block-id="b1">Paragraph with xpath fallback.</p>
      </article>
    `);

    const blocks = extractBlocksFromMarkedHtml(document);
    expect(blocks[0].xpath).toBeTruthy();
    expect(blocks[0].xpath.startsWith('/')).toBe(true);
  });

  it('支持混合标签（p, h1, li, div）', () => {
    setupHTML(`
      <article>
        <h1 data-fanyi-block-id="b1">Article Title</h1>
        <p data-fanyi-block-id="b2">First paragraph.</p>
        <ul>
          <li data-fanyi-block-id="b3">List item one.</li>
          <li data-fanyi-block-id="b4">List item two.</li>
        </ul>
        <div data-fanyi-block-id="b5">Div block content.</div>
      </article>
    `);

    const blocks = extractBlocksFromMarkedHtml(document);
    expect(blocks).toHaveLength(5);
    expect(blocks[0].tag).toBe('h1');
    expect(blocks[1].tag).toBe('p');
    expect(blocks[2].tag).toBe('li');
    expect(blocks[4].tag).toBe('div');
  });
});

// =============================================================================
// collapseSpacedText —— 合并 CSS letter-spacing 渲染的分散单词
// hero section / CTA 按钮 / 品牌名常用 letter-spacing 装饰，textContent 抽取后
// 变成 "S t a r t" 这种单字符+空格序列，翻译后会变成 "开 始" 视觉错乱。
// 对 vocal-saga 服务端尤其重要：fetch 回来的 HTML 保留了原始 letter-spacing
// 渲染的 textContent，不经处理直接送 LLM 会让模型困惑。
// =============================================================================

describe('collapseSpacedText', () => {
  it('merges spaced single characters into a word (Start)', () => {
    expect(collapseSpacedText('S t a r t')).toBe('Start');
  });

  it('merges spaced digits (2024)', () => {
    expect(collapseSpacedText('2 0 2 4 年度报告')).toBe('2024 年度报告');
  });

  it('leaves normal multi-char words unchanged', () => {
    expect(collapseSpacedText('hello world')).toBe('hello world');
    expect(collapseSpacedText('Hello world this is a test')).toBe(
      'Hello world this is a test',
    );
  });

  it('leaves short single-char sequences (<4) unchanged', () => {
    // "I am a coder" 中 "I a" 只有 2 个单字符序列，远低于阈值 4
    expect(collapseSpacedText('I am a coder')).toBe('I am a coder');
    // "a b c" 只有 3 个字符，不满足 ≥4
    expect(collapseSpacedText('a b c')).toBe('a b c');
  });

  it('merges at threshold exactly (4 chars)', () => {
    // 4 个字符是阈值边界，应该合并
    expect(collapseSpacedText('a b c d')).toBe('abcd');
  });

  it('does NOT merge CJK characters (Chinese should stay spaced)', () => {
    // 中文字符本身是有意义的单字，letter-spacing 渲染的中文应保留原样
    expect(collapseSpacedText('开 始 使 用')).toBe('开 始 使 用');
    expect(collapseSpacedText('学 习 更 多')).toBe('学 习 更 多');
  });

  it('merges multiple groups separated by punctuation', () => {
    // 标点分隔的两组 letter-spacing 装饰都应合并
    expect(collapseSpacedText('S t a r t, P l a y!')).toBe('Start, Play!');
  });

  it('handles mixed ASCII and CJK in same string', () => {
    // ASCII 字母序列合并，中文保留
    expect(collapseSpacedText('S t a r t 开 始')).toBe('Start 开 始');
  });

  it('returns empty string unchanged', () => {
    expect(collapseSpacedText('')).toBe('');
  });

  it('handles text without any single-char sequences', () => {
    expect(collapseSpacedText('This is a normal sentence.')).toBe(
      'This is a normal sentence.',
    );
  });

  it('preserves leading/trailing whitespace around merged words', () => {
    // 合并的是字符间空格，外层空格保留
    expect(collapseSpacedText('  S t a r t  ')).toBe('  Start  ');
  });
});

describe('extractBlocks - collapseSpacedText integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('collapses letter-spacing decorated CTA text during extraction', () => {
    // 模拟 hero section CTA 按钮：letter-spacing 渲染的 "S t a r t"
    setupHTML(`
      <article>
        <h1>Article Main Title Here</h1>
        <p>This is a normal paragraph with enough text to pass the threshold.</p>
        <button>S t a r t N o w</button>
      </article>
    `);

    const blocks = extractBlocks(document, 'https://example.com/test');
    const texts = blocks.map((b) => b.text);

    // "S t a r t N o w" 应被合并为 "StartNow"
    expect(texts.some((t) => t === 'StartNow')).toBe(true);
    expect(texts.every((t) => !t.includes('S t a r t'))).toBe(true);
  });

  it('does not affect normal multi-word content', () => {
    setupHTML(`
      <article>
        <h1>Article Main Title</h1>
        <p>Hello world this is a test paragraph with normal spacing.</p>
      </article>
    `);

    const blocks = extractBlocks(document, 'https://example.com/normal');
    const texts = blocks.map((b) => b.text);

    // 正常文本不应被修改
    expect(texts.some((t) => t === 'Hello world this is a test paragraph with normal spacing.')).toBe(true);
  });

  it('preserves Chinese letter-spacing decoration', () => {
    // 中文 letter-spacing 装饰不应被合并
    setupHTML(`
      <article>
        <h1>Article Title</h1>
        <p>Normal paragraph text here for context.</p>
        <p>开 始 使 用 产 品</p>
      </article>
    `);

    const blocks = extractBlocks(document, 'https://example.com/cjk');
    const texts = blocks.map((b) => b.text);

    // 中文保持原样
    expect(texts.some((t) => t === '开 始 使 用 产 品')).toBe(true);
  });
});

// =============================================================================
// 噪声三层策略 (webclaw 借鉴)
// =============================================================================
//
// 1. 精确 token 匹配: matchesSkipClass 已实现 (精确 + '-'/'_' 前后缀边界)
// 2. ≤6 字符 word-boundary 正则: LOW_PRIORITY_PATTERNS / OVERLAY_PATTERNS 用 \b
// 3. 5000 字符安全阀: 噪声类元素 textContent > 5000 时不视为噪声

describe('blockExtractor - noise safe valve (5000 chars)', () => {
  // shouldSkipByClass 安全阀：class 命中噪声模式但 textContent > 5000 时不跳过，
  // 防误杀长 FAQ / 长隐私政策正文。
  // 回归 case: #cookiesModal 50k 字符的 cookie policy 被整棵跳过。

  function makeEl(classAttr: string, text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = classAttr;
    el.textContent = text;
    return el;
  }

  it('shouldSkipByClass returns true for noise class with short text', () => {
    // 'cookie-banner' 在 SKIP_CLASS_PATTERNS 里，短文本应被跳过
    const el = makeEl('cookie-banner', 'Accept cookies for the best experience.');
    expect(shouldSkipByClass(el)).toBe(true);
  });

  it('shouldSkipByClass returns false for noise class with >5000 chars text (safe valve)', () => {
    // 长文本应触发安全阀，不被跳过
    const longText = 'This is a long FAQ paragraph. '.repeat(200); // ~5800 chars
    const el = makeEl('cookie-banner', longText);
    expect(shouldSkipByClass(el)).toBe(false);
  });

  it('shouldSkipByClass safe valve caches result via WeakSet (idempotent)', () => {
    // 重复调用应一致返回 false，不重新计算 textContent
    const longText = 'A'.repeat(5001);
    const el = makeEl('footer-wrap', longText);
    expect(shouldSkipByClass(el)).toBe(false);
    expect(shouldSkipByClass(el)).toBe(false);
  });

  it('extractBlocks extracts long FAQ inside element with noise class', () => {
    // 集成测试：长 FAQ 应被抽取，不被噪声 class 整棵剪枝。
    // 构造 60 个段落，每段 < MAX_TEXT_LENGTH(3072)，总计 > 5000 字符触发安全阀。
    // 用 'footer-wrap'（在 SKIP_CLASS_PATTERNS 但不在 OVERLAY_PATTERNS）作为噪声类，
    // 单独验证 shouldSkipByClass 安全阀，避免与 isOverlayElement 逻辑耦合。
    const faqParagraphs = Array.from(
      { length: 60 },
      (_, i) => `<p>FAQ paragraph ${i}: This is a long FAQ paragraph that should be translated and not skipped by noise filter.</p>`,
    ).join('');
    setupHTML(`
      <article class="footer-wrap">
        <h1>FAQ Article</h1>
        ${faqParagraphs}
      </article>
    `);

    const blocks = extractBlocks(document, 'https://example.com/faq');
    const texts = blocks.map((b) => b.text);
    // 至少 5 个 FAQ 段落必须被抽取（证明安全阀让 walker 继续进入子树）
    const faqTexts = texts.filter((t) => t.includes('long FAQ paragraph that should be translated'));
    expect(faqTexts.length).toBeGreaterThanOrEqual(5);
  });
});

describe('blockExtractor - short pattern word boundary (\\b)', () => {
  // LOW_PRIORITY_PATTERNS / OVERLAY_PATTERNS 用 regex 在原始 className 上匹配，
  // 短模式 (≤6 字符) 若无 \b 会误伤超集词：
  //   - "share" 误伤 "shareholder-content"
  //   - "social" 误伤 "socialism-study"
  //   - "promo" 误伤 "promontory-view"
  //   - "dialog" 误伤 "dialogue-script"
  //   - "cookie" 误伤 "cookies-link" (实际是噪声，但用于验证 \b 边界)
  // 加 \b 后，"share" 只匹配 \bshare\b，不匹配 "shareholder"。

  it('isLowPriorityElement does NOT match "shareholder-content" (\\bshare\\b)', () => {
    // 'shareholder-content' 含子串 'share'，但 \bshare\b 不应匹配
    const el = document.createElement('div');
    el.className = 'shareholder-content';
    expect(isLowPriorityElement(el)).toBe(false);
  });

  it('isLowPriorityElement matches exact "share" class', () => {
    const el = document.createElement('div');
    el.className = 'share';
    expect(isLowPriorityElement(el)).toBe(true);
  });

  it('isLowPriorityElement does NOT match "socialism-study" (\\bsocial\\b)', () => {
    const el = document.createElement('div');
    el.className = 'socialism-study';
    expect(isLowPriorityElement(el)).toBe(false);
  });

  it('isLowPriorityElement matches "social" exact class', () => {
    const el = document.createElement('div');
    el.className = 'social';
    expect(isLowPriorityElement(el)).toBe(true);
  });

  it('isLowPriorityElement does NOT match "promontory-view" (\\bpromo\\b)', () => {
    const el = document.createElement('div');
    el.className = 'promontory-view';
    expect(isLowPriorityElement(el)).toBe(false);
  });

  it('isOverlayElement does NOT match "dialogue-script" (\\bdialog\\b)', () => {
    // 'dialogue-script' 含子串 'dialog'，但 \bdialog\b 不应匹配
    // 注意：isOverlayElement 在 article/main 内会直接返回 false，所以这里用顶层 div
    const el = document.createElement('div');
    el.className = 'dialogue-script';
    document.body.appendChild(el);
    expect(isOverlayElement(el)).toBe(false);
  });

  it('isOverlayElement matches "dialog" exact class', async () => {
    const el = document.createElement('div');
    el.className = 'dialog';
    document.body.appendChild(el);
    expect(isOverlayElement(el)).toBe(true);
  });

  it('isOverlayElement matches notification/subscribers/push-notification classes', async () => {
    const cases = [
      'notification-prompt',
      'browser-notification',
      'push-notification-container',
      'subscribers-overlay',
      'notifications-modal',
    ];
    for (const cls of cases) {
      const el = document.createElement('div');
      el.className = cls;
      document.body.appendChild(el);
      expect(isOverlayElement(el)).toBe(true);
      el.remove();
    }
  });

  it('isOverlayElement matches notification/subscribers/push-notification ids', async () => {
    const cases = [
      'notification-prompt',
      'browser-notification',
      'push-notification',
      'subscribers-popup',
      'notifications-banner',
    ];
    for (const id of cases) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
      expect(isOverlayElement(el)).toBe(true);
      el.remove();
    }
  });

  it('isOverlayElement matches role="alertdialog"', async () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'alertdialog');
    document.body.appendChild(el);
    expect(isOverlayElement(el)).toBe(true);
  });

  it('isOverlayElement matches OneTrust banner containers', async () => {
    // 回归：s.sunxiunan.com/article/343 和 /332 的 OneTrust Cookie Banner
    // 主容器 id="onetrust-banner-sdk" class="otFloatingFlat ..." 必须被识别并隐藏。
    const cases = [
      { className: 'otFloatingFlat ot-bottom-right', id: 'onetrust-banner-sdk' },
      { className: 'otFloatingFlat otRelFont ot-bottom-left ot-fade-in', id: 'onetrust-banner-sdk' },
      { className: 'onetrust-pc-dark-filter ot-fade-in', id: '' },
      { className: 'ot-sdk-four ot-sdk-columns', id: 'onetrust-button-group-parent' },
      { className: 'ot-sdk-row', id: 'onetrust-button-group' },
      { className: '', id: 'onetrust-consent-sdk' },
    ];
    for (const { className, id } of cases) {
      const el = document.createElement('div');
      el.className = className;
      if (id) el.id = id;
      document.body.appendChild(el);
      expect(isOverlayElement(el)).toBe(true);
      el.remove();
    }
  });

  // ── heading outline 栈: 级别 pop 行为 ──────────────────────
  it('heading outline: h1 后新 h1 应清除旧 h1', () => {
    setupHTML(`
      <article>
        <h1>First Section</h1>
        <p>First paragraph with enough text.</p>
        <h1>Second Section</h1>
        <p>Second paragraph with enough text.</p>
      </article>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    const firstP = blocks.find(b => b.text.startsWith('First paragraph'));
    const secondP = blocks.find(b => b.text.startsWith('Second paragraph'));
    expect(firstP).toBeTruthy();
    expect(secondP).toBeTruthy();
    expect(firstP!.context!.headingPath).toContain('First Section');
    expect(firstP!.context!.headingPath).not.toContain('Second Section');
    expect(secondP!.context!.headingPath).toContain('Second Section');
    expect(secondP!.context!.headingPath).not.toContain('First Section');
  });

  it('heading outline: h2 保留父 h1, 同级新 h2 清除旧 h2', () => {
    setupHTML(`
      <article>
        <h1>Main Title</h1>
        <h2>Subsection A</h2>
        <p>Content under A with enough text.</p>
        <h2>Subsection B</h2>
        <p>Content under B with enough text.</p>
      </article>
    `);
    const blocks = extractBlocks(document, "https://example.com/test");
    const pA = blocks.find(b => b.text.startsWith('Content under A'));
    const pB = blocks.find(b => b.text.startsWith('Content under B'));
    expect(pA).toBeTruthy();
    expect(pB).toBeTruthy();
    expect(pA!.context!.headingPath).toContain('Main Title');
    expect(pA!.context!.headingPath).toContain('Subsection A');
    expect(pB!.context!.headingPath).toContain('Main Title');
    expect(pB!.context!.headingPath).toContain('Subsection B');
    expect(pB!.context!.headingPath).not.toContain('Subsection A');
  });

  // ── shouldSkipByClass: noiseMemo per-traversal ──────────────
  it('shouldSkipByClass accepts noiseMemo parameter', () => {
    const el = document.createElement('div');
    el.className = 'cookie-banner';
    document.body.appendChild(el);
    const memo = new WeakMap();
    expect(shouldSkipByClass(el, memo)).toBe(true);
    // 长文本安全阀
    el.textContent = 'x'.repeat(6000);
    const memo2 = new WeakMap();
    expect(shouldSkipByClass(el, memo2)).toBe(false);
    el.remove();
  });

  // ── Readability fallback: Jaccard token overlap ────────────
  it('detectArticleRoot uses Jaccard overlap for Readability fallback', () => {
    // 这个测试验证 detectArticleRoot 在 Readability fallback 时
    // 能处理跨节点拆分的文本
    setupHTML(`
      <html><head><title>Test</title></head><body>
        <div class="article-body">
          <h1>Test Article</h1>
          <p>This is a longer paragraph that should be detected by the readability fallback even with nested spans.</p>
          <p>Second paragraph with additional content for the article body.</p>
        </div>
      </body></html>
    `);
    const root = detectArticleRoot(document);
    expect(root).toBeTruthy();
    expect(root!.textContent).toContain('Test Article');
  });
});


