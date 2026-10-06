/**
 * Mutation map — 测试套件裁剪的安全网。
 *
 * 每条 entry 回答一个问题：**「如果把这个具体 bug 重新引入，哪个测试文件会变红？」**
 * 它的作用不是「跑一遍证明测试有用」，而是给「删测试」这件事一个可度量的边界：
 *
 *   - 出现在某个 entry 里的测试文件 = 有守卫，删它是在赌，必须靠 harness 裁决。
 *   - 任何 entry 在裁剪后不再变红 = 抓到一个错误删除，把测试恢复回去。
 *
 * 用法：
 *   node tests/mutation-map.mjs            # 跑全部 entry
 *   node tests/mutation-map.mjs gemini     # 只跑名字含 gemini 的 entry
 *
 * 注意：restore 从内存恢复，不走 git —— 工作区里本来就有大量未提交改动，
 * `git checkout` 会把它们一起冲掉。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const VITEST = 'node_modules/.bin/vitest';

/**
 * @type {{name: string, file: string, from: string, to: string, test: string}[]}
 */
export const MUTATIONS = [
  // ── 路由 → provider / model 接线（每个 provider 路由必须把正确的常量传下去）──
  {
    name: 'gemini-provider',
    file: 'lib/app.ts',
    from: `/* provider */ 'gemini', 'gemini-3.1-flash-lite'`,
    to: `/* provider */ 'deepseek', 'gemini-3.1-flash-lite'`,
    test: 'tests/gemRoute.test.ts',
  },
  {
    name: 'nvd-deepseek-model',
    file: 'lib/app.ts',
    from: `model = 'deepseek-ai/deepseek-v4-flash';`,
    to: `model = 'deepseek-ai/WRONG-MODEL';`,
    test: 'tests/nvdRoute.test.ts',
  },
  {
    name: 'openrt-provider',
    file: 'lib/app.ts',
    from: `/* provider */ 'openrouter'`,
    to: `/* provider */ 'deepseek'`,
    test: 'tests/openrtRoute.test.ts',
  },
  {
    name: 'oc-provider',
    file: 'lib/app.ts',
    from: `/* provider */ 'opencode'`,
    to: `/* provider */ 'deepseek'`,
    test: 'tests/ocRoute.test.ts',
  },
  {
    name: 'force-rate-limit',
    file: 'lib/app.ts',
    from: `const FORCE_RATE_LIMIT_MS = 30_000;`,
    to: `const FORCE_RATE_LIMIT_MS = 0;`,
    test: 'tests/forceTranslateRoute.test.ts',
  },
  {
    name: 's-shorthand-expansion',
    file: 'lib/app.ts',
    from: 'const host = firstSeg.includes(\'.\') ? firstSeg : `www.${firstSeg}.com`;',
    to: "const host = firstSeg;",
    test: 'tests/shortcutRoute.test.ts',
  },

  // ── SSRF / URL 规范化 ──
  {
    name: 'ssrf-private-ipv4-10-8',
    file: 'lib/urlUtils.ts',
    from: 'if (a === 10) return true;',
    to: 'if (a === 10) return false;',
    test: 'tests/urlUtils.test.ts',
  },
  {
    name: 'normalize-url-com-suffix',
    file: 'lib/urlUtils.ts',
    from: "normalized = hostPart + '.com' + pathPart;",
    to: 'normalized = hostPart + pathPart;',
    test: 'tests/urlUtils.test.ts',
  },

  // ── 站点规则（displayRules）──
  {
    name: 'awsblogs-host-pattern',
    file: 'lib/translate/rules/awsblogs-rules.ts',
    from: "hostPattern: 'aws.amazon.com',",
    to: "hostPattern: 'not-aws.example.com',",
    test: 'tests/displayRules.test.ts',
  },

  // ── 缓存健康检查（translationValidator）──
  {
    name: 'translation-marker-check',
    file: 'lib/translate/translationValidator.ts',
    from: "    'fanyi-translation',\n    'data-fanyi-translated',",
    to: "    'fanyi-NOPE',\n    'data-fanyi-translated',",
    test: 'tests/translationValidator.test.ts',
  },
];

function runTest(testFile) {
  const res = spawnSync(VITEST, ['run', testFile, '--project', 'node', '--reporter=dot'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

function applyMutation(m) {
  const p = ROOT + '/' + m.file;
  const src = readFileSync(p, 'utf8');
  const hits = src.split(m.from).length - 1;
  if (hits !== 1) {
    throw new Error(`anchor 命中 ${hits} 次（应为 1）: ${m.file} :: ${m.from.slice(0, 60)}`);
  }
  writeFileSync(p, src.replace(m.from, m.to));
}

function restore(m, original) {
  writeFileSync(ROOT + '/' + m.file, original);
}

const filter = process.argv[2];
const list = filter ? MUTATIONS.filter((m) => m.name.includes(filter)) : MUTATIONS;
if (!list.length) {
  console.error('no mutation matched filter: ' + filter);
  process.exit(2);
}

// ── preflight：先确认所有被引用的测试文件在「未变异」状态下是绿的 ──
// 若这里就红了，说明工作区里有残留的变异（上次被 kill 没走到 finally），
// 或者测试本来就坏 —— 先 git diff 看，不要继续。
console.log('preflight: baseline must be green');
const baseline = new Map();
for (const m of list) {
  if (baseline.has(m.test)) continue;
  const r = runTest(m.test);
  baseline.set(m.test, r.code);
  const ok = r.code === 0;
  console.log(`  ${ok ? 'OK ' : 'RED'} ${m.test}`);
  if (!ok) {
    console.error(`\nbaseline is RED for ${m.test} — 先修工作区（git diff），再裁剪。`);
    console.error(r.out.slice(-1500));
    process.exit(1);
  }
}

console.log('\nrunning mutations (each must turn its test file RED)');
let caught = 0;
const misses = [];
for (const m of list) {
  const p = ROOT + '/' + m.file;
  const original = readFileSync(p, 'utf8');
  let verdict;
  try {
    applyMutation(m);
    const r = runTest(m.test);
    verdict = r.code !== 0;
  } catch (e) {
    verdict = 'ERROR';
    console.error(`  ERROR ${m.name}: ${e.message}`);
  } finally {
    restore(m, original);
  }
  if (verdict === true) {
    caught++;
    console.log(`  caught   ${m.name}  (${m.test})`);
  } else if (verdict !== 'ERROR') {
    misses.push(m);
    console.log(`  MISSED   ${m.name}  (${m.test}) — 变异没打上或测试没有区分度`);
  }
}

console.log(`\n${caught}/${list.length} mutations caught`);
if (misses.length) {
  console.log('missed: ' + misses.map((m) => m.name).join(', '));
  process.exit(1);
}
