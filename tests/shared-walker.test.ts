/**
 * 双 walker 共享 fixture 测试（vocal-saga 侧）。
 * 见 tests/fixtures/article-roots.ts 的说明：同一组结构在 fanyi-extension 也有一份
 * 相同测试，用于捕获两个 blockExtractor 副本的语义漂移。
 */
import { describe, it, expect } from 'vitest';
import { extractBlocks } from '../lib/translate/blockExtractor';
import { ARTICLE_ROOT_FIXTURES } from './fixtures/article-roots';

describe('shared walker fixtures (vocal-saga)', () => {
  for (const fx of ARTICLE_ROOT_FIXTURES) {
    it(`extracts body paragraphs for: ${fx.name}`, () => {
      document.body.innerHTML = fx.html;
      const blocks = extractBlocks(document, fx.url);
      const allText = blocks.map((b) => b.text).join('\n');
      for (const expected of fx.expectTexts) {
        expect(allText, `expected "${expected}" to be extracted from ${fx.name}`).toContain(
          expected,
        );
      }
    });
  }
});
