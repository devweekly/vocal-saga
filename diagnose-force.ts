/**
 * 诊断 /force/<target> 翻译失败原因。
 *
 * 本脚本直接复现 vocal-saga 服务端抓取 + 内容提取流程，但不真正调用 LLM，
 * 用于定位「是抓不到正文」还是「翻译服务失败」。
 */
import { fetchPage } from './lib/translate/urlFetcher';
import { prepareDocument } from './lib/translate/contentHelper';

const target = process.argv[2] || 'llm-as-a-verifier.com';
const url = `https://${target.replace(/^https?:\/\//, '')}`;

async function main() {
  console.log(`[Diagnose] Fetching ${url} ...`);
  const page = await fetchPage(url, { timeoutMs: 20_000 });
  console.log(`[Diagnose] Fetched ${page.finalUrl} status=${page.status} bytes=${page.html.length}`);

  console.log(`[Diagnose] Extracting blocks ...`);
  const { blocks, chunks, fullText } = prepareDocument(page.doc, page.finalUrl);
  console.log(`[Diagnose] blocks=${blocks.length} chunks=${chunks.length} totalText=${fullText.length}`);

  blocks.slice(0, 10).forEach((b, i) => {
    console.log(`  [${i}] ${b.tag} ${b.text.slice(0, 100).replace(/\n/g, ' ')}...`);
  });
  if (blocks.length > 10) {
    console.log('  ...');
    blocks.slice(-3).forEach((b, i) => {
      console.log(`  [${blocks.length - 3 + i}] ${b.tag} ${b.text.slice(0, 100).replace(/\n/g, ' ')}...`);
    });
  }
}

main().catch((err) => {
  console.error('[Diagnose] Failed:', err);
  process.exit(1);
});
