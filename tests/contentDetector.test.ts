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
      expect(score).toBeGreaterThan(0.5);
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

    it('scores empty elements low', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const score = scoreElement(el);
      expect(score).toBeLessThan(0.15);
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

    it('collects elements with content-like class names', () => {
      document.body.innerHTML = `
        <div class="sidebar"><a href="#">Link</a></div>
        <div class="post-content"><p>Post content</p></div>
        <div class="article-body"><p>Article body</p></div>
      `;
      const candidates = collectCandidates(document);
      const classes = candidates.map(el => el.className);
      expect(classes.some(c => c.includes('post-content'))).toBe(true);
      expect(classes.some(c => c.includes('article-body'))).toBe(true);
      // sidebar 也应被收集（class 不含正向模式，但作为父级 fallback）
      // 这里只验证正向模式被收集
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
  });
});
