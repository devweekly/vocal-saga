import { describe, it, expect } from 'vitest';
import { prepareDocument } from '../lib/translate/contentHelper';

const HTML_404 = `
<main class="main">
  <div class="post-hero">
    <div class="post-hero__header"><h1 class="post-hero__title">The Tokenpocalypse Is Here</h1></div>
    <div class="post-hero__excerpt">Leaked audio from Accenture says the company is rethinking AI tooling.</div>
    <figure class="post-hero__image"><figcaption>Photo by Sebastian Herrmann on Unsplash</figcaption></figure>
  </div>
  <article class="post tag-ai featured post-access-paid has-sidebar">
    <div class="post__content no-overflow">
      <div class="post-sneak-peek fading">
        <p>Consulting giant Accenture is trying to figure out how to stop non-technical workers from using AI tools.</p>
        <p>The news highlights a major shift in the tech industry and other companies that use AI.</p>
        <p>It also undercuts the narrative that superpowered engineers generating mountains of code are behind the AI boom.</p>
      </div>
      <div class="post-access-cta paid"><h2>This post is for paid members only</h2><div class="description">Become a paid member for unlimited access.</div></div>
    </div>
  </article>
  <aside class="sidebar"><h6>More like this</h6><div>Related article card</div></aside>
</main>
`;

describe('diag: 404media.co server-side extraction', () => {
  it('extracts the body paragraphs (sneak-peek) via /force path', () => {
    document.body.innerHTML = HTML_404;
    const { blocks, fullText } = prepareDocument(document, 'https://www.404media.co/test');
    console.log('[DIAG] block count =', blocks.length);
    console.log('[DIAG] fullText contains Accenture =', fullText.includes('Consulting giant Accenture'));
    console.log('[DIAG] fullText contains superpowered =', fullText.includes('superpowered engineers'));
    expect(fullText).toContain('Consulting giant Accenture');
    expect(fullText).toContain('superpowered engineers');
  });
});
