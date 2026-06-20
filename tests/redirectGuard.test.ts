/**
 * redirectGuard 单测。
 *
 * 验证两件事：
 *   1. injectRedirectGuard 把守卫脚本注入到 <head> 最前面（含多种 HTML 结构的边界情况）
 *   2. 注入的守卫脚本在 jsdom（会自动执行 <script>）里真正生效——
 *      仅拦截会导致离开当前翻译页的跨 origin / 跨 pathname 跳转，
 *      同页 hash 跳转与外部新窗口行为尽量保留。
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

  it('拦截跨页 location.assign（不抛错、URL 不变）', () => {
    runGuard();
    expect((window as any)[GUARD_MARKER]).toBe(true);
    const before = window.location.href;
    expect(() => window.location.assign('https://evil.com/hijack')).not.toThrow();
    expect(window.location.href).toBe(before);
  });

  it('拦截跨页 location.replace（不抛错、URL 不变）', () => {
    runGuard();
    const before = window.location.href;
    expect(() => window.location.replace('https://evil.com/hijack')).not.toThrow();
    expect(window.location.href).toBe(before);
  });

  it('同页 hash location.assign 允许', () => {
    runGuard();
    const before = window.location.href;
    window.location.assign('#section-1');
    expect(window.location.hash).toBe('#section-1');
    expect(window.location.pathname).toBe(new URL(before).pathname);
  });

  it('拦截跨页 history.pushState（地址栏 pathname 不变）', () => {
    runGuard();
    const before = window.location.pathname;
    window.history.pushState({}, '', '/hijacked');
    expect(window.location.pathname).toBe(before);
  });

  it('拦截跨页 history.replaceState（地址栏 pathname 不变）', () => {
    runGuard();
    const before = window.location.pathname;
    window.history.replaceState({}, '', '/hijacked');
    expect(window.location.pathname).toBe(before);
  });

  it('同页 hash history.pushState 允许', () => {
    runGuard();
    const before = window.location.pathname;
    window.history.pushState({}, '', '#section-2');
    expect(window.location.hash).toBe('#section-2');
    expect(window.location.pathname).toBe(before);
  });

  it('window.open 外部 _blank 链接不拦截且当前页不跳转', () => {
    runGuard();
    const before = window.location.href;
    expect(() => window.open('https://external-example.com/', '_blank')).not.toThrow();
    expect(window.location.href).toBe(before);
  });

  it('window.open 当前窗口内部跨页链接被拦截（返回 null）', () => {
    runGuard();
    const result = window.open('/hijacked', '_self');
    expect(result).toBeNull();
  });

  it('移除已存在的 <meta http-equiv="refresh">', () => {
    // 先把 meta refresh 放进当前 document，再执行守卫
    document.head.innerHTML = '<meta http-equiv="refresh" content="0;url=https://evil.com">';
    runGuard();
    expect(document.querySelector('meta[http-equiv="refresh" i]')).toBeNull();
  });

  it('动态注入的 <meta http-equiv="refresh"> 会被移除', () => {
    runGuard();
    const meta = document.createElement('meta');
    meta.setAttribute('http-equiv', 'refresh');
    meta.setAttribute('content', '0;url=https://evil.com');
    document.head.appendChild(meta);
    // MutationObserver 是异步的，需要等一轮微任务
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(document.querySelector('meta[http-equiv="refresh" i]')).toBeNull();
        resolve();
      }, 0);
    });
  });
});
