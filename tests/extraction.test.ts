import { describe, it, expect, beforeEach } from 'vitest';
import { selectBestRoot, findBestArticleRoot } from '../lib/translate/extraction/pipeline';
import { defaultArticleQualityScorer } from '../lib/translate/extraction/scoring';
import { selectorProvider } from '../lib/translate/extraction/providers/selector';
import { readabilityProvider } from '../lib/translate/extraction/providers/readability';
import { densityProvider } from '../lib/translate/extraction/providers/density';
import { prepareDocument } from '../lib/translate/contentHelper';
import type { ArticleContext } from '../lib/translate/blockExtractor/types';

describe('extraction pipeline (chatgpt0714.md architecture)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // ---------------------------------------------------------------------------
  // Provider-level behavior
  // ---------------------------------------------------------------------------

  it('selectorProvider matches .post__content (github.blog BEM)', () => {
    document.body.innerHTML = `
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <main>
        <section class="post__content">
          <h1>Better tools made Copilot code review worse</h1>
          <p>Here is how we actually improved it after a long investigation into the underlying causes.</p>
          <p>Second paragraph of the real article body contains enough text to exceed the minimum length threshold.</p>
        </section>
      </main>
      <aside>Sidebar noise</aside>
    `;

    const candidate = selectorProvider.provide(document, { pageUrl: 'https://github.blog/test' });
    expect(candidate).not.toBeNull();
    expect(candidate!.root.className).toContain('post__content');
  });

  it('readabilityProvider returns a candidate for article-like pages', () => {
    document.body.innerHTML = `
      <article>
        <h1>Readable Article</h1>
        <p>This is the first real paragraph with enough text to form a signature for Mozilla Readability.</p>
        <p>Another paragraph follows to make the content substantial and recognizable by the reader algorithm.</p>
        <p>We keep adding sentences so that the extracted text length comfortably exceeds the two hundred character minimum.</p>
      </article>
    `;

    const candidate = readabilityProvider.provide(document);
    expect(candidate).not.toBeNull();
    expect(candidate!.textLength).toBeGreaterThan(200);
  });

  it('densityProvider returns a candidate when semantic selectors miss', () => {
    document.body.innerHTML = `
      <nav><a href="/">Home</a><a href="/x">X</a></nav>
      <div class="wrapper">
        <h1>Dense Content</h1>
        <p>Paragraph one with enough text to create a high density score.</p>
        <p>Paragraph two continues the real article body without semantic tags.</p>
        <p>Paragraph three keeps the density high and link count low.</p>
      </div>
    `;

    const candidate = densityProvider.provide(document, { pageUrl: 'https://example.com/test' });
    expect(candidate).not.toBeNull();
    expect((candidate!.root.textContent || '')).toContain('Dense Content');
  });

  // ---------------------------------------------------------------------------
  // Unified scoring
  // ---------------------------------------------------------------------------

  it('scorer penalizes high-boilerplate containers', () => {
    document.body.innerHTML = `
      <article id="wide">
        <h1>Article Title</h1>
        <p>Real body paragraph one contains enough words to pass the minimum text length threshold in the scorer.</p>
        <p>Real body paragraph two also contains enough words to contribute positively to the final confidence.</p>
        <div class="bios-container">
          <p class="bio">Author bio with many words that should reduce the wide article score because boilerplate ratio is high.</p>
        </div>
      </article>
      <div id="clean" class="post-content">
        <h1>Clean Title</h1>
        <p>Clean body paragraph one contains enough words to pass the minimum text length threshold in the scorer.</p>
        <p>Clean body paragraph two also contains enough words to contribute positively to the final confidence.</p>
      </div>
    `;

    const wide = document.getElementById('wide')!;
    const clean = document.getElementById('clean')!;
    const wideScore = defaultArticleQualityScorer.score(
      { provider: 'selector', root: wide, textLength: (wide.textContent || '').length, confidence: 0 },
      document,
    );
    const cleanScore = defaultArticleQualityScorer.score(
      { provider: 'selector', root: clean, textLength: (clean.textContent || '').length, confidence: 0 },
      document,
    );

    expect(cleanScore).toBeGreaterThan(wideScore);
  });

  it('scorer rewards concrete body classes and penalizes overly wide wrappers', () => {
    document.body.innerHTML = `
      <article id="wrapper">
        <div class="post-content" id="body">
          <h1>Title</h1>
          <p>Body paragraph one contains enough words to pass the minimum text length threshold in the scorer.</p>
          <p>Body paragraph two also contains enough words to contribute positively to the final confidence.</p>
        </div>
      </article>
    `;

    const wrapper = document.getElementById('wrapper')!;
    const body = document.getElementById('body')!;
    const wrapperScore = defaultArticleQualityScorer.score(
      { provider: 'selector', root: wrapper, textLength: (wrapper.textContent || '').length, confidence: 0 },
      document,
    );
    const bodyScore = defaultArticleQualityScorer.score(
      { provider: 'selector', root: body, textLength: (body.textContent || '').length, confidence: 0 },
      document,
    );

    expect(bodyScore).toBeGreaterThan(wrapperScore);
  });

  // ---------------------------------------------------------------------------
  // End-to-end selection
  // ---------------------------------------------------------------------------

  it('selects .post__content for github.blog nested-html structure (regression)', () => {
    document.body.innerHTML = `
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <main>
        <section class="post__content">
          <html><body>
            <h1>Better tools made Copilot code review worse</h1>
            <p>Here is how we actually improved it after a long investigation into the underlying causes.</p>
            <p>Second paragraph of the real article body inside nested html/body contains enough text to pass thresholds.</p>
          </body></html>
        </section>
      </main>
      <aside>Sidebar noise that must not dominate selection.</aside>
    `;

    const result = selectBestRoot(document, 'https://github.blog/ai-ml/test');
    expect(result).not.toBeNull();
    expect(result!.root.className).toContain('post__content');

    const { fullText, report } = prepareDocument(document, 'https://github.blog/ai-ml/test');
    expect(fullText).toContain('Better tools made Copilot code review worse');
    expect(fullText).toContain('Second paragraph of the real article body');
    expect(report.blockCount).toBeGreaterThan(0);
  });

  it('selects .post-content and excludes author bio for Jane Street layout', () => {
    document.body.innerHTML = `
      <article>
        <div class="post-header">
          <h3>Formal methods and the future of programming</h3>
          <span class="date">Jun 07, 2026</span>
          <ul class="social-share"><li><a href="#">Share</a></li></ul>
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

    const { fullText, report } = prepareDocument(document, 'https://blog.janestreet.com/test');
    expect(fullText).toContain("I've been telling people");
    expect(fullText).toContain('Agentic coding upsets');
    expect(fullText).not.toContain('Yaron Minsky joined Jane Street');
    expect(report.blockCount).toBeGreaterThanOrEqual(4);
  });

  it('prefers content container over generic <main> when main wraps navigation', () => {
    document.body.innerHTML = `
      <main>
        <nav><a href="/">Home</a><a href="/a">A</a><a href="/b">B</a></nav>
        <article class="story-body">
          <h1>Real Story</h1>
          <p>This is the real story body with enough text to dominate scoring.</p>
          <p>Another paragraph keeps the density high and boilerplate low.</p>
        </article>
      </main>
    `;

    const result = selectBestRoot(document, 'https://example.com/story');
    expect(result).not.toBeNull();
    expect(result!.root.className).toContain('story-body');
  });

  // ---------------------------------------------------------------------------
  // Shared context and fallback behavior
  // ---------------------------------------------------------------------------

  it('fills ArticleContext for downstream block extraction', () => {
    document.body.innerHTML = `
      <div id="cookie-banner" class="cookie-banner">We use cookies.</div>
      <article>
        <h1>Article Title</h1>
        <p>Paragraph one contains enough words to pass the minimum text length threshold used by the scorer.</p>
        <p>Paragraph two also contains enough words to contribute positively to the final confidence value.</p>
      </article>
    `;

    const context: Partial<ArticleContext> = {};
    const result = selectBestRoot(document, 'https://example.com/test', context);
    expect(result).not.toBeNull();
    expect(context.confidence).toBeGreaterThan(0);
    expect(context.semanticHints).toBeDefined();
    expect(context.semanticHints!.isArticle).toBe(true);
  });

  it('findBestArticleRoot returns null when no candidate is good enough', () => {
    document.body.innerHTML = `
      <nav><a href="/">Home</a><a href="/x">X</a></nav>
      <div><a href="/a">A</a></div>
    `;

    const root = findBestArticleRoot(document, 'https://example.com/nocontent');
    expect(root).toBeNull();
  });
});
