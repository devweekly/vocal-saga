/**
 * 诊断 github.blog 正文缺失问题。
 * 打印 root 选择、main 内部结构、以及可能的正文容器。
 */
import { fetchPage } from '../lib/translate/urlFetcher';
import { prepareDocument } from '../lib/translate/contentHelper';

const target = process.argv[2] || 'github.blog/ai-and-ml/github-copilot/better-tools-made-copilot-code-review-worse-heres-how-we-actually-improved-it/';
const url = `https://${target.replace(/^https?:\/\//, '')}`;

async function main() {
  console.log(`[Diagnose] Fetching ${url} ...`);
  const page = await fetchPage(url, { timeoutMs: 20_000 });
  console.log(`[Diagnose] Fetched ${page.finalUrl} status=${page.status} bytes=${page.html.length}`);

  const doc = page.doc;
  const main = doc.querySelector('main');
  if (!main) {
    console.log('[Diagnose] No <main> found');
    return;
  }
  console.log(`\n[Diagnose] <main> children (${main.children.length}):`);
  Array.from(main.children).forEach((c, i) => {
    const text = (c.textContent || '').trim().slice(0, 120).replace(/\s+/g, ' ');
    console.log(`  [${i}] <${c.tagName.toLowerCase()}> class="${c.className || ''}" id="${c.id || ''}" textLen=${(c.textContent || '').length} ${text}`);
  });

  // 尝试定位正文容器
  const possibleSelectors = [
    '.post__content',
    '.article-body',
    '.entry-content',
    '[class*="content"]',
    'article',
    'section',
  ];
  console.log('\n[Diagnose] Possible content containers:');
  for (const sel of possibleSelectors) {
    const els = Array.from(doc.querySelectorAll(sel));
    if (els.length === 0) continue;
    console.log(`  selector "${sel}" -> ${els.length} matches`);
    els.slice(0, 3).forEach((el, i) => {
      const text = (el.textContent || '').trim().slice(0, 120).replace(/\s+/g, ' ');
      console.log(`    [${i}] <${el.tagName.toLowerCase()}> class="${el.className || ''}" id="${el.id || ''}" textLen=${(el.textContent || '').length} ${text}`);
    });
  }

  // 运行 prepareDocument
  console.log('\n[Diagnose] Running prepareDocument ...');
  const { blocks, fullText, report } = prepareDocument(doc, page.finalUrl);
  console.log(`[Diagnose] blocks=${blocks.length} totalText=${fullText.length} strategy=${report.strategy} root=${report.rootSelector} confidence=${report.confidence}`);

  console.log('\n[Diagnose] All blocks:');
  blocks.forEach((b, i) => {
    console.log(`  [${i}] ${b.tag} "${b.text.slice(0, 100).replace(/\n/g, ' ')}"`);
  });
}

main().catch((err) => {
  console.error('[Diagnose] Failed:', err);
  process.exit(1);
});
