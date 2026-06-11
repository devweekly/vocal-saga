/**
 * 一次性脚本：把 fanyi-extension 的测试文件按改写后的 import 路径
 * 批量复制到 tests/。
 *
 * 路径映射：
 *   ../entrypoints/utils/   →  ../lib/translate/
 *   ../entrypoints/service/ →  ../lib/translate/service/
 *   ../rules                →  ../lib/translate/rules
 *   ../entrypoints/content/ →  （浏览器端模块，丢弃）
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = '/Users/saga/code-repos/fanyi-extension/src/__tests__';
const DST = '/Users/saga/code-repos/vocal-saga/tests';

// 哪些测试适配（其余浏览器独有，丢弃）
const KEEP = [
  'blockExtractor.test.ts',
  'cacheKey.test.ts',
  'cacheManager.test.ts',
  'chunkBuilder.test.ts',
  'chunkRetry.test.ts',
  'contentHelper.test.ts',
  'streamParser.test.ts',
  'translationDisplay.test.ts',
  'translationQueue.test.ts',
  'glossaryExtractor.test.ts',
  'deepseek-prompt.test.ts',
  'deepseek-api.test.ts',
  'deepseek-stream.test.ts',
  'translateApi.test.ts',
];

const pathReplacements = [
  ["../entrypoints/utils/", "../lib/translate/"],
  ["../entrypoints/service/", "../lib/translate/service/"],
  ["from '../rules'", "from '../lib/translate/rules'"],
  ["'../rules'", "'../lib/translate/rules'"],
];

function rewrite(content) {
  let out = content;
  for (const [from, to] of pathReplacements) {
    out = out.split(from).join(to);
  }
  return out;
}

if (!existsSync(DST)) mkdirSync(DST, { recursive: true });

const report = [];
for (const file of KEEP) {
  const srcPath = join(SRC, file);
  if (!existsSync(srcPath)) {
    report.push(`SKIP ${file} (not in source)`);
    continue;
  }
  const original = readFileSync(srcPath, 'utf8');
  const rewritten = rewrite(original);
  const dstPath = join(DST, file);
  writeFileSync(dstPath, rewritten);
  report.push(`OK   ${file}  (${original.length} → ${rewritten.length} bytes)`);
}

console.log('--- Bulk test import report ---');
for (const r of report) console.log(r);
