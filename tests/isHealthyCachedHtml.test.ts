// isHealthyCachedHtml 单元测试
//
// 背景：openai.com 的缓存（D1 id=608，2.3MB 译文完整）被判 unhealthy，
// 导致每次访问都重新 fetch 源站 → 源站现在 403 → 用户看到 500。
// 根因：pipeline 早期产物没有字面量 `<html>` 标签，只有 `<!doctype html>`，
// 而健康检查（含 validateTranslationCompleteness）都硬性要求 `<html`。
// 本测试锁定这个回归：doctype-only 文档必须判为健康。

import { describe, it, expect } from 'vitest';
import { isHealthyCachedHtml } from '../lib/app';
import { hasDocumentRoot, validateTranslationCompleteness } from '../lib/translate/translationValidator';

/** 构造一个"译文完整"的最小文档：有内联样式 + 双语标记 + 非空译文 */
function buildDoc({ root }: { root: 'html' | 'doctype-only' }): string {
  const body = `<head><base href="https://example.com/a"><style>.site{color:red}</style></head>
<body><p><span class="fanyi-original">Hello</span><span class="fanyi-translation">你好</span></p></body>`;
  return root === 'html'
    ? `<!doctype html>\n<html>${body}</html>`
    : `<!doctype html>\n${body}`;
}

describe('hasDocumentRoot', () => {
  it('接受标准 <html> 文档', () => {
    expect(hasDocumentRoot('<!doctype html><html><body></body></html>')).toBe(true);
  });

  it('接受只有 doctype、没有 <html> 包裹的旧 pipeline 产物', () => {
    expect(hasDocumentRoot('<!doctype html><body><head></head></body>')).toBe(true);
  });

  it('既有 doctype 又有 html 标签时也成立', () => {
    expect(hasDocumentRoot('<!DOCTYPE HTML><html lang="en"></html>')).toBe(true);
  });

  it('两者都缺则判不完整', () => {
    expect(hasDocumentRoot('<body><p>hi</p></body>')).toBe(false);
    expect(hasDocumentRoot('')).toBe(false);
  });
});

describe('validateTranslationCompleteness — 文档根节点', () => {
  it('regression: 无 <html> 但有 doctype 的 openai.com 式缓存不再被判缺少 <html>', () => {
    const r = validateTranslationCompleteness(buildDoc({ root: 'doctype-only' }));
    expect(r.healthy).toBe(true);
  });

  it('标准 <html> 文档照常通过', () => {
    expect(validateTranslationCompleteness(buildDoc({ root: 'html' })).healthy).toBe(true);
  });

  it('doctype 和 <html> 都没有 → 仍判不健康', () => {
    // 长度需 >100，否则会先被"HTML 过短"拦下
    const html = `<body><p>${'占位内容 '.repeat(20)}</p><span class="fanyi-translation">你好</span></body>`;
    const r = validateTranslationCompleteness(html);
    expect(r.healthy).toBe(false);
    expect(r.reason).toMatch(/doctype/);
  });
});

describe('isHealthyCachedHtml', () => {
  it('regression（openai.com id=608）：doctype-only + 内联样式 + 完整译文 → healthy', () => {
    expect(isHealthyCachedHtml(buildDoc({ root: 'doctype-only' }))).toBe(true);
  });

  it('标准 <html> + 内联样式 + 完整译文 → healthy', () => {
    expect(isHealthyCachedHtml(buildDoc({ root: 'html' }))).toBe(true);
  });

  it('有外联样式表 → healthy', () => {
    const html =
      '<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.com/a.css"></head>' +
      '<body><span class="fanyi-translation">你好</span></body></html>';
    expect(isHealthyCachedHtml(html)).toBe(true);
  });

  it('既无 doctype 也无 <html> → unhealthy', () => {
    const html = '<body><style>.a{color:red}</style><span class="fanyi-translation">你好</span></body>';
    expect(isHealthyCachedHtml(html)).toBe(false);
  });

  it('只剩 OneTrust / fanyi 样式的空壳文档 → unhealthy', () => {
    const html =
      '<!doctype html><html><head>' +
      '<style>#onetrust-banner-sdk{display:none}</style>' +
      '<style>/* 双语对照样式 */.fanyi-translation{display:block}</style>' +
      '</head><body><span class="fanyi-translation">你好</span></body></html>';
    expect(isHealthyCachedHtml(html)).toBe(false);
  });

  it('<base> 位于相对路径样式表之后 → unhealthy', () => {
    const html =
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css">' +
      '<base href="https://example.com/a"></head>' +
      '<body><span class="fanyi-translation">你好</span></body></html>';
    expect(isHealthyCachedHtml(html)).toBe(false);
  });

  it('缺少翻译标记 → unhealthy', () => {
    // 长度需 >100 且有内联样式，才能走到"翻译标记"这一关
    const html = `<!doctype html><html><head><style>.a{color:red}</style></head><body><p>${'没有译文的正文 '.repeat(20)}</p></body></html>`;
    expect(isHealthyCachedHtml(html)).toBe(false);
  });

  it('超过 50% 译文为空 → unhealthy', () => {
    const html =
      '<!doctype html><html><head><style>.a{color:red}</style></head><body>' +
      '<span class="fanyi-translation"></span>' +
      '<span class="fanyi-translation"></span>' +
      '<span class="fanyi-translation">你好</span>' +
      '</body></html>';
    expect(isHealthyCachedHtml(html)).toBe(false);
  });
});
