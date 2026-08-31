import { describe, it, expect, beforeEach } from 'vitest';
import { parseHTML } from 'linkedom';
import { extractBlocks } from '../lib/translate/blockExtractor';
import { clearSiteRuleCache } from '../lib/translate/blockExtractor/rules';
import { markGlobalNoise } from '../lib/translate/contentHelper';

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

  it('offline reader: hides both left nav (in <header>) and right sidebarColumn, keeps primaryColumn', () => {
    const doc = setupXHtml(`
      <header>
        <nav aria-label="主要">
          <a>主页</a><a>探索</a><a>通知</a>
        </nav>
      </header>
      <main role="main">
        <div class="flex-wrapper">
          <div data-testid="primaryColumn">
            <article data-testid="tweet" role="article">
              <div data-testid="tweetText"><span>这是需要保留的正文内容。</span></div>
            </article>
          </div>
          <div class="right-col">
            <div data-testid="sidebarColumn">
              <span>趋势</span><span>推荐关注</span>
            </div>
          </div>
        </div>
      </main>
    `);

    markGlobalNoise(doc, 'https://x.com/NousResearch/status/1');

    // 左导航 header 被标记移除
    const header = doc.querySelector('header');
    expect(header?.hasAttribute('data-fanyi-remove')).toBe(true);
    // 右栏 sidebarColumn 被标记移除
    const sidebar = doc.querySelector('[data-testid="sidebarColumn"]');
    expect(sidebar?.hasAttribute('data-fanyi-remove')).toBe(true);
    // 中间内容列（含 primaryColumn）不被标记
    const primary = doc.querySelector('[data-testid="primaryColumn"]');
    expect(primary?.hasAttribute('data-fanyi-remove')).toBe(false);
    expect(primary?.parentElement?.hasAttribute('data-fanyi-remove')).toBe(false);
    // 正文仍可被抽取
    const blocks = extractBlocks(doc, 'https://x.com/NousResearch/status/1');
    expect(blocks.map((b) => b.text)).toContain('这是需要保留的正文内容。');
  });

  it('offline reader: does NOT remove a header that lives inside <main> (tweet detail top bar)', () => {
    const doc = setupXHtml(`
      <header><nav aria-label="主要"><a>主页</a></nav></header>
      <main role="main">
        <header><a>← 返回</a></header>
        <div data-testid="primaryColumn"><span>正文</span></div>
      </main>
    `);
    markGlobalNoise(doc, 'https://x.com/NousResearch/status/1');
    const headers = Array.from(doc.querySelectorAll('header'));
    // 仅顶层左导航 header 被移除；main 内的返回栏 header 保留
    expect(headers[0].hasAttribute('data-fanyi-remove')).toBe(true);
    expect(headers[1].hasAttribute('data-fanyi-remove')).toBe(false);
  });

  it('offline reader: no-op when primaryColumn absent (SPA skeleton / non-X host)', () => {
    const doc = setupXHtml(`
      <main role="main">
        <div data-testid="sidebarColumn"><span>趋势</span></div>
      </main>
    `);
    markGlobalNoise(doc, 'https://example.com/foo');
    // 非 x.com 主机不应触发移除；且因无 primaryColumn，X 逻辑也不应误伤
    expect(doc.querySelector('[data-fanyi-remove="true"]')).toBeNull();
  });
});
