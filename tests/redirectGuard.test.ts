/**
 * redirectGuard 单测。
 *
 * 验证两件事：
 *   1. injectRedirectGuard 把守卫脚本注入到 <head> 最前面（含多种 HTML 结构的边界情况）
 *   2. 注入的守卫脚本在 jsdom（会自动执行 <script>）里真正生效——
 *      location.assign/replace、history.pushState/replaceState、window.open、
 *      meta refresh 全部被静默吞掉，URL 不变。
 *
 * vitest 已配置 environment: 'jsdom'，<script> 会被执行。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { injectRedirectGuard, REDIRECT_GUARD_SCRIPT } from '../lib/redirectGuard';

// 守卫脚本的固定标记，用于断言注入是否发生
const GUARD_MARKER = '__vsRedirectGuard';

describe('injectRedirectGuard — 注入位置', () => {
  it('有 <head> 时，脚本插到 <head> 内第一个子节点前', () => {
    const html = '<!doctype html><html><head><title>x</title></head><body></body></html>';
    const out = injectRedirectGuard(html);
    // 脚本出现在 <head> 之后、<title> 之前
    const headIdx = out.indexOf('<head>');
    const scriptIdx = out.indexOf('<script>');
    const titleIdx = out.indexOf('<title>');
    expect(headIdx).toBeLessThan(scriptIdx);
    expect(scriptIdx).toBeLessThan(titleIdx);
  });

  it('无 <head> 但有 <html> 时，补一个 <head> 放在最前', () => {
    const html = '<!doctype html><html><body>hi</body></html>';
    const out = injectRedirectGuard(html);
    expect(out).toContain('<head>');
    expect(out).toContain('<script>');
    // <head> 在 <body> 之前
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf('<body>'));
  });

  it('纯 HTML 片段（无 html/head）时，脚本前置拼接', () => {
    const html = '<div>fragment</div>';
    const out = injectRedirectGuard(html);
    expect(out.indexOf('<script>')).toBe(0);
    expect(out).toContain('<div>fragment</div>');
  });

  it('带属性的 <head> 标签也能正确识别', () => {
    const html = '<html><head data-x="1"><meta charset="utf-8"></head></html>';
    const out = injectRedirectGuard(html);
    // 脚本应该在 <head data-x="1"> 之后
    expect(out).toMatch(/<head data-x="1"><script>/);
  });

  it('不破坏原始正文内容', () => {
    const html = '<html><head></head><body><p>正文保留</p></body></html>';
    const out = injectRedirectGuard(html);
    expect(out).toContain('<p>正文保留</p>');
  });
});

describe('守卫脚本运行时行为', () => {
  beforeEach(() => {
    // 守卫脚本用 __vsRedirectGuard 标志防重复注入，每个 case 前清掉，
    // 保证每次都能重新 patch（jsdom 的 window 在测试间是同一个实例）。
    delete (window as any)[GUARD_MARKER];
  });

  /**
   * 把守卫脚本当成"页面最前面的 <script>"直接执行到当前 jsdom window。
   * 生产环境里这段脚本由 injectRedirectGuard 注入，浏览器加载时自动执行；
   * jsdom 经 DOMParser 不执行脚本，所以这里手动 eval 来模拟真实执行。
   */
  function runGuard() {
    // eslint-disable-next-line no-eval
    (0, eval)(REDIRECT_GUARD_SCRIPT);
  }

  it('拦截 location.assign（不抛错、URL 不变）', () => {
    runGuard();
    expect((window as any)[GUARD_MARKER]).toBe(true);
    // assign 已被替换为空操作；调用不应抛错
    expect(() => window.location.assign('https://evil.com')).not.toThrow();
    expect(window.location.href).not.toContain('evil.com');
  });

  it('拦截 location.replace（不抛错、URL 不变）', () => {
    runGuard();
    expect(() => window.location.replace('https://evil.com')).not.toThrow();
    expect(window.location.href).not.toContain('evil.com');
  });

  it('拦截 history.pushState（地址栏不变）', () => {
    runGuard();
    const before = window.location.pathname;
    window.history.pushState({}, '', '/hijacked');
    expect(window.location.pathname).toBe(before);
  });

  it('拦截 history.replaceState（地址栏不变）', () => {
    runGuard();
    const before = window.location.pathname;
    window.history.replaceState({}, '', '/hijacked');
    expect(window.location.pathname).toBe(before);
  });

  it('拦截 window.open（返回 null，不打开新窗口）', () => {
    runGuard();
    const result = window.open('https://evil.com', '_blank');
    expect(result).toBeNull();
  });

  it('移除已存在的 <meta http-equiv="refresh">', () => {
    // 先把 meta refresh 放进当前 document，再执行守卫
    document.head.innerHTML = '<meta http-equiv="refresh" content="0;url=https://evil.com">';
    runGuard();
    expect(document.querySelector('meta[http-equiv="refresh" i]')).toBeNull();
  });
});
