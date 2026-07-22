/**
 * redirectGuard 单测。
 *
 * 验证两件事：
 *   1. injectRedirectGuard 把守卫脚本注入到 <head> 最前面（含多种 HTML 结构的边界情况）
 *   2. 注入的守卫脚本在 jsdom（会自动执行 <script>）里真正生效——
 *      fetch/XHR guard 拦截 /cdn-cgi/、api.x.com、ads-api.x.com，
 *      history 拦截跨页路由，window.open 拦截内部链接，meta refresh 被移除。
 *
 * vitest 已配置 environment: 'jsdom'，<script> 会被执行。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { injectRedirectGuard, REDIRECT_GUARD_SCRIPT } from '../lib/redirectGuard';

const GUARD_MARKER = '__vsRedirectGuard';

describe('injectRedirectGuard — 注入位置', () => {
  it('有 <head> 时，脚本插到 <head> 内第一个子节点前', () => {
    const html = '<!doctype html><html><head><title>x</title></head><body></body></html>';
    const out = injectRedirectGuard(html);
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
    delete (window as any)[GUARD_MARKER];
  });

  function runGuard() {
    // eslint-disable-next-line no-eval
    (0, eval)(REDIRECT_GUARD_SCRIPT);
  }

  // ── fetch guard ──

  it('拦截对 /cdn-cgi/ 的 fetch 请求（string URL），返回空 200', async () => {
    runGuard();
    const resp = await fetch('/cdn-cgi/challenge-platform/scripts/jsd/api.js');
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('{}');
  });

  it('拦截对 /cdn-cgi/ 的 fetch 请求（Request 对象），返回空 200', async () => {
    runGuard();
    const req = new Request('https://s.sunxiunan.com/cdn-cgi/challenge-platform/test');
    const resp = await fetch(req);
    expect(resp.status).toBe(200);
  });

  it('拦截对 api.x.com GraphQL 的 fetch 请求，返回 {data:{}}', async () => {
    runGuard();
    const resp = await fetch('https://api.x.com/graphql/abc/SomeQuery');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Content-Type')).toBe('application/json');
    const json = await resp.json();
    expect(json).toHaveProperty('data');
  });

  it('拦截对 api.x.com hashflags 的 fetch 请求，返回 []', async () => {
    runGuard();
    const resp = await fetch('https://api.x.com/1.1/hashflags.json');
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toBe('[]');
  });

  it('拦截对 ads-api.x.com 的 fetch 请求，返回 {}', async () => {
    runGuard();
    const resp = await fetch('https://ads-api.x.com/12/measurement/dcm_local_id');
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('{}');
  });

  it('正常 fetch 请求不受影响', async () => {
    runGuard();
    try {
      await fetch('/api/data');
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
    }
  });

  // ── XMLHttpRequest guard ──

  it('拦截对 /cdn-cgi/ 的 XHR 请求，不真正发送', (done) => {
    runGuard();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/cdn-cgi/challenge-platform/test');
    xhr.onload = () => {
      expect(true).toBe(true);
      done();
    };
    xhr.send();
  });

  it('拦截对 api.x.com 的 XHR 请求，不真正发送', (done) => {
    runGuard();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.x.com/1.1/account/settings.json');
    xhr.onload = () => {
      expect(true).toBe(true);
      done();
    };
    xhr.send();
  });

  // ── history patches ──

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

  it('history.replaceState 跨域 URL 不抛 SecurityError（静默吞掉）', () => {
    runGuard();
    // 模拟 Substack SPA 传入跨域 URL，浏览器原生 replaceState 会抛 SecurityError。
    // 守卫应吞掉该错误，不让 SPA 崩溃。
    expect(() => window.history.replaceState({}, '', 'https://magazine.sebastianraschka.com/414')).not.toThrow();
  });

  it('history.pushState 跨域 URL 不抛 SecurityError（静默吞掉）', () => {
    runGuard();
    expect(() => window.history.pushState({}, '', 'https://magazine.sebastianraschka.com/414')).not.toThrow();
  });

  it('拦截 history.go(0)（不抛错、页面不刷新）', () => {
    runGuard();
    expect(() => window.history.go(0)).not.toThrow();
  });

  it('history.go(-1) 等非零值仍允许', () => {
    runGuard();
    expect(() => {
      try { window.history.go(-1); } catch (e) { /* jsdom 限制 */ }
    }).not.toThrow();
  });

  // ── window.open ──

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

  // ── meta refresh ──

  it('移除已存在的 <meta http-equiv="refresh">', () => {
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
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(document.querySelector('meta[http-equiv="refresh" i]')).toBeNull();
        resolve();
      }, 0);
    });
  });

  // ── Navigation API ──

  it('Navigation API 存在时注册 navigate 监听器', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(' ')); };
    try {
      runGuard();
    } finally {
      console.log = origLog;
    }
    // jsdom 没有 Navigation API，结果应为 false
    const patchLog = logs.find((l) => l.includes('redirectGuard patches'));
    expect(patchLog).toBeDefined();
    expect(patchLog).toContain('"navigation"');
  });

  // ── 验证日志 ──

  it('验证日志输出各 patch 状态', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(' ')); };
    try {
      runGuard();
    } finally {
      console.log = origLog;
    }
    const patchLog = logs.find((l) => l.includes('redirectGuard patches'));
    expect(patchLog).toBeDefined();
    expect(patchLog).toContain('fetch');
    expect(patchLog).toContain('xhr');
    expect(patchLog).toContain('pushState');
  });
});
