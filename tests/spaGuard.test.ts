/**
 * spaGuard 单测。
 *
 * 验证 stripDangerousScripts 只删除 Cloudflare JSD 挑战脚本，
 * 保留所有 SPA chunk 脚本和 bootstrap 数据，让 SPA 正常初始化和应用样式。
 * 循环跳转由 redirectGuard 拦截 reload/assign/replace 兜底。
 */
import { describe, it, expect } from 'vitest';
import { stripDangerousScripts } from '../lib/spaGuard';
import { injectRedirectGuard } from '../lib/redirectGuard';

describe('stripDangerousScripts', () => {
  it('删除 Cloudflare JSD 挑战脚本', () => {
    const html = `
      <html>
        <head>
          <script src="https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload"></script>
        </head>
        <body><p>content</p></body>
      </html>
    `;
    const out = stripDangerousScripts(html);
    expect(out).not.toContain('cdn-cgi/challenge-platform');
    expect(out).toContain('content');
  });

  it('删除 JSD 内联回调定义', () => {
    const html = `
      <html><body>
        <script>window.jsdOnload = function() { cloudflare.init(); };</script>
        <p>content</p>
      </body></html>
    `;
    const out = stripDangerousScripts(html);
    expect(out).not.toContain('jsdOnload');
    expect(out).toContain('content');
  });

  it('保留 Next.js streaming data（self.__next_f.push）', () => {
    const html = `
      <html><body>
        <script>self.__next_f.push([1,"3:I[79520,[\\"]")</script>
        <script>self.__next_f.push([1,"0:{\\\"P\\\":null}"])</script>
        <p class="fanyi-translation">译文</p>
      </body></html>
    `;
    const out = stripDangerousScripts(html);
    expect(out).toContain('__next_f');
    expect(out).toContain('fanyi-translation');
  });

  it('保留 X/Twitter __INITIAL_STATE__ 内联脚本', () => {
    const html = `
      <html><body>
        <script>window.__INITIAL_STATE__={"optimist":[],"entities":{}}</script>
        <p class="fanyi-translation">译文</p>
      </body></html>
    `;
    const out = stripDangerousScripts(html);
    expect(out).toContain('__INITIAL_STATE__');
    expect(out).toContain('fanyi-translation');
  });

  it('保留 Nuxt.js __NUXT__ 全局状态注入', () => {
    const html = `
      <html><body>
        <script>window.__NUXT__ = (function (a, b) { return { data: [] } }(1, 2))</script>
        <p class="fanyi-translation">译文</p>
      </body></html>
    `;
    const out = stripDangerousScripts(html);
    expect(out).toContain('__NUXT__');
    expect(out).toContain('fanyi-translation');
  });

  it('保留 SPA chunk 脚本（Next.js / Nuxt / SvelteKit / X/Twitter）', () => {
    const html = `
      <html>
        <head>
          <script src="/_next/static/chunks/main-123.js"></script>
          <script src="/_nuxt/entry.a1b2c3d.js"></script>
          <script type="module" src="/svelte-kit/assets/app.a1b2c3.js"></script>
          <script src="https://abs.twimg.com/responsive-web/client-web/main.ea67863a.js"></script>
        </head>
        <body><p>content</p></body>
      </html>
    `;
    const out = stripDangerousScripts(html);
    expect(out).toContain('_next/static/chunks/main-123.js');
    expect(out).toContain('_nuxt/entry.a1b2c3d.js');
    expect(out).toContain('svelte-kit');
    expect(out).toContain('abs.twimg.com/responsive-web/client-web/main.ea67863a.js');
  });

  it('保留无关的内联脚本（analytics 配置等）', () => {
    const html = `
      <script>window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-7RBK99YSES');</script>
      <script>document.cookie="lang=zh-CN; Path=/";</script>
    `;
    const out = stripDangerousScripts(html);
    expect(out).toContain('window.dataLayer');
    expect(out).toContain("gtag('config'");
    expect(out).toContain('document.cookie');
  });

  it('与 injectRedirectGuard 组合使用时不会误删 redirect guard 脚本', () => {
    const html = '<html><head><title>x</title></head><body><p class="fanyi-translation">译文</p></body></html>';
    const guarded = injectRedirectGuard(html);
    const out = stripDangerousScripts(guarded);
    expect(out).toContain('__vsRedirectGuard');
    expect(out).toContain('fanyi-translation');
  });

  it('模拟 X/Twitter 翻译页面完整场景', () => {
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
    const out = stripDangerousScripts(html);
    // JSD 脚本和回调删除
    expect(out).not.toContain('cdn-cgi/challenge-platform');
    expect(out).not.toContain('jsdOnload');
    // SPA bootstrap 数据保留（让 SPA 正常初始化和应用样式）
    expect(out).toContain('__INITIAL_STATE__');
    // SPA chunk 保留（提供样式）
    expect(out).toContain('abs.twimg.com/responsive-web/client-web/main.ea67863a.js');
    expect(out).toContain('abs.twimg.com/responsive-web/client-web/vendor.bd8db7da.js');
    // 无害脚本保留
    expect(out).toContain('document.cookie="lang=zh-CN');
    expect(out).toContain('securepubads.g.doubleclick.net');
    // 翻译内容保留
    expect(out).toContain('这是翻译内容');
    expect(out).toContain('Original text');
  });

  it('模拟 Next.js 翻译页面完整场景', () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <script src="/_next/static/chunks/main-abc.js"></script>
          <script>self.__next_f.push([1,"3:I[79520"])</script>
          <script>self.__next_f.push([1,"0:{\\\"P\\\":null}"])</script>
          <script src="https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js"></script>
        </head>
        <body>
          <p class="fanyi-translation">译文内容</p>
          <p>Original text</p>
        </body>
      </html>
    `;
    const out = stripDangerousScripts(html);
    // JSD 删除
    expect(out).not.toContain('cdn-cgi/challenge-platform');
    // streaming data 保留（让 Next.js 正常 hydrate）
    expect(out).toContain('__next_f');
    // chunk 保留
    expect(out).toContain('_next/static/chunks/main-abc.js');
    // 翻译内容保留
    expect(out).toContain('译文内容');
    expect(out).toContain('Original text');
  });
});
