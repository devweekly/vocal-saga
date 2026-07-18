#!/usr/bin/env npx tsx
// 跨项目同步校验脚本
// 读取 CROSS_PROJECT_SYNC.md 中"完全一致"的模块列表,自动 diff 两端文件
// 用法:npx tsx scripts/check-sync.ts
// CI 中有差异则 exit 1

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VOCAL_SAGA = '/Users/saga/code-repos/vocal-saga';
const FANYI_EXTENSION = '/Users/saga/code-repos/fanyi-extension';

// "完全一致"模块对照表(来自 CROSS_PROJECT_SYNC.md §一)
const SYNC_PAIRS: Array<{ name: string; server: string; extension: string }> = [
  { name: 'cacheKey', server: 'lib/translate/cacheKey.ts', extension: 'src/entrypoints/utils/cacheKey.ts' },
  { name: 'chunkRetry', server: 'lib/translate/chunkRetry.ts', extension: 'src/entrypoints/utils/chunkRetry.ts' },
  { name: 'translationQueue', server: 'lib/translate/translationQueue.ts', extension: 'src/entrypoints/utils/translationQueue.ts' },
  { name: 'service/_service', server: 'lib/translate/service/_service.ts', extension: 'src/entrypoints/service/_service.ts' },
  { name: 'service/streamParser', server: 'lib/translate/service/streamParser.ts', extension: 'src/entrypoints/service/streamParser.ts' },
  { name: 'glossaryExtractor', server: 'lib/translate/glossaryExtractor.ts', extension: 'src/entrypoints/utils/glossaryExtractor.ts' },
  { name: 'tech-products.json', server: 'lib/translate/tech-products.json', extension: 'src/entrypoints/utils/tech-products.json' },
  { name: 'rules/github', server: 'lib/translate/rules/github-rules.ts', extension: 'src/rules/github-rules.ts' },
  { name: 'rules/fortune', server: 'lib/translate/rules/fortune-rules.ts', extension: 'src/rules/fortune-rules.ts' },
  { name: 'rules/hackernews', server: 'lib/translate/rules/hackernews-rules.ts', extension: 'src/rules/hackernews-rules.ts' },
  { name: 'rules/reddit', server: 'lib/translate/rules/reddit-rules.ts', extension: 'src/rules/reddit-rules.ts' },
];

interface DiffResult {
  name: string;
  status: 'identical' | 'different' | 'missing';
  details?: string;
}

function checkPair(pair: { name: string; server: string; extension: string }): DiffResult {
  const serverPath = path.join(VOCAL_SAGA, pair.server);
  const extPath = path.join(FANYI_EXTENSION, pair.extension);

  if (!fs.existsSync(serverPath)) {
    return { name: pair.name, status: 'missing', details: `server 文件不存在: ${pair.server}` };
  }
  if (!fs.existsSync(extPath)) {
    return { name: pair.name, status: 'missing', details: `extension 文件不存在: ${pair.extension}` };
  }

  const serverContent = fs.readFileSync(serverPath, 'utf-8');
  const extContent = fs.readFileSync(extPath, 'utf-8');

  // 标准化:去除 import 路径差异(./xxx vs ../xxx)和空白
  const normalize = (s: string) =>
    s.replace(/from\s+['"]\.\.?\//g, 'from \'./')
     .replace(/\r\n/g, '\n')
     .trim();

  if (normalize(serverContent) === normalize(extContent)) {
    return { name: pair.name, status: 'identical' };
  }

  // 生成简要 diff
  const serverLines = normalize(serverContent).split('\n');
  const extLines = normalize(extContent).split('\n');
  const maxLines = Math.max(serverLines.length, extLines.length);
  const diffs: string[] = [];
  for (let i = 0; i < maxLines; i++) {
    if (serverLines[i] !== extLines[i]) {
      diffs.push(`  L${i + 1}:\n    server:     ${serverLines[i] ?? '(无)'}\n    extension:  ${extLines[i] ?? '(无)'}`);
      if (diffs.length >= 5) break; // 只显示前 5 处差异
    }
  }

  return { name: pair.name, status: 'different', details: diffs.join('\n') };
}

// 主逻辑
console.log('═══════════════════════════════════════════════');
console.log('  跨项目同步校验');
console.log('═══════════════════════════════════════════════\n');

const results = SYNC_PAIRS.map(checkPair);

const identical = results.filter(r => r.status === 'identical');
const different = results.filter(r => r.status === 'different');
const missing = results.filter(r => r.status === 'missing');

console.log(`✓ 完全一致: ${identical.length}/${results.length}`);
for (const r of identical) {
  console.log(`  ✓ ${r.name}`);
}

if (different.length > 0) {
  console.log(`\n✗ 有差异: ${different.length}`);
  for (const r of different) {
    console.log(`  ✗ ${r.name}`);
    if (r.details) console.log(r.details);
  }
}

if (missing.length > 0) {
  console.log(`\n⚠ 文件缺失: ${missing.length}`);
  for (const r of missing) {
    console.log(`  ⚠ ${r.name}: ${r.details}`);
  }
}

console.log('');
if (different.length > 0 || missing.length > 0) {
  console.log('结果: FAIL — 存在差异,请检查并同步');
  process.exit(1);
} else {
  console.log('结果: PASS — 所有"完全一致"模块均一致');
  process.exit(0);
}
