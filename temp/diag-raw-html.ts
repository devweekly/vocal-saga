import fs from 'fs';

const url = 'https://s.sunxiunan.com/article/332';
const resp = await fetch(url);
const html = await resp.text();

// 统计关键信息
const linkCount = (html.match(/<link\b/gi) || []).length;
const styleLinkCount = (html.match(/<link\s+[^>]*rel=["']stylesheet["']/gi) || []).length;
const scriptCount = (html.match(/<script\b/gi) || []).length;
const hasOnetrust = /onetrust-banner-sdk/.test(html);
const hasTpModal = /tp-modal/.test(html);
const cssLinks = [...html.matchAll(/<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);

console.log({
  status: resp.status,
  contentLength: html.length,
  linkCount,
  styleLinkCount,
  scriptCount,
  hasOnetrust,
  hasTpModal,
  cssLinks: cssLinks.slice(0, 20),
});

fs.writeFileSync('/tmp/article-332-raw.html', html);
console.log('原始 HTML 已保存: /tmp/article-332-raw.html');
