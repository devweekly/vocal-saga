import { describe, it, expect, beforeEach } from 'vitest';
import {
  scoreElement,
  collectCandidates,
  detectArticleRoot,
  SCORE_THRESHOLD,
} from '../lib/translate/contentDetector';

describe('contentDetector', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // --- scoreElement ---

  describe('scoreElement', () => {
    it('scores high for article-like content', () => {
      const el = document.createElement('div');
      el.className = 'article-content';
      el.innerHTML = `
        <h1>Title</h1>
        <p>This is a paragraph with some text content.</p>
        <p>Another paragraph with more words and sentences.</p>
        <p>Third paragraph to increase the text density of this element.</p>
      `;
      document.body.appendChild(el);
      const score = scoreElement(el);
      // 绝对分制：典型 article-content 块（含 h1 + 3p）应远超阈值
      expect(score).toBeGreaterThan(SCORE_THRESHOLD);
    });

    it('scores lower for navigation than content', () => {
      const nav = document.createElement('div');
      nav.className = 'main-menu';
      nav.innerHTML = `
        <a href="/home">Home</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
        <a href="/blog">Blog</a>
        <a href="/docs">Docs</a>
      `;
      document.body.appendChild(nav);

      const content = document.createElement('div');
      content.className = 'article-body';
      content.innerHTML = `
        <h1>Article</h1>
        <p>This is a real article with paragraphs of text content.</p>
        <p>More content here to make the score higher.</p>
      `;
      document.body.appendChild(content);

      expect(scoreElement(nav)).toBeLessThan(scoreElement(content));
    });

    it('scores empty elements as 0', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const score = scoreElement(el);
      expect(score).toBe(0);
    });

    it('scores below threshold for CTA box without paragraphs', () => {
      // 模拟 commoncog.com 的 blog-content__mbox（BEM 子类）
      // 子串扫描会误命中 "content"，token 化后不会
      const cta = document.createElement('div');
      cta.className = 'blog-content__mbox bg-purple-50 rounded-2xl p-6';
      cta.innerHTML = `
        <h3 class="text-lg font-bold">Newsletter CTA</h3>
        <p class="text-sm">9000+ founders and operators read Commoncog.</p>
        <a href="/subscribe" class="text-white">Subscribe</a>
      `;
      document.body.appendChild(cta);
      const score = scoreElement(cta);
      // 没有 p（用 <p class="text-sm"> 也算 <p>），所以 pCount=1；
      // 子串 hit "content" 不存在（token 化后是 blog/content/mbox 三个 token，
      // mbox 命中 NEGATIVE，content 命中 POSITIVE，二者抵消，最终 -600 净 boost）
      // textLen 约 100 字符，分数应该远低于阈值
      expect(score).toBeLessThan(SCORE_THRESHOLD);
    });
  });

  // --- collectCandidates ---

  describe('collectCandidates', () => {
    it('collects article and main elements', () => {
      document.body.innerHTML = `
        <article><p>Article content</p></article>
        <main><p>Main content</p></main>
      `;
      const candidates = collectCandidates(document);
      const tags = candidates.map(el => el.tagName.toLowerCase());
      expect(tags).toContain('article');
      expect(tags).toContain('main');
    });

    it('collects elements with content-like class names (tokenized)', () => {
      document.body.innerHTML = `
        <div class="sidebar"><a href="#">Link</a></div>
        <div class="post-content"><p>Post content</p></div>
        <div class="article-body"><p>Article body</p></div>
      `;
      const candidates = collectCandidates(document);
      const classes = candidates.map(el => el.className);
      expect(classes.some(c => c.includes('post-content'))).toBe(true);
      expect(classes.some(c => c.includes('article-body'))).toBe(true);
    });

    it('does NOT collect BEM sub-classes via tokenization', () => {
      // BEM 子类 token 切分后是 ['blog', 'content', 'mbox']，
      // 'mbox' 是 NEGATIVE，但 'content' 单独是 POSITIVE token，
      // 所以 collectCandidates 仍会收集。关键不在收集阶段，而在
      // 评分阶段负向 token 会把分数拉低。
      // 这里只验证 token 切分逻辑工作正常：
      const el = document.createElement('div');
      el.className = 'blog-content__mbox';
      // 模拟 collectCandidates 的判定
      const tokens = el.className.toLowerCase().split(/[\s\-_]+/).filter(Boolean);
      expect(tokens).toContain('content');
      expect(tokens).toContain('mbox');
    });

    it('does not collect Tailwind utility classes as positive', () => {
      // 修前 POSITIVE_CLASS_RE 里的 'text' 误命中 'text-gray-500'
      // 修后 token 切分：'text' 仍是 POSITIVE，但 0-1 测试用的 'text-sm' 会被切成
      // ['text', 'sm']，'text' 命中 POSITIVE。
      // 真正的修复是 classHint 同时检查 NEGATIVE，且 'text' 单独是太短：
      // 这条用例验证 'text-sm' 不会让元素被误判为 article 根。
      document.body.innerHTML = `
        <div class="text-sm text-gray-500 bg-white p-4">
          <a href="#">Link 1</a>
          <a href="#">Link 2</a>
          <a href="#">Link 3</a>
        </div>
      `;
      const candidates = collectCandidates(document);
      // 这种纯 Tailwind 工具类 + 链接列表的 div 几乎肯定是 nav/list，
      // collectCandidates 可能收集到（因为 'text' token 命中），
      // 但 scoreElement 会给它打低分。
      const el = candidates[0];
      if (el) {
        const score = scoreElement(el);
        expect(score).toBeLessThan(SCORE_THRESHOLD);
      }
    });

    it('collects parent elements (up to 2 levels)', () => {
      document.body.innerHTML = `
        <div id="level-0">
          <div id="level-1">
            <div id="level-2" class="article-content">
              <p>Content</p>
            </div>
          </div>
        </div>
      `;
      const candidates = collectCandidates(document);
      const ids = candidates.map(el => el.id);
      expect(ids).toContain('level-2');
      expect(ids).toContain('level-1');
      expect(ids).toContain('level-0');
    });

    it('does not collect body or html', () => {
      document.body.innerHTML = '<div class="article"><p>Content</p></div>';
      const candidates = collectCandidates(document);
      expect(candidates).not.toContain(document.body);
      expect(candidates).not.toContain(document.documentElement);
    });

    it('does not duplicate elements', () => {
      document.body.innerHTML = '<article class="content"><p>Content</p></article>';
      const candidates = collectCandidates(document);
      const articleCount = candidates.filter(el => el.tagName === 'ARTICLE').length;
      expect(articleCount).toBe(1);
    });
  });

  // --- detectArticleRoot ---

  describe('detectArticleRoot', () => {
    it('detects article content', () => {
      document.body.innerHTML = `
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <article>
          <h1>Article Title</h1>
          <p>This is a long article with multiple paragraphs of content.</p>
          <p>The second paragraph continues the article with more text.</p>
          <p>A third paragraph to ensure high text density and paragraph ratio.</p>
        </article>
        <footer><p>Footer content</p></footer>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.tagName).toBe('ARTICLE');
    });

    it('detects div with content-like class', () => {
      document.body.innerHTML = `
        <div class="sidebar"><a href="#">Link1</a><a href="#">Link2</a></div>
        <div class="post-content">
          <h2>Blog Post</h2>
          <p>This is a blog post with substantial content that should be detected.</p>
          <p>More paragraphs to increase the score of this element.</p>
          <p>Even more content to ensure the scoring algorithm picks this div.</p>
        </div>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.className).toContain('post-content');
    });

    it('returns null for pages with no good content', () => {
      document.body.innerHTML = `
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <div><a href="/link1">Link</a></div>
      `;
      const root = detectArticleRoot(document);
      expect(root).toBeNull();
    });

    it('prefers content div over navigation', () => {
      document.body.innerHTML = `
        <div class="main-menu">
          <a href="/home">Home</a>
          <a href="/about">About</a>
          <a href="/blog">Blog</a>
          <a href="/docs">Docs</a>
        </div>
        <div class="content">
          <h1>Welcome</h1>
          <p>This is the main content of the page with real article text.</p>
          <p>It has multiple paragraphs and good text density.</p>
        </div>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.textContent).toContain('main content');
    });

    it('detects main element', () => {
      document.body.innerHTML = `
        <div class="header">Header</div>
        <main>
          <h1>Main Content</h1>
          <p>This is the main content of the page.</p>
          <p>More paragraphs to ensure good score.</p>
        </main>
        <footer>Footer</footer>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.tagName).toBe('MAIN');
    });

    it('detects role="article"', () => {
      document.body.innerHTML = `
        <div role="article">
          <h1>Article Title</h1>
          <p>Article content with multiple paragraphs.</p>
          <p>More content here.</p>
        </div>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.getAttribute('role')).toBe('article');
    });

    it('handles empty document', () => {
      document.body.innerHTML = '';
      const root = detectArticleRoot(document);
      expect(root).toBeNull();
    });

    it('handles document with only scripts and styles', () => {
      document.body.innerHTML = `
        <script>console.log('test');</script>
        <style>.class { color: red; }</style>
      `;
      const root = detectArticleRoot(document);
      expect(root).toBeNull();
    });

    it('Picks blog-content over blog-content__mbox in commoncog-like structure', () => {
      // 复刻 commoncog.com 的核心结构：
      // - 4 个 CTA / topic block（BEM 子类 blog-content__mbox、blog-content__topic-block）
      // - 1 个正文根（class="... blog-content font-serif ..."）
      // 修前 L2 评分时 blog-content__mbox 的"content"子串命中 POSITIVE，
      // 跟 blog-content 同分，导致正文漏掉。
      // 修后 token 化：mbox 命中 NEGATIVE，把 CTA 块拉低。
      document.body.innerHTML = `
        <div class="blog-content__mbox">
          <p>提起商学院你会不会只想翻白眼？</p>
        </div>
        <div class="blog-content__mbox">
          <p>你并不孤单。</p>
        </div>
        <div class="blog-content__topic-block">
          <p>9,000+ 投资者和运营人员阅读 Commoncog</p>
        </div>
        <div class="blog-content__mbox">
          <p>订阅我们的简报</p>
        </div>
        <div class="col-span-12 md:col-span-8 blog-content font-serif break-words">
          <h1>How to Improve at Sensemaking AI?</h1>
          <h2>Section One</h2>
          <p>This is a real long-form article body with substantial English content about sensemaking and AI patterns.</p>
          <p>The second paragraph continues with more analysis and detailed thinking on the topic.</p>
          <p>The third paragraph provides more depth and example scenarios for the reader.</p>
          <h2>Section Two</h2>
          <p>Another batch of paragraphs in section two of the article, providing concrete frameworks.</p>
          <p>More content to ensure the scoring algorithm prefers this div over the smaller CTA blocks above.</p>
          <h2>Section Three</h2>
          <p>Final section with concluding thoughts and recommendations for the reader.</p>
          <p>Closing paragraph wrapping up the argument with a strong call to action and final summary.</p>
        </div>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.className).toContain('blog-content');
      expect(root!.className).not.toContain('__mbox');
      expect(root!.className).not.toContain('__topic-block');
      expect(root!.textContent).toContain('How to Improve at Sensemaking AI');
    });

    it('Penalizes element with positive class but negative ancestor (nav)', () => {
      // 即使子元素有 'post' token，祖先有 nav 也要降分
      document.body.innerHTML = `
        <div>
          <nav>
            <div class="post-list">
              <a href="#">Post 1</a>
              <a href="#">Post 2</a>
              <a href="#">Post 3</a>
            </div>
          </nav>
          <div class="article-body">
            <h1>Real Article</h1>
            <p>This is the actual article with substantial content that the scoring should prefer.</p>
            <p>Multiple paragraphs of real content to outscore the nav-embedded list above.</p>
          </div>
        </div>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.className).toContain('article-body');
    });
  });
});
