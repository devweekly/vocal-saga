import { describe, it, expect, beforeEach } from 'vitest';
import { prepareDocument, extractFromDataIsland } from '../lib/translate/contentHelper';

function setupHTML(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

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

  it('should reach main.page_main through 7-layer nesting (claude.com real structure)', () => {
    // claude.com 真实 DOM：.u-rich-text-blog 到 main.page_main 有 7 层嵌套，
    // h1 在兄弟 section.hero_blog_post_wrap 内。
    // chooseBestRoot 必须向上扫描到含 h1 的 main.page_main，而非停在 3 层内的 .blog_post_wrap。
    document.body.innerHTML = `
      <main class="page_main">
        <section class="hero_blog_post_wrap u-section">
          <div class="hero_stories_heading_wrap">
            <h1>The advisor strategy: Give agents an intelligence boost</h1>
            <p>Pair Opus as an advisor with Sonnet or Haiku as an executor, and get near Opus-level intelligence in your agents at a fraction of the cost.</p>
          </div>
        </section>
        <section class="blog_post_section_wrap u-section u-zindex-2">
          <div class="blog_post_contain u-container">
            <div class="blog_post_component">
              <div class="blog_post_wrap u-grid-custom">
                <div class="blog_post_layout u-column-custom">
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
        <section class="blog_related_section_wrap u-section">
          <p>Related article link that should be filtered</p>
        </section>
      </main>
    `;

    const { fullText } = prepareDocument(document, 'https://claude.com/blog/the-advisor-strategy');

    // h1 标题必须进入翻译（在 hero section，不在 .u-rich-text-blog 内）
    expect(fullText).toContain('The advisor strategy');
    // 导语（第一段）必须进入翻译
    expect(fullText).toContain('Pair Opus as an advisor');
    // 正文也进入翻译
    expect(fullText).toContain('After cataloging');
    // 相关文章 class 是 LOW_PRIORITY（降权）非 SKIP，不在此断言范围
  });

  it('should keep <article> with h1 via h1 guard (openai.com real structure)', () => {
    // openai.com 真实 DOM：<article> 用 Tailwind CSS（class 含 @md:gap-16 等），
    // article 自带 h1。h1 守卫应直接返回 article，无需向上评分。
    // Tailwind class 的 : 和 [ 不应干扰选择。
    document.body.innerHTML = `
      <main class="@container relative z-1 outline-none">
        <article class="flex min-w-0 flex-col gap-12 @md:gap-16 mt-10">
          <div class="relative z-10 flex w-full flex-col gap-5 md:gap-6">
            <h1 class="text-h2 text-white-100 w-full text-balance">Introducing Sora</h1>
            <p>All videos on this page are directly generated by Sora without modification.</p>
          </div>
          <div class="prose prose-invert max-w-none">
            <p>Sora is a text-to-video model that understands the physical world in motion.</p>
            <p>It can create videos up to a minute long with high visual quality.</p>
            <h2>Capabilities</h2>
            <p>The model can generate complex scenes with multiple characters.</p>
          </div>
        </article>
      </main>
    `;

    const { fullText } = prepareDocument(document, 'https://openai.com/blog/sora/');

    // h1 标题进入翻译（h1 守卫保留 article）
    expect(fullText).toContain('Introducing Sora');
    // 导语进入翻译
    expect(fullText).toContain('directly generated by Sora');
    // 正文进入翻译
    expect(fullText).toContain('text-to-video model');
    expect(fullText).toContain('complex scenes');
  });

  it('should reach container with h1 when article.prose lacks h1 (tailwindcss.com real structure)', () => {
    // tailwindcss.com 真实 DOM：<article class="prose prose-blog"> 有正文但无 h1，
    // h1 在外的 hero div。article 和 h1 同在 DIV.grid 内。
    // chooseBestRoot 应向上找到含 h1 的 DIV.grid（类似 claude.com 但层级浅）。
    document.body.innerHTML = `
      <div class="text-gray-950 dark:text-white">
        <div class="grid grid-cols-1 xl:grid-cols-[22rem_2.5rem_auto]">
          <div class="mb-6 px-4 lg:px-2 xl:mb-16 relative">
            <h1 class="inline-block max-w-(--breakpoint-md) text-[2.5rem]">Tailwind CSS v4.0</h1>
          </div>
          <article class="prose prose-blog max-w-(--breakpoint-md)">
            <p>Holy shit it's actually done — we just tagged Tailwind CSS v4.0.</p>
            <p>This is the first major version of Tailwind CSS since the initial release.</p>
            <h2>What's new</h2>
            <p>A new high-performance build engine.</p>
            <p>Updated design tokens and CSS-first configuration.</p>
          </article>
        </div>
      </div>
    `;

    const { fullText } = prepareDocument(document, 'https://tailwindcss.com/blog/tailwindcss-v4');

    // h1 标题进入翻译（在 article 外，chooseBestRoot 向上找到含 h1 的 container）
    expect(fullText).toContain('Tailwind CSS v4.0');
    // 正文进入翻译
    expect(fullText).toContain("Holy shit it's actually done");
    expect(fullText).toContain('high-performance build engine');
  });

  it('should expand to include h1 title outside .entry-content (towardsdatascience-style)', () => {
    // towardsdatascience.com: .entry-content 不含标题，标题在 <main> 内但不在 .entry-content 内
    document.body.innerHTML = `
      <main class="wp-block-group">
        <div class="wp-block-group">
          <a href="/category">LLM Applications</a>
        </div>
        <h1 class="wp-block-post-title">When PyMuPDF Can't See the Table</h1>
        <div class="wp-block-tds-post-sub-heading">
          <p>Enterprise Document Intelligence [Vol.1 #5bis]</p>
        </div>
        <div class="entry-content wp-block-post-content">
          <p>This article is a parsing companion in Enterprise Document Intelligence.</p>
          <p>PyMuPDF (fitz) is fast, free, and exact on clean prose.</p>
        </div>
      </main>
    `;

    const { blocks, fullText } = prepareDocument(document, "https://towardsdatascience.com/test");

    // 标题应该被提取
    const titleBlock = blocks.find(b => b.tag === 'h1' && b.text.includes('PyMuPDF'));
    expect(titleBlock).toBeDefined();
    expect(titleBlock!.text).toContain('When PyMuPDF');

    // 副标题应该被提取
    const subtitleBlock = blocks.find(b => b.text.includes('Enterprise Document Intelligence'));
    expect(subtitleBlock).toBeDefined();

    // 正文应该被提取
    expect(fullText).toContain('parsing companion');
    expect(fullText).toContain('PyMuPDF (fitz)');
  });
});

// =============================================================================
// L3 兜底：L1/L2 都失败时直接遍历 body 抓取所有 TextNode
// =============================================================================

describe('L3 fallback (findArticleRootL3)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('L1/L2 fail on hostile class names → L3 extracts via walker', () => {
    // 场景：class 同时含正文+负向 token，detector 拒绝，
    // ARTICLE_SELECTORS 也不命中，但 walker 仍能抓出 <p>/<h2> 文本。
    // 这是搜索结果页 / 评论流 / 无主文章容器的典型场景。
    // 文本故意做短（每个 wrapper < 50 chars）以确保 Text Density < 300。
    document.body.innerHTML = `
      <header>Site Header Navigation</header>
      <div class="article-nav">
        <h2>Result One</h2>
        <p>First short text.</p>
      </div>
      <div class="article-nav">
        <h2>Result Two</h2>
        <p>Second short text.</p>
      </div>
      <footer>Site Footer Copyright</footer>
    `;

    const { blocks, fullText } = prepareDocument(document, "https://example.com/results");

    // 验证 walker 在 L3 模式下抓到了内容（不依赖 L1/L2 的容器识别）
    expect(blocks.length).toBeGreaterThan(0);
    expect(fullText).toContain('Result One');
    expect(fullText).toContain('Result Two');

    // walker 的噪声过滤仍然生效
    expect(fullText).not.toContain('Site Header Navigation');
    expect(fullText).not.toContain('Site Footer Copyright');
  });

  it('L3 handles page with only loose <p> tags (no container)', () => {
    // 极端场景：body 直接是游离 <p>，没有 div 包装
    // L1 失败（无 article / main），L2 失败（短文 Text Density < 300）
    // L3 应该用 body 作 root，walker 抓出所有 <p>
    document.body.innerHTML = `
      <p>Result one short.</p>
      <p>Result two short.</p>
      <p>Result three short.</p>
    `;

    const { blocks, fullText } = prepareDocument(document, "https://example.com/loose");

    expect(blocks.length).toBeGreaterThan(0);
    expect(fullText).toContain('Result one');
    expect(fullText).toContain('Result two');
    expect(fullText).toContain('Result three');
  });

  it('L3 returns body element (verify the fallback path explicitly)', async () => {
    const { findArticleRootL3 } = await import('../lib/translate/contentHelper');

    document.body.innerHTML = `<p>Some body content here for L3 to detect and return properly.</p>`;
    const root = findArticleRootL3(document);
    expect(root).toBe(document.body);
  });

  it('L3 throws when no body or documentElement exists', async () => {
    const { findArticleRootL3 } = await import('../lib/translate/contentHelper');
    // Mock a minimal document-like object with neither body nor documentElement
    const fakeDoc = {} as Document;
    expect(() => findArticleRootL3(fakeDoc)).toThrow('L3 fallback failed');
  });
});

// =============================================================================
// Data Island fallback —— SPA 站点（Next.js / Nuxt / SvelteKit）首屏 DOM 是
// 骨架，正文塞在 __NEXT_DATA__ / __NUXT_DATA__ / application/json 里。
// 这些测试覆盖 extractFromDataIsland 的核心路径 + prepareDocument 集成。
// 对 vocal-saga 服务端尤其重要：fetch 拿到的初始 HTML 通常 DOM 是骨架，
// 客户端 hydrate 之前 walker 抓不到任何块。
// =============================================================================

describe('extractFromDataIsland', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('extracts article body from __NEXT_DATA__', () => {
    const articleBody =
      'This is a long article body that should be extracted from Next.js __NEXT_DATA__ script tag when DOM is empty skeleton.';
    document.body.innerHTML = `
      <div id="__next"></div>
      <script id="__NEXT_DATA__" type="application/json">
        ${JSON.stringify({
          props: { pageProps: { article: { articleBody } } },
        })}
      </script>
    `;

    const blocks = extractFromDataIsland(document);

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.text === articleBody)).toBe(true);
    expect(blocks.every((b) => b.xpath.startsWith('/data-island/'))).toBe(true);
  });

  it('extracts content from __NUXT_DATA__', () => {
    const content =
      'This is long content from Nuxt SSR payload that should be picked up when DOM skeleton is empty after hydration.';
    document.body.innerHTML = `
      <div id="__nuxt"></div>
      <script id="__NUXT_DATA__" type="application/json">
        ${JSON.stringify({ state: { content }, url: '/some-path' })}
      </script>
    `;

    const blocks = extractFromDataIsland(document);

    expect(blocks.some((b) => b.text === content)).toBe(true);
  });

  it('extracts from generic application/json script', () => {
    const text =
      'Generic application/json script with long content that should be picked up as data island fallback.';
    document.body.innerHTML = `
      <script type="application/json">${JSON.stringify({ body: text })}</script>
    `;

    const blocks = extractFromDataIsland(document);

    expect(blocks.some((b) => b.text === text)).toBe(true);
  });

  it('does not double-count __NEXT_DATA__ as generic application/json', () => {
    // __NEXT_DATA__ 也是 type="application/json"，但已在优先级 1 收集，
    // 通用扫描时应跳过，避免重复提取。
    const body =
      'Content in __NEXT_DATA__ should not be extracted twice when scanning generic application/json scripts.';
    document.body.innerHTML = `
      <script id="__NEXT_DATA__" type="application/json">
        ${JSON.stringify({ props: { articleBody: body } })}
      </script>
    `;

    const blocks = extractFromDataIsland(document);
    const matches = blocks.filter((b) => b.text === body);

    expect(matches.length).toBe(1);
  });

  it('skips metadata fields (url/href/src/type/name)', () => {
    document.body.innerHTML = `
      <script id="__NEXT_DATA__" type="application/json">
        ${JSON.stringify({
          url: 'https://example.com/very-long-url-that-should-not-be-extracted-as-content',
          href: 'https://example.com/another-long-href-that-should-be-skipped-as-metadata',
          name: 'Some name field that is long enough but should be skipped because it is metadata',
          type: 'article-type-field-that-is-long-enough-but-should-be-skipped',
          articleBody: 'This is the real article body that should be extracted as content.',
        })}
      </script>
    `;

    const blocks = extractFromDataIsland(document);
    const texts = blocks.map((b) => b.text);

    expect(texts.some((t) => t.includes('real article body'))).toBe(true);
    expect(texts.every((t) => !t.includes('very-long-url'))).toBe(true);
    expect(texts.every((t) => !t.includes('another-long-href'))).toBe(true);
    expect(texts.every((t) => !t.includes('article-type-field'))).toBe(true);
    expect(texts.every((t) => !t.includes('Some name field'))).toBe(true);
  });

  it('extracts priority fields regardless of length (description/summary)', () => {
    // description / summary 是优先字段，短文本也采集
    document.body.innerHTML = `
      <script id="__NEXT_DATA__" type="application/json">
        ${JSON.stringify({
          description: 'Short desc.',
          summary: 'Tiny summary.',
          articleBody:
            'Long body content exceeding fifty characters threshold for normal fields.',
        })}
      </script>
    `;

    const blocks = extractFromDataIsland(document);
    const texts = blocks.map((b) => b.text);

    expect(texts).toContain('Short desc.');
    expect(texts).toContain('Tiny summary.');
  });

  it('filters short non-priority strings (<50 chars)', () => {
    document.body.innerHTML = `
      <script id="__NEXT_DATA__" type="application/json">
        ${JSON.stringify({
          customField: 'Short text under 50 chars threshold',
          articleBody:
            'Long body content exceeding fifty characters threshold for normal fields.',
        })}
      </script>
    `;

    const blocks = extractFromDataIsland(document);
    const texts = blocks.map((b) => b.text);

    expect(texts.every((t) => !t.includes('Short text under 50'))).toBe(true);
  });

  it('deduplicates identical strings', () => {
    const dup =
      'This is a long duplicated string that appears in multiple fields and should only be extracted once.';
    document.body.innerHTML = `
      <script id="__NEXT_DATA__" type="application/json">
        ${JSON.stringify({ field1: dup, field2: dup, field3: dup })}
      </script>
    `;

    const blocks = extractFromDataIsland(document);
    const matches = blocks.filter((b) => b.text === dup);

    expect(matches.length).toBe(1);
  });

  it('silently skips invalid JSON', () => {
    document.body.innerHTML = `
      <script id="__NEXT_DATA__" type="application/json">
        not-valid-json {{{{ broken
      </script>
      <script type="application/json">{"articleBody": "Valid JSON content that is long enough to pass threshold check."}</script>
    `;

    const blocks = extractFromDataIsland(document);

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.text.includes('Valid JSON content'))).toBe(true);
  });

  it('returns empty array when no data island scripts exist', () => {
    document.body.innerHTML = `<div>no script tags here</div>`;

    const blocks = extractFromDataIsland(document);

    expect(blocks).toEqual([]);
  });

  it('returns TextBlock with id/xpath/tag fields', () => {
    document.body.innerHTML = `
      <script id="__NEXT_DATA__" type="application/json">
        ${JSON.stringify({
          articleBody:
            'Long article body content exceeding fifty chars for proper extraction.',
        })}
      </script>
    `;

    const blocks = extractFromDataIsland(document);

    expect(blocks.length).toBeGreaterThan(0);
    const first = blocks[0];
    expect(first.id).toMatch(/^data-island-\d+$/);
    expect(first.xpath).toMatch(/^\/data-island\/\d+$/);
    expect(first.tag).toBe('p');
    expect(typeof first.text).toBe('string');
  });
});

describe('prepareDocument data island integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('falls back to data island when DOM is empty skeleton', () => {
    // SPA 首屏：DOM 是空骨架，正文全在 __NEXT_DATA__
    const articleBody =
      'This is a long article body that lives only in __NEXT_DATA__ and is not rendered to DOM skeleton.';
    document.body.innerHTML = `
      <div id="__next"></div>
      <script id="__NEXT_DATA__" type="application/json">
        ${JSON.stringify({ props: { pageProps: { articleBody } } })}
      </script>
    `;

    const { blocks, fullText } = prepareDocument(document, 'https://example.com/spa');

    expect(blocks.length).toBeGreaterThan(0);
    expect(fullText).toContain(articleBody);
    expect(blocks.every((b) => b.xpath.startsWith('/data-island/'))).toBe(true);
  });

  it('does NOT trigger data island when DOM has content', () => {
    // DOM 有内容时正常走 DOM 提取，不读 data island
    const domContent = 'This is DOM-rendered content that should be extracted normally.';
    const islandContent =
      'This is data island content that should NOT be extracted when DOM has content.';
    document.body.innerHTML = `
      <article>
        <h1>Real Article</h1>
        <p>${domContent}</p>
      </article>
      <script id="__NEXT_DATA__" type="application/json">
        ${JSON.stringify({ props: { articleBody: islandContent } })}
      </script>
    `;

    const { fullText } = prepareDocument(document, 'https://example.com/normal');

    expect(fullText).toContain(domContent);
    expect(fullText).not.toContain(islandContent);
  });

  // ── ExtractionReport ─────────────────────────────────────
  it('prepareDocument returns ExtractionReport with confidence', () => {
    setupHTML(`
      <article>
        <h1>Test Article</h1>
        <p>This is a paragraph with enough text for translation testing purposes.</p>
        <p>Another paragraph with sufficient content for the extraction pipeline.</p>
      </article>
    `);
    const result = prepareDocument(document, "https://example.com/test");
    expect(result.report).toBeTruthy();
    expect(result.report.blockCount).toBeGreaterThanOrEqual(2);
    expect(result.report.confidence).toBeGreaterThan(0);
    expect(result.report.textLength).toBeGreaterThan(0);
    expect(['selector', 'heuristic', 'readability', 'data-island', 'body-fallback']).toContain(result.report.strategy);
  });

  // ── hasArticleLikeHeading: 短文本 h1 不停止向上扫描 ──────────
  it('chooseBestRoot does not stop at short h1 (e.g. "Home")', () => {
    setupHTML(`
      <header><h1>Home</h1></header>
      <main>
        <article>
          <h1>This is a Long Article Title</h1>
          <p>This is the real article body with enough text.</p>
        </article>
      </main>
    `);
    const result = prepareDocument(document, "https://example.com/test");
    // 确保正文被翻译, 不因 header 里的 <h1>Home</h1> 停止
    expect(result.fullText).toContain('real article body');
  });

  // ── Block merge: 相邻 inline 块合并 ────────────────────────
  it('mergeInlineBlocks combines adjacent short inline candidates', () => {
    setupHTML(`
      <article>
        <p>This is <strong>important</strong> text with enough content.</p>
      </article>
    `);
    const result = prepareDocument(document, "https://example.com/test");
    // 如果产生了多个 inline 候选, 它们应该被合并
    // 确保翻译文本完整
    expect(result.fullText).toContain('important');
  });
});
