/**
 * 共享正文提取 fixture（ADR-001 P1：双 walker 共享测试）。
 *
 * 同一组真实站点 HTML 结构，分别在 fanyi-extension 与 vocal-saga 的 walker 上
 * 跑断言，防止两个独立副本（blockExtractor）出现「语义漂移」——一个仓库改了
 * 噪声规则，另一个没跟上，导致浏览器翻译正常、服务端翻译却翻不出正文（或反之）。
 *
 * 注意：此文件在 fanyi-extension 与 vocal-saga 各保留一份**完全相同**的副本。
 * 长期目标（ADR-001）是抽成 shared content-extraction-core 包，彻底消除复制。
 * 改动时务必同步两份。
 *
 * expectTexts：每个 fixture 期望被 walker 提取到的正文段落子串。只断言正文
 * （body 段落），不跨仓库互相比对输出——各仓库只校验自身 walker 对这些结构
 * 仍能提取出关键正文，从而捕获「噪声规则回归导致正文被误杀」这类漂移。
 */
export interface ArticleRootFixture {
  name: string;
  url: string;
  html: string;
  expectTexts: string[];
}

export const ARTICLE_ROOT_FIXTURES: ArticleRootFixture[] = [
  {
    // Ghost CMS（BEM 双下划线）。<article class="... has-sidebar"> 因 "sidebar"
    // 噪声 token 险些被整棵剪枝；结构性容器豁免后，正文 sneak-peek 段落应被提取。
    name: '404media (Ghost BEM, article.has-sidebar)',
    url: 'https://www.404media.co/the-tokenpocalypse-is-here',
    html: `
      <main>
        <div class="post-hero">
          <h1 class="post-hero__title">The Tokenpocalypse Is Here</h1>
          <figcaption>Photo by Sebastian Herrmann</figcaption>
        </div>
        <article class="post tag-ai featured post-access-paid has-sidebar">
          <div class="post__content no-overflow">
            <div class="post-sneak-peek fading">
              <p>Consulting giant Accenture is trying to figure out how to stop non-technical workers from using AI tools at scale.</p>
              <p>The news highlights a major shift in the tech industry and other companies that use AI heavily.</p>
              <p>It also undercuts the narrative that superpowered engineers generating mountains of code are behind the AI boom.</p>
            </div>
          </div>
        </article>
      </main>
    `,
    expectTexts: [
      'Consulting giant Accenture',
      'superpowered engineers',
    ],
  },
  {
    // WordPress 经典结构：.post-content 容器，正文 <p> 直接在内。
    name: 'WordPress (post-content)',
    url: 'https://example.com/blog/post',
    html: `
      <article>
        <div class="post-content">
          <h1>Article Title</h1>
          <p>First real paragraph with enough words to be meaningful body content.</p>
          <p>Second paragraph provides more body text for the article to translate.</p>
        </div>
      </article>
    `,
    expectTexts: [
      'First real paragraph with enough words',
      'Second paragraph provides more body text',
    ],
  },
  {
    // 带侧边栏的新闻站：article 与 aside.sidebar 为兄弟，正文只在 article 内。
    name: 'Sidebar news (article + aside.sidebar)',
    url: 'https://news.example.com/story',
    html: `
      <div class="layout">
        <article class="article">
          <p>Main article body paragraph one with real reporting content.</p>
          <p>Main article body paragraph two continues the story with details.</p>
        </article>
        <aside class="sidebar">
          <p>Sidebar promo text that should not be treated as body.</p>
        </aside>
      </div>
    `,
    expectTexts: [
      'Main article body paragraph one',
      'Main article body paragraph two',
    ],
  },
  {
    // 内容容器与广告噪声相邻：.ad-content 应被剪枝，正文 .content 必须保留。
    name: 'Ad-adjacent content (content + ad-content)',
    url: 'https://example.com/article',
    html: `
      <main>
        <div class="content">
          <p>Real article paragraph here with substantial text worth translating.</p>
        </div>
        <div class="ad-content">
          <p>Advertisement copy that should be pruned by the walker.</p>
        </div>
      </main>
    `,
    expectTexts: ['Real article paragraph here with substantial text'],
  },
  {
    // MIT Sloan 类结构：h1 在兄弟 <header>，正文在 .article--body。
    // walker 应提取 .article--body 内的段落（标题扩展属 root detection 职责，
    // 此处仅校验正文段落不丢失）。
    name: 'Mitsloan-like (header h1 + article--body)',
    url: 'https://mitsloan.mit.edu/ideas-made-to-matter/ai',
    html: `
      <article>
        <header><h1>MIT Sloan idea made to matter about AI advice.</h1></header>
        <div class="article--body">
          <p>The body paragraph explains the research finding in detail and depth.</p>
          <p>A second body paragraph continues the explanation with more evidence.</p>
        </div>
      </article>
    `,
    expectTexts: [
      'The body paragraph explains the research finding',
      'A second body paragraph continues the explanation',
    ],
  },
];
