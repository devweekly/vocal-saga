/**
 * devirtualize 单测 — Virtual Layout 去虚拟化。
 *
 * 验证服务端 DOM rewrite 能正确移除 Virtual Scroller 的 inline 定位样式，
 * 让浏览器用普通 block flow 自动排版。
 */
import { describe, it, expect } from 'vitest';
import { devirtualizeLayout } from '../lib/devirtualize';

describe('devirtualizeLayout', () => {
  it('移除 cellInnerDiv 的 position:absolute 和 transform', () => {
    const html = `<html><body>
      <div data-testid="cellInnerDiv" style="position:absolute;transform:translateY(5227px);top:0;left:0;width:100%">
        <p>_tweet content_</p>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).not.toContain('translateY');
    expect(out).not.toContain('position:absolute');
    expect(out).toContain('position:static');
    expect(out).toContain('_tweet content_');
  });

  it('保留非定位样式（color、font、margin）', () => {
    const html = `<html><body>
      <div data-testid="cellInnerDiv" style="position:absolute;transform:translateY(100px);color:red;font-size:16px;margin:10px">
        <p>content</p>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).toContain('color:red');
    expect(out).toContain('font-size:16px');
    expect(out).toContain('margin:10px');
    expect(out).not.toContain('translateY');
    expect(out).not.toContain('position:absolute');
  });

  it('清理 cellInnerDiv 祖先链的 absolute 定位', () => {
    const html = `<html><body>
      <div style="position:absolute;top:0;left:0;height:10000px;overflow:auto">
        <div style="position:relative">
          <div data-testid="cellInnerDiv" style="position:absolute;transform:translateY(200px)">
            <p>tweet</p>
          </div>
        </div>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    // cellInnerDiv 自身
    expect(out).not.toContain('translateY');
    // 祖先也被清理
    expect(out).toContain('position:static');
    // 保留 relative（不是 absolute，不需要改）
  });

  it('清理带 translate 的通用元素', () => {
    const html = `<html><body>
      <div style="transform:translate3d(0,100px,0);position:absolute;top:50px">
        <p>virtual item</p>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).not.toContain('translate3d');
    expect(out).not.toContain('position:absolute');
    expect(out).not.toContain('top:50px');
  });

  it('移除 Timeline 容器的高度限制和 overflow', () => {
    const html = `<html><body>
      <div style="height:10000px;overflow:auto;position:relative">
        <div aria-label="Timeline" style="height:5000px;overflow:hidden;max-height:5000px">
          <div data-testid="cellInnerDiv" style="position:absolute;transform:translateY(0px)">
            <p>tweet 1</p>
          </div>
        </div>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    // Timeline 的 height 和 overflow 被移除
    expect(out).not.toContain('height:5000px');
    expect(out).not.toContain('overflow:hidden');
    expect(out).not.toContain('max-height:5000px');
    // 祖先的 height 和 overflow 也被移除
    expect(out).not.toContain('height:10000px');
    expect(out).not.toContain('overflow:auto');
    // cellInnerDiv 的 translate 被移除
    expect(out).not.toContain('translateY');
  });

  it('不处理 position:relative 的元素', () => {
    const html = `<html><body>
      <div style="position:relative;top:10px;left:5px">
        <p>relative element</p>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).toContain('position:relative');
    expect(out).toContain('top:10px');
  });

  it('不处理 position:sticky 的元素', () => {
    const html = `<html><body>
      <div style="position:sticky;top:0;z-index:100">
        <p>sticky header</p>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).toContain('position:sticky');
    expect(out).toContain('z-index:100');
  });

  it('模拟 Twitter 完整页面', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="https://abs.twimg.com/responsive-web/client-web/main.css">
    </head><body>
      <div data-testid="primaryColumn" style="height:100vh;overflow-y:auto">
        <div aria-label="Timeline" style="height:10000px;overflow:hidden">
          <div data-testid="cellInnerDiv" style="position:absolute;transform:translateY(0px);width:100%;top:0">
            <article data-testid="tweet"><p>Tweet 1</p></article>
          </div>
          <div data-testid="cellInnerDiv" style="position:absolute;transform:translateY(5227px);width:100%;top:0">
            <article data-testid="tweet"><p>Tweet 2</p></article>
          </div>
        </div>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    // Virtual 定位被移除
    expect(out).not.toContain('translateY(5227px)');
    expect(out).not.toContain('position:absolute');
    // CSS 保留
    expect(out).toContain('main.css');
    // 内容保留
    expect(out).toContain('Tweet 1');
    expect(out).toContain('Tweet 2');
    // 高度限制移除
    expect(out).not.toContain('height:10000px');
    expect(out).not.toContain('overflow:hidden');
  });

  it('空 style 不报错', () => {
    const html = `<html><body><div data-testid="cellInnerDiv"><p>content</p></div></body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).toContain('content');
  });

  it('无 cellInnerDiv 的页面不受影响', () => {
    const html = `<html><body>
      <div style="color:blue;font-size:14px"><p>normal page</p></div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).toContain('color:blue');
    expect(out).toContain('font-size:14px');
    expect(out).toContain('normal page');
  });

  it('移除 Substack 订阅弹窗（role=dialog + subscribe）', () => {
    const html = `<html><body>
      <article><p class="fanyi-translation">正文译文</p></article>
      <div role="dialog" aria-label="Subscribe modal" class="subscribeDialog-ApxQJS" style="position:absolute;top:100px;left:50px">
        <p>Subscribe now!</p>
        <p>立即订阅</p>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).not.toContain('subscribeDialog');
    expect(out).not.toContain('Subscribe modal');
    expect(out).toContain('正文译文');
  });

  it('移除 paywall modal', () => {
    const html = `<html><body>
      <article><p class="fanyi-translation">正文</p></article>
      <div class="paywall-modal-overlay">
        <p>Subscribe to continue reading</p>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).not.toContain('paywall-modal');
    expect(out).toContain('正文');
  });

  it('移除 SVG 内的 <title> 元素（避免 HTML 解析器陷阱）', () => {
    // SVG <title> 是 HTML integration point，里面的 <path .../> 不自闭合，
    // 会导致后续 HTML 内容被困在 SVG 内部
    const html = `<html><body>
      <article>
        <div class="post-header"><h1>Title</h1></div>
        <button>
          <svg class="icon"><g><title><path d="M2.53 7.8" /></title></g></svg>
        </button>
        <div><div class="available-content">
          <div class="body markup">
            <p class="fanyi-translation">正文译文第一段</p>
            <p class="fanyi-translation">正文译文第二段</p>
          </div>
        </div></div>
      </article>
    </body></html>`;
    const out = devirtualizeLayout(html);
    // SVG <title> 应被移除
    expect(out).not.toContain('<title>');
    // 正文内容应保留
    expect(out).toContain('正文译文第一段');
    expect(out).toContain('正文译文第二段');
  });
});
