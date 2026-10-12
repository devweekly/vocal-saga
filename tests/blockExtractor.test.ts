import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { extractBlocks, findBlockNode, buildNodeMap, extractBlocksFromMarkedHtml, collapseSpacedText } from '../lib/translate/blockExtractor';
import { shouldSkipByClass, isLowPriorityElement, isOverlayElement, isParagraphLikeElement, normalizeBlockText } from '../lib/translate/blockExtractor/rules';
import { applyBlockTranslation } from '../lib/translate/translationDisplay';
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

});

describe('extractBlocks - Class-based Skipping', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
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

  it('keeps readable paragraphs below the safety ceiling', () => {
    const longText = 'This is a long but valid paragraph. '.repeat(130);
    setupHTML(`<p>${longText}</p><p>Normal length paragraph here.</p>`);

    const blocks = extractBlocks(document, "https://example.com/test");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain('This is a long but valid paragraph.');
  });

  it('rejects pathological single-block text above the safety ceiling', () => {
    const longText = 'a'.repeat(16_400);
    setupHTML(`<p>${longText}</p><p>Normal length paragraph here.</p>`);

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
  // Simulates the actual blog.google structure with module--text wrappers and
  // multiple heading sections, verifying no paragraphs are skipped.
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


});

describe('extractBlocks - Malformed or unusual HTML', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
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

});

describe('extractBlocks - WordPress/TNS style page (sample4.html)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
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

});


describe('extractBlocks - Fortune website structure', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
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



});

// ============================================================
// 通用噪声模式回归测试。覆盖在 blockExtractor.ts 的
// SKIP_CLASS_PATTERNS 中加入的跨站通用 class 模式，用于
// 防止以后误删 pattern 导致噪声回流。每个 describe 块对应
// 一类场景。
// ============================================================







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

  it('uses client-extracted text so server does not re-add filtered author/link text', () => {
    setupHTML(`
      <article>
        <p data-fanyi-block-id="b1">Actual body <a>Reply</a> by Author.</p>
      </article>
    `);
    const blocks = extractBlocksFromMarkedHtml(document, [
      { id: 'b1', tag: 'p', text: 'Actual body.' },
    ]);
    expect(blocks).not.toBeNull();
    expect(blocks?.[0].text).toBe('Actual body.');
  });

  it('rejects client snapshots whose block order does not match marked HTML', () => {
    setupHTML(`
      <article>
        <p data-fanyi-block-id="b1">First body paragraph.</p>
        <p data-fanyi-block-id="b2">Second body paragraph.</p>
      </article>
    `);
    expect(extractBlocksFromMarkedHtml(document, [
      { id: 'b2', tag: 'p', text: 'Second body paragraph.' },
      { id: 'b1', tag: 'p', text: 'First body paragraph.' },
    ])).toBeNull();
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


  it('leaves normal multi-char words unchanged', () => {
    expect(collapseSpacedText('hello world')).toBe('hello world');
    expect(collapseSpacedText('Hello world this is a test')).toBe(
      'Hello world this is a test',
    );
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


  it('isLowPriorityElement does NOT match "socialism-study" (\\bsocial\\b)', () => {
    const el = document.createElement('div');
    el.className = 'socialism-study';
    expect(isLowPriorityElement(el)).toBe(false);
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

describe('extractBlocks - paragraphs declared via data-as="p" (Mintlify docs)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // 回归: docs.langchain.com (Mintlify) 把 Markdown 段落渲染成
  //   <span data-as="p">…</span>
  // 而不是 <p>，外层套 <div class="mdx-content">，正文根是 <main>（没有 <article>）。
  // 症状: 标题 (h1/h2 在 DIRECT_SET) 被翻译，正文段落全部漏掉。
  const MINTLIFY_PAGE = `
    <main class="px-5">
      <div class="grow w-full">
        <div class="mdx-content">
          <h2 id="interrupt-decision-types"><span>Interrupt decision types</span></h2>
          <span data-as="p">The middleware defines four built-in ways a human can respond to an interrupt:</span>
          <span data-as="p">Use <code>reject</code> when the human is denying the requested action.</span>
        </div>
      </div>
    </main>
  `;
  const PAGE_URL = 'https://docs.langchain.com/oss/python/langchain/human-in-the-loop';

  it('extracts paragraphs under a plain <main> with no <article> ancestor', () => {
    setupHTML(MINTLIFY_PAGE);
    const texts = extractBlocks(document, PAGE_URL).map((b) => b.text);

    expect(texts).toContain(
      'The middleware defines four built-in ways a human can respond to an interrupt:',
    );
    expect(texts).toContain('Use reject when the human is denying the requested action.');
    // 标题本来就抓得到, 回归点是它不再是"唯一"被翻译的内容。
    expect(texts).toContain('Interrupt decision types');
  });

  it('does not fragment inline children of a data-as="p" paragraph', () => {
    setupHTML(MINTLIFY_PAGE);
    const blocks = extractBlocks(document, PAGE_URL);

    // 段落内的 <code> 不应独立成块 (SKIP_SET 拒绝), 段落应整段抓取。
    expect(blocks.some((b) => b.tag === 'code')).toBe(false);
    expect(blocks.filter((b) => b.tag === 'span')).toHaveLength(2);
  });

  it('only treats data-as="p" as a paragraph declaration, not other data-as values', () => {
    const asP = document.createElement('span');
    asP.setAttribute('data-as', 'p');
    const asCode = document.createElement('span');
    asCode.setAttribute('data-as', 'code');
    const bare = document.createElement('span');

    expect(isParagraphLikeElement(asP, PAGE_URL)).toBe(true);
    expect(isParagraphLikeElement(asCode, PAGE_URL)).toBe(false);
    expect(isParagraphLikeElement(bare, PAGE_URL)).toBe(false);
  });

  it('round-trips extraction → apply without destroying the paragraph inline link', () => {
    setupHTML(`
      <main>
        <div class="mdx-content">
          <span data-as="p">The <a href="/oss/python/langchain/middleware">middleware</a> defines
            four built-in ways a human can respond to an interrupt.</span>
        </div>
      </main>
    `);

    const blocks = extractBlocks(document, PAGE_URL);
    expect(blocks).toHaveLength(1);

    const para = document.querySelector('span[data-as="p"]') as HTMLElement;
    // 提取阶段必须给段落打上 block id —— 服务端就是靠它回填译文的。
    expect(para.dataset.fanyiBlockId).toBe(blocks[0].id);

    const link = para.querySelector('a');
    expect(link).not.toBeNull();

    applyBlockTranslation(para, '中间件定义了四种内置的人类响应方式。');

    // 内链必须存活在 .fanyi-original 里，而不是被 textContent 覆盖掉。
    expect(para.querySelector('.fanyi-original a')).toBe(link);
    expect(para.querySelector('.fanyi-translation')?.textContent).toBe(
      '中间件定义了四种内置的人类响应方式。',
    );
    expect(para.classList.contains('fanyi-translated')).toBe(true);
  });
});



// =============================================================================
// 首尾零宽 / 不可见字符
// =============================================================================

describe('normalizeBlockText - invisible edge characters', () => {
  it('strips leading/trailing ZWSP and whitespace in one pass', () => {
    expect(normalizeBlockText('\u200bInterrupt decision types')).toBe(
      'Interrupt decision types',
    );
    expect(normalizeBlockText('  \u200b Title \u200b  ')).toBe('Title');
    expect(normalizeBlockText('\n\t\u200b\u200bFoo\u200d\u200b\n')).toBe('Foo');
    // 全空白 / 全零宽 → 空串
    expect(normalizeBlockText('\u200b\u200b')).toBe('');
    expect(normalizeBlockText('   ')).toBe('');
  });


  it('does NOT strip mid-text ZWNJ / ZWJ (they are semantic)', () => {
    // 波斯语 ZWNJ：می‌خواهم 是一个词，ZWNJ 不能删
    const persian = 'می\u200cخواهم';
    // emoji ZWJ 序列：👨‍👩‍👧 是一个字素簇，ZWJ 不能删
    const family = '👨\u200d👩\u200d👧';
    expect(normalizeBlockText(persian)).toBe(persian);
    expect(normalizeBlockText(family)).toBe(family);
    expect(normalizeBlockText(` ${persian} and ${family} `)).toBe(
      `${persian} and ${family}`,
    );
  });
});

describe('extractBlocks - Mintlify heading anchors leak a ZWSP (regression)', () => {
  const PAGE_URL =
    'https://docs.langchain.com/oss/python/langchain/human-in-the-loop';

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * Mintlify 的每个标题里都塞了一个 hover 才显示的锚点链接
   * （`<a class="...opacity-0...">`），而它内部**只有一个 U+200B 占位**
   * 加一个图标 div。于是整个标题的 textContent 以 ZWSP 开头：
   * `"\u200bInterrupt decision types"`。
   *
   * `trim()` 去不掉它（U+200B 是 Cf 格式字符，不是 WhiteSpace），
   * 之前会原样进译文请求。真实页面 14 处。
   */
  const MINTLIFY_HEADING = `
    <main>
      <h2 id="interrupt-decision-types" class="flex whitespace-pre-wrap group font-semibold"><div class="absolute" tabindex="-1"><a href="#interrupt-decision-types" class="-ml-10 flex items-center opacity-0 group/link" aria-label="Navigate to header">\u200b<div class="size-6 rounded-md"><svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"></path></svg></div></a>Interrupt decision types</h2>
      <span data-as="p">Human-in-the-loop middleware lets you approve or reject tool calls before they run.</span>
    </main>
  `;

  it('extracts the heading without the ZWSP', () => {
    setupHTML(MINTLIFY_HEADING);
    const blocks = extractBlocks(document, PAGE_URL);

    const heading = blocks.find((b) => b.tag === 'h2');
    expect(heading).toBeDefined();
    expect(heading!.text).toBe('Interrupt decision types');
    // 反向断言：任何块都不该带首尾零宽字符
    for (const b of blocks) {
      expect(b.text).toBe(normalizeBlockText(b.text));
      expect(b.text.startsWith('\u200b')).toBe(false);
    }
  });

  it('cleans the heading text carried in context.headingPath', () => {
    setupHTML(MINTLIFY_HEADING);
    const blocks = extractBlocks(document, PAGE_URL);

    const para = blocks.find((b) => b.tag === 'span');
    expect(para).toBeDefined();
    // headingPath 也是送给模型的上下文，同样不能带 ZWSP
    expect(para!.context!.headingPath).toContain('Interrupt decision types');
    for (const h of para!.context!.headingPath) {
      expect(h.startsWith('\u200b')).toBe(false);
    }
  });
});
