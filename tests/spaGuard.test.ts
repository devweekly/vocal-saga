/**
 * spaGuard 单测。
 *
 * 验证 stripHydrationScripts 能删除 SPA hydration chunk 脚本，同时保留
 * 非 chunk 脚本、内联脚本和翻译内容。
 */
import { describe, it, expect } from 'vitest';
import { stripHydrationScripts } from '../lib/spaGuard';
import { injectRedirectGuard } from '../lib/redirectGuard';

describe('stripHydrationScripts', () => {
  it('删除 Next.js chunk 脚本', () => {
    const html = `
      <html>
        <head>
          <script src="https://example.com/_next/static/chunks/main-123.js"></script>
          <script src="https://example.com/_next/static/chunks/framework-456.js"></script>
        </head>
        <body><p class="fanyi-translation">译文</p></body>
      </html>
    `;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('_next/static/chunks/main-123.js');
    expect(out).not.toContain('_next/static/chunks/framework-456.js');
    expect(out).toContain('<p class="fanyi-translation">译文</p>');
  });

  it('删除 Next.js streaming root script（id="_R_"）', () => {
    const html = `
      <html>
        <head>
          <script src="https://example.com/_next/static/chunks/main-123.js" id="_R_"></script>
        </head>
        <body></body>
      </html>
    `;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('id="_R_"');
  });

  it('保留非 Next.js 脚本（如 analytics、inline 配置）', () => {
    const html = `
      <html>
        <head>
          <script src="https://www.googletagmanager.com/gtag/js?id=G-XXX"></script>
          <script>window.dataLayer = [];</script>
          <script src="https://example.com/_next/static/chunks/app-789.js"></script>
        </head>
        <body></body>
      </html>
    `;
    const out = stripHydrationScripts(html);
    expect(out).toContain('googletagmanager.com/gtag/js?id=G-XXX');
    expect(out).toContain('window.dataLayer = []');
    expect(out).not.toContain('_next/static/chunks/app-789.js');
  });

  it('与 injectRedirectGuard 组合使用时不会误删 redirect guard 脚本', () => {
    const html = '<html><head><title>x</title></head><body><p class="fanyi-translation">译文</p></body></html>';
    const guarded = injectRedirectGuard(html);
    const out = stripHydrationScripts(guarded);
    // redirect guard 是内联 script，应保留
    expect(out).toContain('__vsRedirectGuard');
    expect(out).not.toContain('_next/static/chunks');
    expect(out).toContain('<p class="fanyi-translation">译文</p>');
  });

  it('保留不含 chunk 的普通相对路径脚本', () => {
    const html = '<script src="/assets/common.js"></script><script src="/_next/static/chunks/x.js"></script>';
    const out = stripHydrationScripts(html);
    expect(out).toContain('/assets/common.js');
    expect(out).not.toContain('/_next/static/chunks/x.js');
  });

  it('删除 X/Twitter SPA 脚本和 Cloudflare JSD 挑战脚本', () => {
    const html = `
      <html>
        <head>
          <script src="https://abs.twimg.com/responsive-web/client-web/main.ea67863a.js"></script>
          <script src="https://abs.twimg.com/responsive-web/client-web/vendor.bd8db7da.js"></script>
          <script src="https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload"></script>
        </head>
        <body>
          <p class="fanyi-translation">译文</p>
        </body>
      </html>
    `;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('abs.twimg.com/responsive-web/client-web/main.ea67863a.js');
    expect(out).not.toContain('abs.twimg.com/responsive-web/client-web/vendor.bd8db7da.js');
    expect(out).not.toContain('cdn-cgi/challenge-platform/scripts/jsd/api.js');
    expect(out).toContain('<p class="fanyi-translation">译文</p>');
  });

  it('删除 X/Twitter __INITIAL_STATE__ 内联脚本', () => {
    const html = `
      <html>
        <body>
          <script>window.__INITIAL_STATE__={"optimist":[],"entities":{}}</script>
          <p class="fanyi-translation">译文</p>
        </body>
      </html>
    `;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('__INITIAL_STATE__');
    expect(out).toContain('<p class="fanyi-translation">译文</p>');
  });

  it('删除 Cloudflare JSD jsdOnload 内联脚本', () => {
    const html = `
      <html>
        <body>
          <script>window.jsdOnload = function () { if (window.cloudflare && window.cloudflare.jsd) {} };</script>
          <p class="fanyi-translation">译文</p>
        </body>
      </html>
    `;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('jsdOnload');
    expect(out).toContain('<p class="fanyi-translation">译文</p>');
  });

  it('删除 Nuxt.js 客户端构建脚本', () => {
    const html = `
      <html>
        <head>
          <script src="/_nuxt/entry.a1b2c3d.js"></script>
          <script src="/_nuxt/pages/index.d4e5f6.js"></script>
        </head>
        <body><p class="fanyi-translation">译文</p></body>
      </html>
    `;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('_nuxt/entry.a1b2c3d.js');
    expect(out).not.toContain('_nuxt/pages/index.d4e5f6.js');
    expect(out).toContain('fanyi-translation');
  });

  it('删除 Nuxt.js __NUXT__ 全局状态注入', () => {
    const html = `
      <html><body>
        <script>window.__NUXT__ = (function (a, b) { return { data: [] } }(1, 2))</script>
        <p class="fanyi-translation">译文</p>
      </body></html>
    `;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('__NUXT__');
    expect(out).toContain('fanyi-translation');
  });

  it('删除 SvelteKit 客户端模块', () => {
    const html = `
      <html>
        <head>
          <script type="module" src="/svelte-kit/assets/app.a1b2c3.js"></script>
        </head>
        <body><p class="fanyi-translation">译文</p></body>
      </html>
    `;
    const out = stripHydrationScripts(html);
    expect(out).not.toContain('svelte-kit');
    expect(out).toContain('fanyi-translation');
  });

  it('保留无关的内联脚本（如 analytics 配置）', () => {
    const html = `
      <script>window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-7RBK99YSES');</script>
    `;
    const out = stripHydrationScripts(html);
    expect(out).toContain('window.dataLayer');
    expect(out).toContain("gtag('config'");
  });

  it('模拟 X/Twitter 翻译页面完整场景（含全部问题脚本）', () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <script src="https://abs.twimg.com/responsive-web/client-web/ondemand.s.54ce248a.js"></script>
          <script>document.cookie="lang=zh-CN; Path=/";</script>
          <script>window.__INITIAL_STATE__={"optimist":[]}</script>
          <script>window.jsdOnload = function() {};</script>
          <script src="https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload"></script>
          <script src="https://abs.twimg.com/responsive-web/client-web/vendor.bd8db7da.js"></script>
          <script src="https://abs.twimg.com/responsive-web/client-web/main.ea67863a.js"></script>
          <script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
        </head>
        <body>
          <p class="fanyi-translation">这是翻译内容</p>
          <p>Original text</p>
        </body>
      </html>
    `;
    const out = stripHydrationScripts(html);
    // 问题脚本全部移除
    expect(out).not.toContain('abs.twimg.com');
    expect(out).not.toContain('cdn-cgi/challenge-platform');
    expect(out).not.toContain('__INITIAL_STATE__');
    expect(out).not.toContain('jsdOnload');
    // 无害脚本保留
    expect(out).toContain('document.cookie="lang=zh-CN');
    expect(out).toContain('securepubads.g.doubleclick.net');
    // 翻译内容保留
    expect(out).toContain('这是翻译内容');
    expect(out).toContain('Original text');
  });
});
