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
});
