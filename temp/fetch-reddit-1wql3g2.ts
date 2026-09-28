/**
 * 用 Playwright 抓取 Reddit 帖子渲染后的 HTML（shreddit 自定义元素水合后），
 * 供本地跑翻译管线诊断抽取问题。
 */
import { chromium } from 'playwright';
import * as fs from 'fs';

const URL =
  'https://www.reddit.com/r/ExperiencedDevs/comments/1wql3g2/interviewed_candidates_for_ai_engineer_roles_this/';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    // 用系统 Chrome，避免下载 Playwright 自带浏览器
    channel: 'chrome' as never,
    proxy: { server: 'http://127.0.0.1:10809' },
  });
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // 等 shreddit 自定义元素水合
  await page.waitForTimeout(8_000);

  // 滚到底触发懒加载评论
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(800);
  }

  const html = await page.content();
  fs.writeFileSync('temp/reddit-1wql3g2.html', html);
  console.log('saved', html.length, 'bytes');

  // 快速体检：关键元素是否出现
  const counts = await page.evaluate(() => ({
    post: document.querySelectorAll('shreddit-post').length,
    textBody: document.querySelectorAll('shreddit-post [slot="text-body"], shreddit-post .text-body').length,
    comments: document.querySelectorAll('shreddit-comment').length,
    md: document.querySelectorAll('div.md').length,
    title: document.title.slice(0, 80),
  }));
  console.log(JSON.stringify(counts, null, 2));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
