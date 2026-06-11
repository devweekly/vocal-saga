/**
 * Smoke test: 验证编译后的模块能正常 import，extractBlocks 能在 jsdom 上跑通。
 *
 * 不调 DeepSeek（避免耗 token），只验证：
 *   1. 所有 .ts 模块能 import
 *   2. extractBlocks 能在 jsdom Document 上跑
 *   3. buildChunks 正确切分
 *   4. cacheManager.get/set 内存层工作
 */
import { JSDOM } from 'jsdom';

// 把 jsdom 注入 Node 全局，让 blockExtractor 内的 `Document` 引用有效
const dom = new JSDOM('<html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Document = dom.window.Document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.Text = dom.window.Text;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.WeakSet = dom.window.WeakSet || globalThis.WeakSet;

const { extractBlocks } = await import('../lib/translate/blockExtractor/index.ts');
const { buildChunks } = await import('../lib/translate/chunkBuilder.ts');
const { generateTranslationCacheKey } = await import('../lib/translate/cacheKey.ts');
const { translationCache } = await import('../lib/translate/cacheManager.ts');

async function main() {
  console.log('=== Smoke test: vocal-saga translation lib ===\n');

  // 1. extractBlocks
  const html = `
    <html><body>
      <article>
        <h1>Hello World</h1>
        <p>This is a short paragraph that should be picked up by the extractor.</p>
        <p>Another paragraph with enough length to pass the MIN_TEXT_LENGTH check.</p>
        <h2>A subsection</h2>
        <p>Yet another paragraph to test that multiple blocks get extracted correctly.</p>
      </article>
    </body></html>
  `;
  const dom = new JSDOM(html);
  const blocks = extractBlocks(dom.window.document);
  console.log(`[1] extractBlocks → ${blocks.length} blocks`);
  for (const b of blocks) {
    console.log(`    - <${b.tag}> "${b.text.slice(0, 50)}${b.text.length > 50 ? '…' : ''}"`);
  }
  if (blocks.length === 0) throw new Error('extractBlocks returned 0 blocks');

  // 2. buildChunks
  const chunks = buildChunks(blocks);
  console.log(`[2] buildChunks → ${chunks.length} chunks`);
  for (const c of chunks) {
    console.log(`    - ${c.id}: ${c.blocks.length} blocks, ~${c.estimatedTokens} tokens`);
  }
  if (chunks.length === 0) throw new Error('buildChunks returned 0 chunks');

  // 3. cacheKey
  const key1 = generateTranslationCacheKey(chunks[0].jsonContent, 'en', 'zh');
  const key2 = generateTranslationCacheKey(chunks[0].jsonContent, 'en', 'zh');
  const key3 = generateTranslationCacheKey(chunks[0].jsonContent, 'en', 'ja');
  console.log(`[3] cacheKey stable: ${key1 === key2} (en→zh)`);
  console.log(`[3] cacheKey differs: ${key1 !== key3} (en→zh vs en→ja)`);
  if (key1 !== key2) throw new Error('cache key not stable for same input');
  if (key1 === key3) throw new Error('cache key not unique across target langs');

  // 4. cacheManager in-memory layer
  await translationCache.set('test:key', { foo: 'bar' }, 60_000);
  const got = await translationCache.get<{ foo: string }>('test:key');
  console.log(`[4] translationCache.set/get → ${JSON.stringify(got)}`);
  if (got?.foo !== 'bar') throw new Error('cache roundtrip failed');

  console.log('\n=== All checks passed ===');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
