/**
 * processTranslationHtml 集成测试 —— 验证「缓存 HTML → 展示期处理后」的
 * 关键修复是否真的作用到 DOM：
 *   - GitHub 翻译不被 hydration 覆盖（article/601）
 *   - Oreilly 侧栏被 data-fanyi-remove 隐藏（article/588）
 *   - X.com 正文列加宽（article/585）
 *   - Towards Data Science 图片不再超大（article/579）
 *
 * 这里复刻 lib/app.ts 中 processTranslationHtml 的调用顺序（不导出该函数，
 * 故直接复刻），确保各子步骤级联正确。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseHTML } from 'linkedom';
import { stripDangerousScripts } from '../lib/spaGuard';
import { devirtualizeLayout } from '../lib/devirtualize';
import { injectRedirectGuard } from '../lib/redirectGuard';
import { injectTranslationCss } from '../lib/app';
import { applyGlobalNoiseFromUrl } from '../lib/translate/contentHelper';
import { applySiteDisplayRules } from '../lib/translate/displayRules';

function processTranslationHtml(html: string, pageUrl?: string): string {
  const reread = pageUrl ? applyGlobalNoiseFromUrl(html, pageUrl) : html;
  const processed = injectRedirectGuard(
    injectTranslationCss(devirtualizeLayout(stripDangerousScripts(reread))),
  );
  return pageUrl ? applySiteDisplayRules(processed, pageUrl) : processed;
}

function load(id: number): string {
  return readFileSync(`${process.cwd()}/tests/fixtures/a${id}.html`, 'utf8');
}

// 把缓存 HTML 落地为 fixture（CI 不含这些大文件，本地/手动验证用）
function ensureFixture(id: number, url: string) {
  const path = `${process.cwd()}/tests/fixtures/a${id}.html`;
  // 仅在文件缺失时尝试下载，避免每次跑测试都联网
  if (!require('fs').existsSync(path)) {
    // 由调用方提前用 curl 抓取，这里只做存在性检查
    throw new Error(`fixture missing: ${path} (curl ${url} -o ${path})`);
  }
  return path;
}

describe('processTranslationHtml 集成（article/588/579/585/601）', () => {
  // 这些 fixture 由外部 curl 抓取后放入 tests/fixtures/，CI 跳过
  const cases: Array<{ id: number; url: string; host: string }> = [
    { id: 588, url: 'https://www.oreilly.com/radar/architectural-guardrails.html', host: 'https://www.oreilly.com/radar/x' },
    { id: 579, url: 'https://towardsdatascience.com/x', host: 'https://towardsdatascience.com/x' },
    { id: 585, url: 'https://x.com/UberEng/status/1', host: 'https://x.com/UberEng/status/1' },
    { id: 601, url: 'https://github.com/anthropics/commerce-agents', host: 'https://github.com/anthropics/commerce-agents' },
  ];

  for (const c of cases) {
    it(`article/${c.id}: 展示期处理后结构正确`, () => {
      let html: string;
      try {
        html = load(c.id);
      } catch {
        // 没有 fixture 时跳过（CI 环境）
        console.warn(`[skip] fixture a${c.id}.html not present`);
        return;
      }
      const out = processTranslationHtml(html, c.host);
      const { document } = parseHTML(out) as unknown as { document: Document };

      if (c.id === 588) {
        const rail = document.querySelector('#right-rail');
        expect(rail?.getAttribute('data-fanyi-remove')).toBe('true');
        // 关键：TRANSLATION_CSS 必须含隐藏规则，否则标记了也不隐藏
        expect(out).toContain('[data-fanyi-remove="true"]{display:none');
      }
      if (c.id === 585) {
        const siteCss = document.querySelector('style[data-fanyi-site-css]')?.textContent || '';
        expect(siteCss).toContain('max-width: 1000px');
      }
      if (c.id === 579) {
        const siteCss = document.querySelector('style[data-fanyi-site-css]')?.textContent || '';
        expect(siteCss).toContain('position: static !important');
        expect(siteCss).toContain('max-width: 720px');
      }
      if (c.id === 601) {
        // GitHub 的 githubassets hydration <script> 必须被剥离，否则 react-partial
        // 会用客户端 DOM 覆盖 SSR 翻译 DOM（article/601 译文消失）。
        // 注意：<link rel="modulepreload" href="...githubassets...js"> 只是预加载提示、
        // 不会执行，不在检查范围；真正触发 hydration 的是 <script type=module src>。
        expect(out).not.toMatch(/<script\b[^>]*githubassets\.com\/assets\/[^"]*\.js[^>]*>/i);
      }
    });
  }

  // 把 ensureFixture 引用一下，避免未使用告警
  void ensureFixture;
});
