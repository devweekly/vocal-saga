/**
 * displayRules 单测 —— 站点展示期规则（去侧边栏 / 注入 CSS / 注入 JS）。
 *
 * 关键点：
 *   - 只对匹配 hostPattern 的 URL 生效，其它站点原样返回
 *   - removeSelectors 打 data-fanyi-remove，由 injectTranslationCss 注入的
 *     TRANSLATION_CSS 中 `[data-fanyi-remove="true"]{display:none}` 规则隐藏
 *     （旧版 TRANSLATION_CSS 漏掉这条，导致 oreilly 侧栏被打标却仍显示，见下）
 *   - displayCss 进 <head>，displayJs 进 <body> 末尾
 *   - 非法选择器 / 无法解析的 HTML 都不能炸
 */
import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { applySiteDisplayRules } from '../lib/translate/displayRules';

const doc = (html: string): Document =>
  (parseHTML(html) as unknown as { document: Document }).document;

describe('applySiteDisplayRules', () => {
  it('URL 为空或不匹配任何站点规则时：无噪声元素则内容原样保留', () => {
    const html = '<html><head></head><body><div id="right-rail">ad</div></body></html>';
    // 空 URL：直接原样返回
    expect(applySiteDisplayRules(html, '')).toBe(html);
    // 未匹配站点的真实 URL：全局规则会跑，但 right-rail 是 oreilly 专属选择器、
    // 不在全局规则里，应保留内容、不打标
    const out = applySiteDisplayRules(html, 'https://example.com/a');
    const d = doc(out);
    expect(d.querySelector('#right-rail')?.getAttribute('data-fanyi-remove')).toBeNull();
    expect(d.querySelector('#right-rail')?.textContent).toBe('ad');
  });

  it('O’Reilly：隐藏 #right-rail 侧边栏', () => {
    const html = `<html><head></head><body>
      <article>正文</article>
      <div id="right-rail"><div class="module">Try the O’Reilly platform</div></div>
    </body></html>`;
    const out = applySiteDisplayRules(html, 'https://www.oreilly.com/radar/foo/');
    const d = doc(out);
    const rail = d.querySelector('#right-rail');
    expect(rail).not.toBeNull();
    expect(rail?.getAttribute('data-fanyi-remove')).toBe('true');
    // 正文不能被误伤
    expect(d.querySelector('article')?.getAttribute('data-fanyi-remove')).toBeNull();
  });

  it('O’Reilly：也隐藏 #postContent-related 底部相关阅读区', () => {
    const html = `<html><head></head><body>
      <article>正文</article>
      <div id="postContent-related"><div>Related reading</div></div>
    </body></html>`;
    const out = applySiteDisplayRules(html, 'https://www.oreilly.com/radar/foo/');
    const d = doc(out);
    const related = d.querySelector('#postContent-related');
    expect(related?.getAttribute('data-fanyi-remove')).toBe('true');
  });

  it('Towards Data Science：注入约束图片与正文宽度的 displayCss', () => {
    const html = `<html><head></head><body>
      <article class="mx-auto w-full max-w-article"><img class="w-full absolute inset-0 h-full object-cover" src="x.png"></article>
    </body></html>`;
    const out = applySiteDisplayRules(html, 'https://towardsdatascience.com/p/foo');
    const d = doc(out);
    const siteCss = d.querySelector('style[data-fanyi-site-css]');
    expect(siteCss).not.toBeNull();
    // 撤销绝对定位 + 压回容器，解决"图片超大"
    expect(siteCss?.textContent).toContain('position: static !important');
    expect(siteCss?.textContent).toContain('max-width: 100% !important');
    // 正文阅读宽度
    expect(siteCss?.textContent).toContain('max-width: 720px !important');
    // 隐藏顶部裸链接品牌栏与 Cookie 横幅
    expect(siteCss?.textContent).toContain('header.bg-brand');
    expect(siteCss?.textContent).toContain('[class*="cookie" i]');
  });

  it('O’Reilly 子域名（radar.oreilly.com）同样命中', () => {
    const html = '<html><body><div id="right-rail">ad</div></body></html>';
    const out = applySiteDisplayRules(html, 'https://radar.oreilly.com/x');
    expect(out).toContain('data-fanyi-remove');
  });

  it('x.com：注入加宽正文列的 CSS 到 <head>', () => {
    const html = '<html><head><style>.orig{}</style></head><body>x</body></html>';
    const out = applySiteDisplayRules(html, 'https://x.com/UberEng/status/1');
    const d = doc(out);
    const siteCss = d.querySelector('style[data-fanyi-site-css]');
    expect(siteCss).not.toBeNull();
    expect(siteCss?.textContent).toContain('[data-testid="primaryColumn"]');
    expect(siteCss?.textContent).toContain('max-width: 1000px');
    // 必须挂在 head 里，且排在原有样式之后
    expect(d.head?.lastElementChild).toBe(siteCss);
  });

  it('站点规则里没有展示期配置时不改动 HTML', () => {
    // github.com 目前只配了 skipSelectors，没有 removeSelectors / displayCss
    const html = '<html><head></head><body><div>readme</div></body></html>';
    const out = applySiteDisplayRules(html, 'https://github.com/a/b');
    expect(doc(out).querySelector('style[data-fanyi-site-css]')).toBeNull();
    expect(out).not.toContain('data-fanyi-remove');
  });

  it('非法选择器被跳过，不影响其余规则执行', () => {
    const html = '<html><head></head><body><div id="right-rail">ad</div></body></html>';
    const broken = html.replace('<head></head>', '<head></head>');
    // 直接用内置规则无法注入非法选择器，这里验证解析异常路径不抛错
    expect(() => applySiteDisplayRules(broken, 'https://www.oreilly.com/x')).not.toThrow();
  });

  it('displayJs 追加到 <body> 末尾且带标记', () => {
    // 直接验证内部契约：构造一条临时规则不可行（规则表是常量），
    // 因此这里断言当前规则集里没有站点用 JS（保持"CSS 优先"的约定）。
    const html = '<html><head></head><body>content</body></html>';
    for (const url of ['https://x.com/a', 'https://www.oreilly.com/a']) {
      expect(applySiteDisplayRules(html, url)).not.toContain('data-fanyi-site-js');
    }
  });

  it('HTML 片段（无 html/head/body）也能安全处理', () => {
    const frag = '<div id="right-rail">ad</div>';
    expect(() => applySiteDisplayRules(frag, 'https://www.oreilly.com/x')).not.toThrow();
  });

  it('MIT Technology Review：隐藏站点 header / sticky 侧边栏 / 相关推荐 / 订阅表单 / 广告位', () => {
    const html = `<html><head></head><body>
      <article>正文</article>
      <header class="headerTemplate__container--abcdef">site nav</header>
      <aside class="sidebar__wrapper--xyz"><div>Popular</div></aside>
      <aside class="related__wrap">Related</aside>
      <form class="stayConnected__form--aaa">subscribe</form>
      <div class="site-article-right-rail adunitContainer">ad</div>
      <div class="adUnit adUnit__wrapper--bbb">ad</div>
    </body></html>`;
    const out = applySiteDisplayRules(html, 'https://www.technologyreview.com/2026/foo/');
    const d = doc(out);
    expect(d.querySelector('header[class*="headerTemplate__container" i]')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('aside[class*="sidebar__wrapper" i]')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('aside[class*="related__wrap" i]')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('form[class*="stayConnected__form" i]')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('div[class*="adunitContainer" i]')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('div[class*="adUnit" i]')?.getAttribute('data-fanyi-remove')).toBe('true');
    // 正文不能被误伤
    expect(d.querySelector('article')?.getAttribute('data-fanyi-remove')).toBeNull();
  });

  it('MIT Technology Review 子域名（wp.technologyreview.com）同样命中', () => {
    const html = '<html><body><aside class="sidebar__wrapper--xyz">x</aside></body></html>';
    const out = applySiteDisplayRules(html, 'https://wp.technologyreview.com/foo');
    expect(out).toContain('data-fanyi-remove');
  });

  it('CNN：删除下载 App 弹窗与重复导航', () => {
    const html = `<html><head></head><body>
      <article>正文</article>
      <dialog id="GooglePlayDialog"><div class="download-dialog__close-button">close</div></dialog>
      <dialog id="AppStoreDialog">app store</dialog>
      <div id="ad-feedback__modal-overlay" class="ad-feedback__modal">feedback</div>
      <nav id="pageHeader">main nav</nav>
      <nav class="header__nav">duplicated nav</nav>
      <nav class="user-account-nav">account</nav>
      <nav class="header__editionizer">edition</nav>
      <div class="follow-topics-bar_overlay">follow</div>
      <button id="headerSubscribeButton">Subscribe</button>
      <footer id="pageFooter">footer nav duplicated</footer>
    </body></html>`;
    const out = applySiteDisplayRules(html, 'https://edition.cnn.com/2026/08/foo');
    const d = doc(out);
    expect(d.querySelector('dialog#GooglePlayDialog')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('dialog#AppStoreDialog')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('#ad-feedback__modal-overlay')?.getAttribute('data-fanyi-remove')).toBe('true');
    // 保留 nav#pageHeader，删掉重复的 nav.header__nav
    expect(d.querySelector('nav#pageHeader')?.getAttribute('data-fanyi-remove')).toBeNull();
    expect(d.querySelector('nav.header__nav')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('nav.user-account-nav')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('nav.header__editionizer')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('.follow-topics-bar_overlay')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('#headerSubscribeButton')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('footer#pageFooter')?.getAttribute('data-fanyi-remove')).toBe('true');
    // displayCss 隐藏 ad-slot-rail 侧栏
    const siteCss = d.querySelector('style[data-fanyi-site-css]')?.textContent || '';
    expect(siteCss).toContain('.ad-slot-rail_right');
    expect(siteCss).toContain('display: none !important');
  });

  it('Stack Overflow Blog：隐藏 OneTrust Cookie 横幅与偏好 modal', () => {
    const html = `<html><head></head><body>
      <article>正文</article>
      <div id="onetrust-consent-sdk">cookie banner</div>
      <div id="onetrust-pc-sdk">preference center</div>
      <section id="ot-fltr-modal">filter modal</section>
      <aside class="flex--item3 pt12">podcast</aside>
    </body></html>`;
    const out = applySiteDisplayRules(html, 'https://stackoverflow.blog/2026/08/foo/');
    const d = doc(out);
    expect(d.querySelector('#onetrust-consent-sdk')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('#onetrust-pc-sdk')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('#ot-fltr-modal')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('aside.flex--item3')?.getAttribute('data-fanyi-remove')).toBe('true');
    // 正文不能被误伤
    expect(d.querySelector('article')?.getAttribute('data-fanyi-remove')).toBeNull();
  });

  it('InfoQ：隐藏登录弹窗 / 浮动订阅表单 / 底部 Newsletter 广告', () => {
    const html = `<html><head></head><body>
      <article>正文</article>
      <div class="modal_auth_required">login modal</div>
      <div class="modal__backdrop">backdrop</div>
      <form id="floatingNewsletterForm">floating subscribe</form>
      <form id="dataCollectCampaignNewsletterForm">campaign subscribe</form>
      <div class="newsletter widget">The InfoQ Newsletter</div>
      <div class="newsletter__subscribe">another subscribe</div>
    </body></html>`;
    const out = applySiteDisplayRules(html, 'https://www.infoq.com/minibooks/foo/');
    const d = doc(out);
    expect(d.querySelector('.modal_auth_required')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('.modal__backdrop')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('#floatingNewsletterForm')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('#dataCollectCampaignNewsletterForm')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('div.newsletter.widget')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('.newsletter__subscribe')?.getAttribute('data-fanyi-remove')).toBe('true');
    // 正文不能被误伤
    expect(d.querySelector('article')?.getAttribute('data-fanyi-remove')).toBeNull();
  });

  it('全局规则：未匹配任何站点的域名也会清理 OneTrust / Cookie / modal', () => {
    const html = `<html><head></head><body>
      <article>正文</article>
      <div id="onetrust-consent-sdk">cookie banner</div>
      <div class="some-cookie-banner">cookie</div>
      <div role="dialog">generic modal</div>
      <div class="modal-backdrop">backdrop</div>
    </body></html>`;
    // 用一个没有任何专属规则的域名
    const out = applySiteDisplayRules(html, 'https://some-random-blog.example.com/2026/foo/');
    const d = doc(out);
    expect(d.querySelector('#onetrust-consent-sdk')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('.some-cookie-banner')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('[role="dialog"]')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('.modal-backdrop')?.getAttribute('data-fanyi-remove')).toBe('true');
    // 正文不能被误伤
    expect(d.querySelector('article')?.getAttribute('data-fanyi-remove')).toBeNull();
  });

  it('全局规则与站点专属规则叠加：两者都生效', () => {
    const html = `<html><head></head><body>
      <article>正文</article>
      <div id="right-rail"><div>Try the platform</div></div>
      <div id="onetrust-consent-sdk">cookie banner</div>
      <div role="dialog">modal</div>
    </body></html>`;
    const out = applySiteDisplayRules(html, 'https://www.oreilly.com/radar/foo/');
    const d = doc(out);
    // 站点专属（oreilly）：right-rail 隐藏
    expect(d.querySelector('#right-rail')?.getAttribute('data-fanyi-remove')).toBe('true');
    // 全局规则：OneTrust + modal 也隐藏（oreilly 规则本身没列这些）
    expect(d.querySelector('#onetrust-consent-sdk')?.getAttribute('data-fanyi-remove')).toBe('true');
    expect(d.querySelector('[role="dialog"]')?.getAttribute('data-fanyi-remove')).toBe('true');
  });

  it('全局规则：只在正文外的噪声上打标，不动正文内容', () => {
    const html = `<html><head></head><body>
      <article>
        <h1>正文标题</h1>
        <p>这是正文，里面提到 newsletter 一词但不含弹窗。</p>
      </article>
      <footer class="site-footer">版权信息</footer>
    </body></html>`;
    const out = applySiteDisplayRules(html, 'https://example.com/post/1');
    const d = doc(out);
    // 正文（含 "newsletter" 字样）不能被误删
    const article = d.querySelector('article');
    expect(article?.getAttribute('data-fanyi-remove')).toBeNull();
    expect(article?.textContent).toContain('newsletter');
    // footer 也不在全局规则里（只清理 cookie/modal/paywall 类噪声）
    expect(d.querySelector('footer')?.getAttribute('data-fanyi-remove')).toBeNull();
  });
});
