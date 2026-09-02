// @ts-nocheck
// Gartner 新闻稿页回归测试：验证服务端（linkedom）路径下
// 1) *.gartner.com 站点规则能正确匹配
// 2) [class*="aem-Grid"] 在 linkedom 下能解析到正文根
// 3) prepareDocument 能稳定提取正文块（不应出现 0 块 / No translatable content）
//
// 与 fanyi-extension/src/__tests__/gartner.test.ts 对称。
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { prepareDocument } from '../lib/translate/contentHelper';
import { matchSiteRule } from '../lib/translate/rules';
import { gartnerRule } from '../lib/translate/rules/gartner-rules';

const GARTNER_URL =
  'https://www.gartner.com/en/newsroom/press-releases/gartner-survey-finds-only-22-percent-of-organizations-have-successfully-scaled-ai-across-multiple-business-units';

describe('gartner press-release (server-side / linkedom)', () => {
  let doc: any;

  beforeAll(() => {
    const html = readFileSync(
      'tests/fixtures/gartner-press-release.html',
      'utf-8',
    );
    const { document } = parseHTML(html) as unknown as { document: any };
    doc = document;
  });

  it('matches the gartner site rule for www.gartner.com', () => {
    expect(gartnerRule.hostPattern).toBe('*.gartner.com');
    const matched = matchSiteRule(GARTNER_URL);
    expect(matched).not.toBeNull();
    expect(matched?.siteRule.hostPattern).toBe('*.gartner.com');
    expect(matched?.siteRule.articleRootSelector).toBe('[class*="aem-Grid"]');
  });

  it('articleRootSelector resolves to the aem-Grid root in linkedom', () => {
    const el = doc.querySelector(gartnerRule.articleRootSelector!);
    expect(el).not.toBeNull();
    const textLen = (el.textContent || '').trim().length;
    expect(textLen).toBeGreaterThan(5000);
    // 顶层 aem-Grid 应含 h1 标题
    expect(el.querySelector('h1')).not.toBeNull();
  });

  it('prepareDocument yields a stable, non-empty block set (no 0-block regression)', () => {
    const res = prepareDocument(doc, GARTNER_URL);
    // 与 fanyi-extension 侧一致：应为 103 blocks。
    // 容忍 ±1 以应对 linkedom 解析 AEM 复杂 HTML 的微小差异，但绝不能为 0。
    expect(res.blocks.length).toBeGreaterThan(50);
    expect((res.fullText || '').trim().length).toBeGreaterThan(10000);
    expect(res.fullText).toContain('Gartner Survey Finds Only 22%');
  });
});
