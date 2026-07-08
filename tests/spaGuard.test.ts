/**
 * spaGuard 单测 — 两层分离架构。
 *
 * stripNavigationScripts：只删 Cloudflare JSD 挑战（第一层）
 * stripHydrationScripts：删 SPA bootstrap + chunk（第二层）
 * stripDangerousScripts：组合便捷函数
 */
import { describe, it, expect } from 'vitest';
import {
  stripNavigationScripts,
  stripHydrationScripts,
  stripDangerousScripts,
} from '../lib/spaGuard';
import { injectRedirectGuard } from '../lib/redirectGuard';

// ════════════════════════════════════════════════════════════
// 第一层：stripNavigationScripts
// ════════════════════════════════════════════════════════════

describe('stripNavigationScripts（第一层：导航防护）', () => {
  it('删除 Cloudflare JSD 挑战外部脚本', () => {
    const html = `<html><head>
      <script src="https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload"></script>
    </head><body><p>content</p></body></html>`;
    const out = stripNavigationScripts(html);
    expect(out).not.toContain('cdn-cgi/challenge-platform');
    expect(out).toContain('content');
  });

  it('删除 JSD 内联回调定义', () => {
    const html = `<html><body>
      <script>window.jsdOnload = function() { cloudflare.init(); };</script>
      <p>content</p>
    </body></html>`;
    const out = stripNavigationScripts(html);
    expect(out).not.toContain('jsdOnload');
    expect(out).toContain('content');
  });

  it('保留 SPA chunk 脚本（不删 hydration 入口）', () => {
    const html = `<html><head>
      <script src="https://abs.twimg.com/responsive-web/client-web/main.ea67863a.js"></script>
      <script src="/_next/static/chunks/main-123.js"></script>
    </head><body>content</body></html>`;
    const out = stripNavigationScripts(html);
    expect(out).toContain('abs.twimg.com');
    expect(out).toContain('_next/static/chunks');
  });

  it('保留 SPA bootstrap 数据（不删 __INITIAL_STATE__ / __next_f）', () => {
    const html = `<html><body>
      <script>window.__INITIAL_STATE__={"optimist":[]}</script>
      <script>self.__next_f.push([1,"3:I[79520"])</script>
    </body></html>`;
    const out = stripNavigationScripts(html);
    expect(out).toContain('__INITIAL_STATE__');
    expect(out).toContain('__next_f');
  });

  it('保留无害脚本（analytics 等）', () => {
    const html = `<script>window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-7RBK99YSES');</script>
      <script>document.cookie="lang=zh-CN; Path=/";</script>`;
    const out = stripNavigationScripts(html);
    expect(out).toContain('window.dataLayer');
    expect(out).toContain("gtag('config'");
    expect(out).toContain('document.cookie');
  });
});

// ════════════════════════════════════════════════════════════
// 第二层：stripHydrationScripts
// ════════════════════════════════════════════════════════════

describe('stripHydrationScripts（第二层：hydration 防护）', () => {
  it('删除 X/Twitter SPA chunk（abs.twimg.com）', () => {
    const html = `<html><head>
      <script src="https://abs.twimg.com/responsive-web/client-web/main.ea67863a.js"></script>
      <script src="https://abs.twimg.com/responsive-web/client-web/vendor.bd8db7da.js"></script>
    </head><body><p class="fanyi-translation">译文</p></body></html>`;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('abs.twimg.com/responsive-web');
    expect(out).toContain('fanyi-translation');
  });

  it('删除 X/Twitter __INITIAL_STATE__', () => {
    const html = `<html><body>
      <script>window.__INITIAL_STATE__={"optimist":[],"entities":{}}</script>
      <p class="fanyi-translation">译文</p>
    </body></html>`;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('__INITIAL_STATE__');
    expect(out).toContain('fanyi-translation');
  });

  it('删除 Next.js streaming data（self.__next_f.push）', () => {
    const html = `<html><body>
      <script>self.__next_f.push([1,"3:I[79520,[\\"]")</script>
      <script>self.__next_f.push([1,"0:{\\\"P\\\":null}"])</script>
      <p class="fanyi-translation">译文</p>
    </body></html>`;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('__next_f');
    expect(out).toContain('fanyi-translation');
  });

  it('删除 Next.js chunk 脚本', () => {
    const html = `<html><head>
      <script src="/_next/static/chunks/main-abc.js"></script>
      <script src="/_next/static/chunks/webpack-123.js"></script>
    </head><body>content</body></html>`;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('_next/static/chunks');
  });

  it('删除 Nuxt.js __NUXT__ 和 chunk', () => {
    const html = `<html><head>
      <script src="/_nuxt/entry.a1b2c3d.js"></script>
    </head><body>
      <script>window.__NUXT__ = (function (a, b) { return { data: [] } }(1, 2))</script>
    </body></html>`;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('__NUXT__');
    expect(out).not.toContain('_nuxt/entry');
  });

  it('删除 SvelteKit chunk 和内联数据', () => {
    const html = `<html><head>
      <script type="module" src="/svelte-kit/assets/app.a1b2c3.js"></script>
    </head><body>
      <script>__sveltekit = { base: '', assets: '' }</script>
    </body></html>`;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('svelte-kit');
    expect(out).not.toContain('__sveltekit');
  });

  it('保留 CSS link 标签（样式不丢失）', () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/_next/static/css/main.css">
      <link rel="stylesheet" href="https://abs.twimg.com/responsive-web/client-web/main.css">
    </head><body>content</body></html>`;
    const out = stripHydrationScripts(html);
    expect(out).toContain('rel="stylesheet"');
    expect(out).toContain('main.css');
  });

  it('保留 Cloudflare JSD 挑战脚本（不重复处理第一层职责）', () => {
    const html = `<html><head>
      <script src="https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js"></script>
    </head><body>content</body></html>`;
    const out = stripHydrationScripts(html);
    // Hydration 层不管 JSD，由 Navigation 层处理
    expect(out).toContain('cdn-cgi/challenge-platform');
  });
});

// ════════════════════════════════════════════════════════════
// 组合：stripDangerousScripts
// ════════════════════════════════════════════════════════════

describe('stripDangerousScripts（组合：导航 + hydration）', () => {
  it('同时删除 JSD 和 SPA chunk/bootstrap', () => {
    const html = `<html><head>
      <script src="https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js"></script>
      <script src="https://abs.twimg.com/responsive-web/client-web/main.ea67863a.js"></script>
      <script>window.__INITIAL_STATE__={"optimist":[]}</script>
      <script>window.jsdOnload = function() {};</script>
    </head><body>
      <p class="fanyi-translation">译文</p>
      <p>Original text</p>
    </body></html>`;
    const out = stripDangerousScripts(html);
    // JSD 删除（第一层）
    expect(out).not.toContain('cdn-cgi/challenge-platform');
    expect(out).not.toContain('jsdOnload');
    // SPA chunk 删除（第二层）
    expect(out).not.toContain('abs.twimg.com/responsive-web');
    expect(out).not.toContain('__INITIAL_STATE__');
    // 翻译内容保留
    expect(out).toContain('fanyi-translation');
    expect(out).toContain('Original text');
  });

  it('与 injectRedirectGuard 组合使用不误删 guard 脚本', () => {
    const html = '<html><head><title>x</title></head><body><p class="fanyi-translation">译文</p></body></html>';
    const guarded = injectRedirectGuard(html);
    const out = stripDangerousScripts(guarded);
    expect(out).toContain('__vsRedirectGuard');
    expect(out).toContain('fanyi-translation');
  });

  it('模拟 X/Twitter 翻译页面完整场景', () => {
    const html = `<!doctype html><html><head>
      <script src="https://abs.twimg.com/responsive-web/client-web/ondemand.s.54ce248a.js"></script>
      <script>document.cookie="lang=zh-CN; Path=/";</script>
      <script>window.__INITIAL_STATE__={"optimist":[]}</script>
      <script>window.jsdOnload = function() {};</script>
      <script src="https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload"></script>
      <script src="https://abs.twimg.com/responsive-web/client-web/vendor.bd8db7da.js"></script>
      <script src="https://abs.twimg.com/responsive-web/client-web/main.ea67863a.js"></script>
      <script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
      <link rel="stylesheet" href="https://abs.twimg.com/responsive-web/client-web/main.css">
    </head><body>
      <p class="fanyi-translation">这是翻译内容</p>
      <p>Original text</p>
    </body></html>`;
    const out = stripDangerousScripts(html);
    // JSD 删除
    expect(out).not.toContain('cdn-cgi/challenge-platform');
    expect(out).not.toContain('jsdOnload');
    // SPA chunk 和 bootstrap 删除
    expect(out).not.toContain('__INITIAL_STATE__');
    expect(out).not.toContain('abs.twimg.com/responsive-web/client-web/main.ea67863a.js');
    expect(out).not.toContain('abs.twimg.com/responsive-web/client-web/vendor.bd8db7da.js');
    // CSS 保留
    expect(out).toContain('abs.twimg.com/responsive-web/client-web/main.css');
    // 无害脚本保留
    expect(out).toContain('document.cookie="lang=zh-CN');
    expect(out).toContain('securepubads.g.doubleclick.net');
    // 翻译内容保留
    expect(out).toContain('这是翻译内容');
    expect(out).toContain('Original text');
  });

  it('模拟 Next.js 翻译页面完整场景', () => {
    const html = `<!doctype html><html><head>
      <script src="/_next/static/chunks/main-abc.js"></script>
      <script>self.__next_f.push([1,"3:I[79520"])</script>
      <script>self.__next_f.push([1,"0:{\\\"P\\\":null}"])</script>
      <script src="https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js"></script>
    </head><body>
      <p class="fanyi-translation">译文内容</p>
      <p>Original text</p>
    </body></html>`;
    const out = stripDangerousScripts(html);
    // JSD 删除
    expect(out).not.toContain('cdn-cgi/challenge-platform');
    // Next.js chunk 和 streaming data 删除
    expect(out).not.toContain('_next/static/chunks');
    expect(out).not.toContain('__next_f');
    // 翻译内容保留
    expect(out).toContain('译文内容');
    expect(out).toContain('Original text');
  });
});
