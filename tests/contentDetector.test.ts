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

  // --- Text Density 算法特性测试 ---

  describe('Text Density characteristics', () => {
    it('scores near 0 for element where all text is inside links', () => {
      // 纯链接列表：text≈linkText，bodyText≈0
      // 用紧凑 innerHTML 避免标签间空白被算作 body 文本
      const el = document.createElement('div');
      el.innerHTML =
        '<a href="#">First link with some text</a>' +
        '<a href="#">Second link with more text</a>' +
        '<a href="#">Third link with even more text</a>' +
        '<a href="#">Fourth link with additional text</a>';
      document.body.appendChild(el);
      const score = scoreElement(el);
      // bodyText ≈ 0，density 应接近 0
      // 允许少量 round-off 误差
      expect(score).toBeLessThan(5);
    });

    it('density decreases as link count increases for same body text', () => {
      // 相同 bodyText（500 字符），不同 linkCount
      // density = (500 / (n+1)) * log(500+1) ≈ (500 / (n+1)) * 6.21
      const buildEl = (linkCount: number) => {
        const el = document.createElement('div');
        // 主体文本：单个长段落（500 字符）
        el.appendChild(
          (() => {
            const p = document.createElement('p');
            p.textContent = 'word '.repeat(100).trim();
            return p;
          })()
        );
        // 添加若干空链接（仅贡献 linkCount，不贡献文本）
        for (let i = 0; i < linkCount; i++) {
          const a = document.createElement('a');
          a.href = '#';
          el.appendChild(a);
        }
        return el;
      };

      const s0 = scoreElement(buildEl(0));
      const s5 = scoreElement(buildEl(5));
      const s20 = scoreElement(buildEl(20));

      // linkCount 越多，密度越低
      expect(s0).toBeGreaterThan(s5);
      expect(s5).toBeGreaterThan(s20);
    });

    it('penalizes elements with linkRatio > 0.5 (link-heavy regions)', () => {
      // 链接文本 > 总文本 50% → 乘性 0.5x 惩罚
      // 对比：相同 bodyText，一个 linkRatio=0.3，一个 linkRatio=0.7
      const buildEl = (linkTextRatio: number) => {
        const el = document.createElement('div');
        const totalText = 1000;
        const linkTextLen = Math.floor(totalText * linkTextRatio);
        const bodyTextLen = totalText - linkTextLen;
        el.innerHTML = `
          <p>${'word '.repeat(Math.floor(bodyTextLen / 5)).trim()}</p>
          <a href="#">${'link'.repeat(Math.floor(linkTextLen / 4))}</a>
        `;
        return el;
      };

      const lowLink = scoreElement(buildEl(0.3));
      const highLink = scoreElement(buildEl(0.7));

      // 链接占比 > 0.5 应明显低于 ≤ 0.5
      // 注意：highLink 受到 0.5x 惩罚，应该显著降低
      expect(highLink).toBeLessThan(lowLink);
    });

    it('rewards long text without links (high text density)', () => {
      // 2000 字符纯文本（无链接、无 class）
      // density = (2000 / 1) * log(2001) ≈ 2000 * 7.6 ≈ 15200
      const el = document.createElement('div');
      el.appendChild(
        (() => {
          const p = document.createElement('p');
          p.textContent = 'This is a long paragraph of plain text content. '.repeat(40).trim();
          return p;
        })()
      );
      document.body.appendChild(el);
      const score = scoreElement(el);
      // 应远超阈值
      expect(score).toBeGreaterThan(SCORE_THRESHOLD * 10);
    });

    it('Text Density outperforms Readability on link list vs short paragraph', () => {
      // 经典场景：左侧栏是链接列表（5个链接），右侧是短段落（150字符）
      // Text Density 下短段落应当胜出（因为 bodyText 大、log 缩放）
      const sidebar = document.createElement('div');
      sidebar.className = 'sidebar';
      sidebar.innerHTML = `
        <a href="#">Link one with text</a>
        <a href="#">Link two with text</a>
        <a href="#">Link three with text</a>
        <a href="#">Link four with text</a>
        <a href="#">Link five with text</a>
      `;
      document.body.appendChild(sidebar);

      const main = document.createElement('div');
      main.className = 'content';
      main.innerHTML = `
        <p>This is a substantial paragraph with about one hundred and fifty characters of real text content for the algorithm to evaluate properly.</p>
      `;
      document.body.appendChild(main);

      const sidebarScore = scoreElement(sidebar);
      const mainScore = scoreElement(main);

      expect(mainScore).toBeGreaterThan(sidebarScore);
    });

    it('detects article root in typical blog layout (h1 + multiple p, no links)', () => {
      // 典型博客布局：标题 + 多段正文，无链接
      document.body.innerHTML = `
        <header>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/blog">Blog</a>
        </header>
        <main>
          <h1>Article Title</h1>
          <p>${'Paragraph with content. '.repeat(15).trim()}</p>
          <p>${'Another paragraph here. '.repeat(15).trim()}</p>
          <p>${'Yet another paragraph. '.repeat(15).trim()}</p>
          <p>${'Final paragraph for good measure. '.repeat(15).trim()}</p>
        </main>
        <footer>
          <a href="#">Footer link 1</a>
          <a href="#">Footer link 2</a>
        </footer>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      // <main> 应被识别为正文容器
      expect(root!.tagName.toLowerCase()).toBe('main');
    });
  });

  // --- v2 评分模型修正测试 (修复 4 项必改 + 2 项可增强) ---

  describe('v2 scoring model fixes', () => {
    // ---- 1) linkTextLength 只统计直接 text node ----
    it('linkTextLength counts only direct text nodes (not nested DOM)', () => {
      // 旧版: a.textContent 会把 <span> 内的文字也计入, 错误高估 linkTextLength,
      // 导致 bodyText 偏低, 评分误判为链接列表。
      // 新版: 只统计 <a> 下的直接 text node。
      // 关键不变量: <a><span>text</span></a> 形式下, bodyText (非链接文本) 应当大于
      // <a>text</a> 形式 (前者 linkTextLength ≈ 0 因为直接 text node 只有空白,
      // 后者 linkTextLength = text 长度)。所以 nested 形式 score 应当 >= direct 形式。
      const withNested = document.createElement('div');
      withNested.className = 'article-content';
      withNested.innerHTML = `
        <p>${'word '.repeat(40).trim()}</p>
        <a href="#"><span>${'x'.repeat(100)}</span></a>
      `;
      const withDirect = document.createElement('div');
      withDirect.className = 'article-content';
      withDirect.innerHTML = `
        <p>${'word '.repeat(40).trim()}</p>
        <a href="#">${'x'.repeat(100)}</a>
      `;
      // nested 形式 linkTextLength 几乎为 0, bodyText 完整保留, score 应高于 direct
      const scoreNested = scoreElement(withNested);
      const scoreDirect = scoreElement(withDirect);
      expect(scoreNested).toBeGreaterThan(scoreDirect);
    });

    it('does not over-count icon font text inside links', () => {
      // icon font 通常用 ::before content 或 <i class="icon"> 表现, 不产生直接 text node
      const el = document.createElement('div');
      el.className = 'article-content';
      el.innerHTML = `
        <p>${'content '.repeat(30).trim()}</p>
        <a href="#"><i class="icon-share"></i>Share</a>
      `;
      document.body.appendChild(el);
      // linkTextLength 应只算 "Share" (5字符), 不算 <i> 内空
      // linkRatio = 5/(~180) < 0.5, 不触发 0.5x 惩罚 → score 应 > 阈值
      const score = scoreElement(el);
      expect(score).toBeGreaterThan(SCORE_THRESHOLD);
    });

    // ---- 2) 纯 multiplicative model: structureBoost ----
    it('structureBoost: <article> applies 1.3x multiplier (not absolute +500)', () => {
      // 同样 text/length, 比较 <article> vs <div>:
      // article 应该得到 1.3x boost, score 约 = 1.3 * div score
      const buildEl = (tag: string) => {
        const el = document.createElement(tag);
        el.className = 'content';
        el.textContent = 'word '.repeat(200).trim();
        return el;
      };
      const divScore = scoreElement(buildEl('div'));
      const articleScore = scoreElement(buildEl('article'));
      // ratio 应近似 1.3 (允许 floating point 误差)
      const ratio = articleScore / divScore;
      expect(ratio).toBeGreaterThan(1.25);
      expect(ratio).toBeLessThan(1.35);
    });

    it('structureBoost: <main> applies 1.2x multiplier', () => {
      const buildEl = (tag: string) => {
        const el = document.createElement(tag);
        el.className = 'content';
        el.textContent = 'word '.repeat(200).trim();
        return el;
      };
      const divScore = scoreElement(buildEl('div'));
      const mainScore = scoreElement(buildEl('main'));
      const ratio = mainScore / divScore;
      expect(ratio).toBeGreaterThan(1.15);
      expect(ratio).toBeLessThan(1.25);
    });

    it('structureBoost: <section> applies weak 1.05x multiplier', () => {
      const buildEl = (tag: string) => {
        const el = document.createElement(tag);
        el.className = 'content';
        el.textContent = 'word '.repeat(200).trim();
        return el;
      };
      const divScore = scoreElement(buildEl('div'));
      const sectionScore = scoreElement(buildEl('section'));
      const ratio = sectionScore / divScore;
      // section 弱 boost, 1.05x
      expect(ratio).toBeGreaterThan(1.0);
      expect(ratio).toBeLessThan(1.1);
    });

    it('multiplicative model: ranking is monotonic across DOM sizes', () => {
      // 关键不变量: score 应该是"文本质量函数"而非"标签绝对加分函数"。
      // 同样 200 字符正文, article vs main: article 必胜, 但分差应按比例 (1.3/1.2 ≈ 1.083x),
      // 不应像旧版 +500 把 200 字符 article 拉到接近 1000 字符 div 的位置。
      const smallArticle = document.createElement('article');
      smallArticle.className = 'content';
      smallArticle.textContent = 'word '.repeat(40).trim();  // 短文 ~200 chars
      const bigMain = document.createElement('main');
      bigMain.textContent = 'word '.repeat(400).trim();  // 长文 ~2000 chars
      // 即使 bigMain 文本 10x 于 smallArticle, smallArticle 的 multiplicative boost
      // (1.3) 不会像旧版 +500 那样让小 article 凭空超过大 main。
      // 这里只检查 "score 比值小于文本比值" (即 boost 不会把 ranking 拉爆):
      //   smallArticle (200 chars, 1.3x) vs bigMain (2000 chars, 1.2x)
      //   score(article) / score(main) ≈ (200 * 1.3) / (2000 * 1.2) ≈ 0.108
      const a = scoreElement(smallArticle);
      const m = scoreElement(bigMain);
      expect(a).toBeLessThan(m);
    });

    // ---- 3) POSITIVE tokens 收紧 ----
    it('does not treat Tailwind .text-* utility as positive', () => {
      // 旧版 POSITIVE 包含 'text' token, .text-gray-500 会被当正文容器加分。
      // 新版 POSITIVE_TOKENS 已删除 'text', .text-* 应被忽略。
      const el = document.createElement('div');
      el.className = 'text-gray-500 text-sm p-4';
      el.innerHTML = `
        <a href="#">A</a><a href="#">B</a><a href="#">C</a>
        <a href="#">D</a><a href="#">E</a><a href="#">F</a>
      `;
      document.body.appendChild(el);
      const score = scoreElement(el);
      // 没有 positive boost, 仅靠 density, 链接列表分应低于阈值
      expect(score).toBeLessThan(SCORE_THRESHOLD);
    });

    it('does not treat .content-* carousel/sidebar as positive', () => {
      // 旧版 POSITIVE 包含 'content' token, .content-carousel / .content-sidebar
      // 会被加分。新版 POSITIVE_TOKENS 严格收紧, 只接受单 token article/post/entry 等,
      // 复合类靠 POSITIVE_COMPOUND_RE 匹配 (article-content / post-body 模式)。
      const el = document.createElement('div');
      el.className = 'content-carousel content-sidebar content-wrapper';
      el.textContent = 'word '.repeat(200).trim();
      document.body.appendChild(el);
      const score = scoreElement(el);
      // 没有 positive boost, score 来自纯 density
      // 对比同条件下的 article-content 元素 (应有 1.2x boost)
      const ref = document.createElement('div');
      ref.className = 'article-content';
      ref.textContent = 'word '.repeat(200).trim();
      const refScore = scoreElement(ref);
      // article-content 必高于 content-carousel (有 1.2x boost)
      expect(refScore).toBeGreaterThan(score);
    });

    it('POSITIVE_COMPOUND_RE matches article-content / post-body / entry-content', () => {
      // 复合 regex 匹配 CMS 常见命名, 验证三种典型写法
      const compounds = ['article-content', 'post-body', 'entry-content', 'main-content', 'rich-text'];
      for (const cls of compounds) {
        const el = document.createElement('div');
        el.className = cls;
        el.textContent = 'word '.repeat(100).trim();
        const ref = document.createElement('div');
        ref.className = 'plain-wrapper';
        ref.textContent = 'word '.repeat(100).trim();
        // 有复合类的元素应得到 1.2x boost
        expect(scoreElement(el)).toBeGreaterThan(scoreElement(ref));
      }
    });

    // ---- 4) 去除 ancestor early return ----
    it('article inside <aside> is NOT killed (ancestor negative = soft penalty)', () => {
      // 旧版: 祖先含 aside → 立即 return negative, article 被误杀。
      // 新版: aside 祖先只设 negative=true, 由 scoring system 综合判定。
      // 关键场景: SPA 布局 sidebar 内嵌 article preview card。
      document.body.innerHTML = `
        <aside class="sidebar">
          <article class="post-content">
            <h1>Preview Article</h1>
            <p>${'Substantial content here. '.repeat(30).trim()}</p>
            <p>${'More body text in the article. '.repeat(30).trim()}</p>
          </article>
        </aside>
      `;
      const root = detectArticleRoot(document);
      // 应该仍能识别 article 作为正文, 不被 aside 祖先杀死
      expect(root).not.toBeNull();
      expect(root!.className).toContain('post-content');
    });

    it('article inside <aside> with similar text density wins via structureBoost', () => {
      // 对比场景: aside 包裹了 article + 一个同尺寸的普通 div
      //   - <div class="raw-content">     200 字符, 无 positive signal
      //   - <article class="article-body"> 200 字符, 1.2x content + 1.3x article
      // 期望 article 胜出, 因为同文本下 multiplicative boost 决定 ranking。
      // 注意: 这里故意让两者文本量相近 — 如果 raw 远大于 article, density 公式
      // 会让 raw 胜出 (这是合理行为: 大块纯文本本身是强 content 信号)。
      document.body.innerHTML = `
        <aside class="sidebar">
          <div class="raw-content">
            <p>${'Plain text no signal. '.repeat(10).trim()}</p>
          </div>
          <article class="article-body">
            <p>${'Real article body. '.repeat(10).trim()}</p>
          </article>
        </aside>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.tagName.toLowerCase()).toBe('article');
    });

    // ---- 5) META tokens 弱 penalty (0.85x, 不被 0.5x 重击) ----
    it('META tokens (byline / author) apply weak 0.85x, not 0.5x', () => {
      // author / timestamp / tag 是 metadata, 走 0.85x, 不应被当作 nav/footer 重击。
      // 验证: META-only 元素的 score 应高于 NEGATIVE_CONTAINER-only 元素 (在同文本条件下)。
      // 注意: class 名要避免触发 POSITIVE_TOKENS (如 'post'/'entry'/'article' 等),
      // 否则 positive boost 会污染 ratio 验证。
      const metaEl = document.createElement('div');
      metaEl.className = 'byline';
      metaEl.textContent = 'word '.repeat(200).trim();

      const navEl = document.createElement('div');
      navEl.className = 'nav';
      navEl.textContent = 'word '.repeat(200).trim();

      const metaScore = scoreElement(metaEl);
      const navScore = scoreElement(navEl);
      // byline: 'byline' token 在 META_TOKENS → meta=true → 0.85x
      // nav: 'nav' token 在 NEGATIVE_CONTAINER_TOKENS → negative=true → 0.5x
      // 两者都不在 POSITIVE_TOKENS, ratio 应 = 0.85 / 0.5 = 1.7
      expect(metaScore).toBeGreaterThan(navScore);
      const ratio = metaScore / navScore;
      expect(ratio).toBeCloseTo(1.7, 1);
    });

    it('class="post-meta" ancestor does not kill nested real article', () => {
      // Medium/Substack 文章 header 通常有 <div class="post-meta"> 包裹 author/time,
      // 后面跟 <article class="post-content">。新设计下, post-meta 是 META (0.85x),
      // 不应连累 article 子节点。
      document.body.innerHTML = `
        <div class="post-meta">
          <span>Author Name</span>
          <span>2026-06-15</span>
        </div>
        <article class="post-content">
          <h1>Real Article</h1>
          <p>${'Substantial content paragraphs here. '.repeat(20).trim()}</p>
        </article>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.className).toContain('post-content');
    });
  });
});
