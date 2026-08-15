/**
 * 共享 Readability 映射器测试（vocal-saga 侧）。
 *
 * 同一组断言在 fanyi-extension 也有一份相同测试
 * （src/__tests__/readabilityRootMapper.test.ts），用于捕获两个
 * mapReadabilityToRoot 副本的语义漂移。
 *
 * 覆盖：
 *   1. 多锚点 LCA：单容器内多段 → 根落在容器级元素
 *   2. 多 section LCA：正文分散在多个 section → 根上爬到公共 wrapper
 *   3. 短正文：articleText < 200 → 返回 null
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mapReadabilityToRoot } from '../lib/translate/readabilityRootMapper';

function mkArticle(text: string) {
  return { textContent: text };
}

describe('shared readabilityRootMapper (vocal-saga)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('maps multi-anchor to the article container (LCA of paragraphs)', () => {
    const p1 =
      '这是第一段正文内容。Readability 提取出这一段作为首锚点，映射器需要在原始 DOM 中精确定位到它所在的段落块级元素并据此向上寻找稳定正文容器边界。';
    const p2 =
      '这是中间段落正文内容。映射器会均匀采样首中尾多个锚段落，避免旧版单签名方案在 related-articles 等噪声区发生定位碰撞误判，从而显著提升鲁棒性。';
    const p3 =
      '这是最后一段正文内容。多锚点定位后取所有命中块级元素的最低公共祖先作为最小稳定正文根，再用内容覆盖率而非裸文本长度来判定映射是否可信。';

    document.body.innerHTML = `
      <div class="sidebar">相关文章推荐区域不应被误判为正文根节点内容。</div>
      <article class="post">
        <h1>标题</h1>
        <p>${p1}</p>
        <p>${p2}</p>
        <p>${p3}</p>
      </article>`;

    const article = mkArticle([p1, p2, p3].join('\n'));
    const result = mapReadabilityToRoot(document, article);

    expect(result, 'mapping should succeed for valid article').not.toBeNull();
    const r = result!;
    expect(r.root.tagName.toLowerCase()).toBe('article');
    expect((r.root.className || '')).toContain('post');
    expect(r.matchedAnchors).toBe(3);
    expect(r.totalAnchors).toBe(3);
    expect(r.anchorCoverage).toBe(1);
    expect(r.mappingConfidence).toBeGreaterThanOrEqual(0.9);
    expect(r.contentCoverage).toBeGreaterThanOrEqual(0.9);
    expect(r.coverage).toBe(1);
  });

  it('climbs to wrapper when article spans multiple sections', () => {
    const a1 =
      '第一节第一段正文内容。这一段的字符数需要明显超过四十，用于验证跨 section 的最低公共祖先定位逻辑在嵌套结构下仍能正确归并到外层公共容器边界。';
    const a2 =
      '第一节第二段正文内容。同样需要明显超过四十字符，作为中间锚点参与多 section 结构映射，确保分布在不同层级的段落最终被同一个根节点所覆盖。';
    const a3 =
      '第二节第一段正文内容。用于验证两个不同 section 中的段落能够跨越结构边界正确归并到外层公共容器，而不是各自停留在所属 section 的层级上。';

    document.body.innerHTML = `
      <div class="article-wrapper">
        <section class="sec-a">
          <p>${a1}</p>
          <p>${a2}</p>
        </section>
        <section class="sec-b">
          <p>${a3}</p>
        </section>
      </div>`;

    const article = mkArticle([a1, a2, a3].join('\n'));
    const result = mapReadabilityToRoot(document, article);

    expect(result, 'multi-section mapping should succeed').not.toBeNull();
    const r = result!;
    expect(r.root.tagName.toLowerCase()).toBe('div');
    expect((r.root.className || '')).toContain('article-wrapper');
    expect(r.matchedAnchors).toBe(3);
    expect(r.anchorCoverage).toBe(1);
    expect(r.contentCoverage).toBeGreaterThanOrEqual(0.9);
  });

  it('returns null when Readability article text is too short', () => {
    document.body.innerHTML = `<article><p>太短了，不够两百字符的阈值要求，无法构成可信的正文映射输入。</p></article>`;
    const article = mkArticle('太短了，不够两百字符的阈值要求，无法构成可信的正文映射输入。');
    const result = mapReadabilityToRoot(document, article);
    expect(result).toBeNull();
  });
});
