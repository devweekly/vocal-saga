import { describe, it, expect, beforeEach } from 'vitest';
import { parseHTML } from 'linkedom';
import { extractBlocks } from '../lib/translate/blockExtractor';
import { clearSiteRuleCache } from '../lib/translate/blockExtractor/rules';

function setupXHtml(html: string): Document {
  const { document } = parseHTML('<!doctype html><html><body>' + html + '</body></html>') as unknown as { document: Document };
  return document;
}

beforeEach(() => {
  clearSiteRuleCache();
});

describe('x-rules extraction', () => {
  it('extracts tweet text but skips metadata (timestamp, views, quote link, video overlay)', () => {
    const doc = setupXHtml(`
      <main>
        <article data-testid="tweet" role="article">
          <div data-testid="User-Name">
            <span>Nous Research</span>
            <span>@NousResearch</span>
          </div>
          <a aria-label="显示翻译">显示翻译</a>
          <div data-testid="tweetText">
            <span>For our Accelerated Business Hackathon with @NVIDIAAI and @stripe, we asked builders to make agents that can earn, spend, and run real operations at any scale.</span>
          </div>
          <div data-testid="videoComponent">
            <span>1:05</span>
            <span>来自 Nous Research</span>
          </div>
          <a href="/NousResearch/status/2077517414464410091" aria-label="上午6:15 · 2026年7月16日">上午6:15 · 2026年7月16日</a>
          <a href="/NousResearch/status/2077517414464410091/analytics">9.7万 查看</a>
          <a href="/NousResearch/status/2077517414464410091/quotes">查看引用</a>
          <div role="group" aria-label="回复">
            <button data-testid="reply">回复</button>
            <button data-testid="retweet">转帖</button>
            <button data-testid="like">喜欢</button>
          </div>
        </article>
      </main>
    `);

    const blocks = extractBlocks(doc, 'https://x.com/NousResearch/status/2077517414464410091');
    const texts = blocks.map((b) => b.text);

    expect(texts).toContain('For our Accelerated Business Hackathon with @NVIDIAAI and @stripe, we asked builders to make agents that can earn, spend, and run real operations at any scale.');

    expect(texts.some((t) => t.includes('Nous Research'))).toBe(false);
    expect(texts.some((t) => t.includes('@NousResearch'))).toBe(false);
    expect(texts.some((t) => t.includes('显示翻译'))).toBe(false);
    expect(texts.some((t) => t.includes('1:05'))).toBe(false);
    expect(texts.some((t) => t.includes('来自 Nous Research'))).toBe(false);
    expect(texts.some((t) => t.includes('上午6:15'))).toBe(false);
    expect(texts.some((t) => t.includes('2026年7月16日'))).toBe(false);
    expect(texts.some((t) => t.includes('9.7万'))).toBe(false);
    expect(texts.some((t) => t.includes('查看'))).toBe(false);
    expect(texts.some((t) => t.includes('回复'))).toBe(false);
    expect(texts.some((t) => t.includes('转帖'))).toBe(false);
    expect(texts.some((t) => t.includes('喜欢'))).toBe(false);
  });

  it('extracts reply tweet text but skips reply timestamps', () => {
    const doc = setupXHtml(`
      <main>
        <article data-testid="tweet" role="article">
          <div data-testid="tweetText">
            <span>1st place: Custodian, by Daniel LaForce (@MHArgonaut). When an agent can spend money, something external to the agent has to decide what it is allowed to do.</span>
          </div>
          <a href="/NousResearch/status/2077517417425543632" aria-label="12小时 前">12小时</a>
          <a href="/NousResearch/status/2077517417425543632/analytics">2.1万</a>
        </article>
      </main>
    `);

    const blocks = extractBlocks(doc, 'https://x.com/NousResearch/status/2077517414464410091');
    const texts = blocks.map((b) => b.text);

    expect(texts).toContain('1st place: Custodian, by Daniel LaForce (@MHArgonaut). When an agent can spend money, something external to the agent has to decide what it is allowed to do.');
    expect(texts.some((t) => t.includes('12小时'))).toBe(false);
    expect(texts.some((t) => t.includes('2.1万'))).toBe(false);
  });
});
