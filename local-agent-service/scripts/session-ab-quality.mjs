#!/usr/bin/env node
/**
 * 只读 A/B：验证「共享会话串行」vs「独立会话并行」是否影响翻译质量。
 *
 * 背景
 * ----
 * 服务端 translationAgent.executeRun 现在逐批串行，且所有批共享同一个 workbuddy
 * 会话 scope（translationAgent.ts:143），会话历史跨批累积。
 * 计划中的提速是把批改成并行；一旦并行，每批必须用独立 scope，历史不再共享。
 * 本脚本只改变「会话 scope / 并发」这一个变量，其余输入（原文、prompt、schema）完全一致，
 * 用来回答：去掉隐式会话历史会不会掉质量？
 *
 * 只读承诺
 * --------
 * - 只用 node:sqlite 以 readOnly 打开项目库读取原文，从不写入；
 * - 只调用运行中的本机服务 HTTP 端点（/v1/chat/completions，可选 /literary/review），
 *   不触碰 document_projects、translation_runs、候选译文等生产数据；
 * - 输出只写到 --out 指定的 JSON 文件（默认 /tmp 下）。
 *
 * 用法
 * ----
 *   node scripts/session-ab-quality.mjs                       # 默认取 Shogun 最新完成的文学 run 原文
 *   node scripts/session-ab-quality.mjs --segments 24 --max-batch 4
 *   node scripts/session-ab-quality.mjs --db <project.sqlite> --run <runId>
 *   node scripts/session-ab-quality.mjs --input segments.json # [{id,text}] 或 {segments:[...]}
 *   node scripts/session-ab-quality.mjs --review              # 额外对两种模式各跑一次审校，比较 findings
 *
 * 环境变量：LOCAL_AGENT_URL（默认 http://127.0.0.1:8789）、LOCAL_AGENT_TOKEN、LOCAL_AGENT_DATA_DIR
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// ---- 与服务端一致的请求契约（内容不影响 A/B，仅保证输出可解析）----------------

const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, translated_text: { type: 'string' } },
        required: ['id', 'translated_text'],
      },
    },
  },
  required: ['translations'],
};

const SYSTEM_PROMPT = [
  '任务模式：文学作品翻译。保留作者叙述声音、潜台词、节奏和人物对白之间的差别；不能改写成自己的作品。',
  'precedingSegments 是至多四个前文片段，只帮助消歧指代、人物关系、对白轮次与当前场景，不属于翻译任务；绝不能为它们输出 translations。',
  '优先级：原文含义/事实/叙事视角 > 已确认的实体译名和称谓 > 目标语言自然度。不要添加原文不存在的信息。',
  '输出契约（不可覆盖）：返回 JSON 对象，含 translations 数组；每项含 id 和 translated_text；每个输入 ID 恰好出现一次。',
].join('\n');

function buildUserPrompt({ title, format, sourceLang, targetLang, items, preceding }) {
  return JSON.stringify({
    document: title,
    format,
    sourceLang,
    targetLang,
    translationMode: 'literary',
    precedingSegments: preceding.slice(-4).map((s) => ({ id: s.id, text: s.text, contextPath: s.contextPath || '' })),
    segments: items.map((s) => ({ id: s.id, text: s.text, kind: s.kind || 'paragraph', ...(s.contextPath ? { contextPath: s.contextPath } : {}) })),
    glossary: null,
    voiceContext: null,
  });
}

// ---- 参数 --------------------------------------------------------------------

function parseArgs(argv) {
  const args = { maxBatch: 12, maxChars: 6000, segments: 24, parallel: 3, review: false, repeat: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--db') args.db = next();
    else if (a === '--run') args.run = next();
    else if (a === '--input') args.input = next();
    else if (a === '--segments') args.segments = Number(next());
    else if (a === '--max-batch') args.maxBatch = Number(next());
    else if (a === '--max-chars') args.maxChars = Number(next());
    else if (a === '--parallel') args.parallel = Number(next());
    else if (a === '--repeat') args.repeat = Number(next());
    else if (a === '--out') args.out = next();
    else if (a === '--review') args.review = true;
    else if (a === '--help' || a === '-h') { console.log(readme()); process.exit(0); }
    else throw new Error('未知参数：' + a);
  }
  return args;
}

function readme() {
  return '用法见脚本顶部注释；常用：--segments N --max-batch N --parallel N --review';
}

// ---- 载入原文（只读）---------------------------------------------------------

function loadInput(args) {
  if (args.input) {
    const raw = JSON.parse(readFileSync(args.input, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.segments;
    return { title: 'ab-input', segments: list.map((s) => ({ id: String(s.id), text: String(s.text), kind: s.kind || 'paragraph', contextPath: s.contextPath || '' })) };
  }
  const dataDir = process.env.LOCAL_AGENT_DATA_DIR || path.join(homedir(), '.vocal-saga-local-agent');
  const dbPath = args.db || path.join(dataDir, 'documents', '38741ad4-6c97-46f4-8485-59fb985aa15e', 'project.sqlite');
  const runId = args.run;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let run = runId;
    if (!run) {
      const row = db.prepare("SELECT run_id FROM translation_runs WHERE status = 'completed' AND translation_mode = 'literary' ORDER BY finished_at DESC LIMIT 1").get();
      if (!row) throw new Error('库里找不到已完成的文学 run');
      run = row.run_id;
    }
    const runRow = db.prepare('SELECT source_revision_id, target_lang FROM translation_runs WHERE run_id = ?').get(run);
    const rows = db.prepare(
      'SELECT s.segment_id AS id, s.text, s.kind, s.context_path AS contextPath, s.ordinal ' +
      'FROM run_segments r JOIN source_segments s ' +
      'ON s.segment_id = r.segment_id AND s.source_revision_id = ? ' +
      'WHERE r.run_id = ? ORDER BY s.ordinal LIMIT ?',
    ).all(runRow?.source_revision_id, run, args.segments);
    const title = rows[0]?.contextPath || 'ab-from-db';
    return {
      title: String(title).split('/')[0] || 'ab-from-db',
      targetLang: runRow?.target_lang || 'zh',
      runId: run,
      segments: rows.map((r) => ({ id: r.id, text: String(r.text), kind: r.kind || 'paragraph', contextPath: r.contextPath || '' })),
    };
  } finally {
    db.close();
  }
}

// ---- 分批（对齐 buildBatches：按段数与字符数双上限，并按 contextPath 切章）--------

function buildBatches(segments, maxBatch, maxChars) {
  const batches = [];
  let cur = [];
  let chars = 0;
  let group = '';
  for (const seg of segments) {
    const size = seg.text.length + (seg.contextPath?.length || 0);
    const contextChanged = seg.contextPath && group && seg.contextPath !== group;
    if (cur.length && (cur.length >= maxBatch || chars + size > maxChars || contextChanged)) {
      batches.push(cur); cur = []; chars = 0;
    }
    if (!cur.length) group = seg.contextPath || group;
    cur.push(seg);
    chars += size;
    if (size > maxChars) { batches.push(cur); cur = []; chars = 0; }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ---- 调用服务 -----------------------------------------------------------------

function endpoint(base, pathname) {
  return base.replace(/\/$/, '') + pathname;
}

async function callChat({ base, token, model, scopeId, lane, sourceLang, targetLang, title, items, preceding }) {
  const user = buildUserPrompt({ title, format: 'epub', sourceLang, targetLang, items, preceding });
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_schema', json_schema: TRANSLATION_SCHEMA },
    metadata: {
      documentSessionId: scopeId,
      sessionLane: lane,
      sourceLang, targetLang,
      translationMode: 'literary',
      systemPromptOverride: SYSTEM_PROMPT,
      userPromptTemplate: '',
    },
  };
  const started = Date.now();
  const res = await fetch(endpoint(base, '/v1/chat/completions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('chat HTTP ' + res.status + ': ' + text.slice(0, 300));
  const payload = JSON.parse(text);
  const content = payload.choices?.[0]?.message?.content ?? '';
  const parsed = JSON.parse(content);
  const rows = Array.isArray(parsed) ? parsed : (parsed.translations || []);
  const out = new Map();
  for (const row of rows) {
    if (row && typeof row.id === 'string' && typeof row.translated_text === 'string' && row.translated_text.trim()) {
      out.set(row.id, row.translated_text);
    }
  }
  return { out, ms: Date.now() - started };
}

async function callReview({ base, token, model, scopeId, lane, targetLang, title, segments, drafts }) {
  const items = segments.filter((s) => drafts.has(s.id));
  const body = {
    model,
    target: targetLang,
    chapterTitle: title,
    memory: {},
    segments: items.map((s) => ({ id: s.id, source: s.text, draft: drafts.get(s.id), kind: s.kind, contextPath: s.contextPath })),
    metadata: { documentSessionId: scopeId, sessionLane: lane, sourceLang: 'en', targetLang, translationMode: 'literary' },
  };
  const res = await fetch(endpoint(base, '/api/translate/document/literary/review'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('review HTTP ' + res.status + ': ' + text.slice(0, 300));
  return JSON.parse(text);
}

// ---- 两种模式 -----------------------------------------------------------------

async function runMode({ label, parallel, base, token, model, scopeId, sourceLang, targetLang, title, batches }) {
  const all = new Map();
  const started = Date.now();
  const pending = batches.map((batch, index) => ({ batch, index }));
  let cursor = 0;
  const laneFor = parallel > 1 ? (index) => label + '-b' + index : () => label + '-shared';
  const lane = parallel > 1 ? 'per-batch' : 'shared';
  const worker = async () => {
    while (cursor < pending.length) {
      const { batch, index } = pending[cursor++];
      const preceding = batches[index - 1] ? batches[index - 1].slice(-4) : [];
      const { out } = await callChat({ base, token, model, scopeId, lane: laneFor(index), sourceLang, targetLang, title, items: batch, preceding });
      for (const [id, text] of out) all.set(id, text);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, pending.length) }, () => worker()));
  return { label, lane, parallel, wallMs: Date.now() - started, translations: all };
}

// ---- 指标 ---------------------------------------------------------------------

function bigrams(s) {
  const set = new Set();
  const t = s.replace(/\s+/g, '');
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size || 1);
}
function stats(nums) {
  if (!nums.length) return { n: 0, mean: 0, std: 0 };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const std = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length);
  return { n: nums.length, mean, std };
}

/** 名称一致性启发式：英文专名 -> 目标 CJK 译名的主导度。仅作信号，非真值。 */
function nameConsistency(segments, translations) {
  const boundary = (ch) => !ch || '.!?…"\u201c\u201d\u2018\u2019'.includes(ch);
  const total = new Map();
  const midSentence = new Map();
  for (const s of segments) {
    for (const m of s.text.matchAll(/\b[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+)*\b/g)) {
      const name = m[0];
      total.set(name, (total.get(name) || 0) + 1);
      let i = m.index - 1;
      while (i >= 0 && /\s/.test(s.text[i])) i--;
      // 句中出现的首字母大写词（或含空格的复合名）才可能是专名；句首大写多为普通词。
      if (name.includes(' ') || (i >= 0 && !boundary(s.text[i]))) {
        midSentence.set(name, (midSentence.get(name) || 0) + 1);
      }
    }
  }
  const names = [...total.entries()]
    .filter(([name, count]) => count >= 2 && (midSentence.get(name) || 0) >= 1 && name.length >= 4)
    .map(([name]) => name);
  const perName = [];
  for (const name of names) {
    const bearing = segments.filter((s) => s.text.includes(name) && translations.has(s.id));
    if (bearing.length < 2) continue;
    const tokenCount = new Map();
    for (const s of bearing) {
      const target = translations.get(s.id);
      for (const tok of new Set(target.match(/[\u4e00-\u9fff]{2,4}/g) || [])) {
        if (/[的了是在和与不都有也就很而且还只把被给对从向为以]/.test(tok)) continue;
        tokenCount.set(tok, (tokenCount.get(tok) || 0) + 1);
      }
    }
    if (!tokenCount.size) continue;
    const [domToken, domCount] = [...tokenCount.entries()].sort((a, b) => b[1] - a[1])[0];
    if (domCount < Math.ceil(bearing.length * 0.5)) continue; // 未形成主导译名，跳过
    const consistent = bearing.filter((s) => translations.get(s.id).includes(domToken)).length;
    perName.push({ name, rendering: domToken, segments: bearing.length, consistent, rate: consistent / bearing.length });
  }
  const rates = perName.map((p) => p.rate);
  return { names: perName, overall: stats(rates) };
}

// ---- 主流程 -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = process.env.LOCAL_AGENT_URL || 'http://127.0.0.1:8789';
  const token = process.env.LOCAL_AGENT_TOKEN || '';
  const model = 'workbuddy';
  const sourceLang = 'en';

  const input = loadInput(args);
  const segments = input.segments;
  const targetLang = input.targetLang || 'zh';
  const batches = buildBatches(segments, args.maxBatch, args.maxChars);
  const scopeBase = 'ab-' + Date.now();

  console.log('== 只读 A/B：共享会话串行 vs 独立会话并行 ==');
  console.log('服务:', base, '| provider:', model, '| 输入:', segments.length, '段 →', batches.length, '批',
    '| 批上限:', args.maxBatch, '段 /', args.maxChars, '字');
  if (input.runId) console.log('来源 run:', input.runId);

  const repeats = Math.max(1, args.repeat || 1);
  const runsA = [];
  const runsB = [];
  for (let r = 0; r < repeats; r++) {
    console.log('\n[serial 共享会话] 第 ' + (r + 1) + '/' + repeats + ' 次…');
    runsA.push(await runMode({ label: 'serial-' + r, parallel: 1, base, token, model, scopeId: scopeBase + '-A' + r, sourceLang, targetLang, title: input.title, batches }));
  }
  for (let r = 0; r < repeats; r++) {
    console.log('\n[parallel 独立会话] 第 ' + (r + 1) + '/' + repeats + ' 次…');
    runsB.push(await runMode({ label: 'parallel-' + r, parallel: args.parallel, base, token, model, scopeId: scopeBase + '-B' + r, sourceLang, targetLang, title: input.title, batches }));
  }
  const modeA = runsA[0];
  const modeB = runsB[0];

  // 指标 1：相似度。关键是给"跨模式差异"找噪声底：
  // intra(同模式重复) = 纯采样噪声；inter(跨模式) 若 ≈ intra，则串行/并行的差异不超出重跑噪声。
  const pairSim = (runX, runY) => {
    const ids = segments.map((s) => s.id).filter((id) => runX.translations.has(id) && runY.translations.has(id));
    if (!ids.length) return { n: 0, mean: NaN, std: NaN, exact: 0 };
    const sims = ids.map((id) => dice(runX.translations.get(id), runY.translations.get(id)));
    const st = stats(sims);
    const exact = ids.filter((id) => runX.translations.get(id) === runY.translations.get(id)).length;
    return { n: ids.length, mean: st.mean, std: st.std, exact };
  };
  const meanPair = (runsX, runsY, sameSet) => {
    const values = [];
    let exact = 0, n = 0;
    for (let i = 0; i < runsX.length; i++) {
      for (let j = 0; j < runsY.length; j++) {
        if (sameSet && j <= i) continue;
        const p = pairSim(runsX[i], runsY[j]);
        if (!Number.isNaN(p.mean)) { values.push(p.mean); exact += p.exact; n += p.n; }
      }
    }
    return { pairs: values.length, mean: stats(values).mean, std: stats(values).std, exactRate: n ? exact / n : NaN };
  };
  const intraSerial = repeats > 1 ? meanPair(runsA, runsA, true) : null;
  const intraParallel = repeats > 1 ? meanPair(runsB, runsB, true) : null;
  const inter = meanPair(runsA, runsB, false);

  // 指标 2：长度比（是否出现膨胀/漂移）
  const ratio = (mode) => stats(segments.filter((s) => mode.translations.has(s.id)).map((s) => mode.translations.get(s.id).length / Math.max(1, s.text.length)));

  // 指标 3：名称一致性
  const nameA = nameConsistency(segments, modeA.translations);
  const nameB = nameConsistency(segments, modeB.translations);

  let review = null;
  if (args.review) {
    console.log('\n运行审校对比（两模式各一次）…');
    const [revA, revB] = await Promise.all([
      callReview({ base, token, model, scopeId: scopeBase + '-revA', lane: 'review-shared', targetLang, title: input.title, segments, drafts: modeA.translations }),
      callReview({ base, token, model, scopeId: scopeBase + '-revB', lane: 'review-shared', targetLang, title: input.title, segments, drafts: modeB.translations }),
    ]);
    const tally = (findings) => {
      const t = { accuracy: 0, terminology: 0, style: 0, total: findings.length };
      for (const f of findings) if (t[f.category] != null) t[f.category]++;
      return t;
    };
    review = { serial: tally(revA.findings || []), parallel: tally(revB.findings || []) };
  }

  // ---- 报告 ----
  const fmtSim = (m) => m ? ('mean=' + m.mean.toFixed(3) + ' std=' + m.std.toFixed(3) + ' 完全相同=' + (100 * m.exactRate).toFixed(1) + '% (' + m.pairs + ' 对)') : '未测（需 --repeat>1）';
  const avgWall = (runs) => Math.round(stats(runs.map((run) => run.wallMs)).mean);
  console.log('\n--- 用时（均值）---');
  console.log('串行(共享会话):', avgWall(runsA) + 'ms', '| 并行(独立会话):', avgWall(runsB) + 'ms',
    '| 加速', (avgWall(runsA) / Math.max(1, avgWall(runsB))).toFixed(2) + 'x');

  console.log('\n--- 相似度（Dice，越高＝越一致）---');
  console.log('噪声底 intra-serial  :', fmtSim(intraSerial));
  console.log('噪声底 intra-parallel:', fmtSim(intraParallel));
  console.log('跨模式   inter       :', fmtSim(inter));
  const floors = [intraSerial?.mean, intraParallel?.mean].filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (floors.length) {
    const floor = Math.min(...floors);
    console.log(inter.mean >= floor - 0.05
      ? '判定: 跨模式差异 ≤ 重跑噪声 → 会话历史对质量无可测影响'
      : '判定: 跨模式差异 > 重跑噪声（' + (floor - inter.mean).toFixed(3) + '）→ 需人工抽检确认');
  }

  console.log('\n--- 长度比（译文/原文）---');
  console.log('串行: mean=' + ratio(modeA).mean.toFixed(2), 'std=' + ratio(modeA).std.toFixed(2));
  console.log('并行: mean=' + ratio(modeB).mean.toFixed(2), 'std=' + ratio(modeB).std.toFixed(2));

  console.log('\n--- 名称一致性（启发式，非真值）---');
  console.log('串行: 主导率 mean=' + nameA.overall.mean.toFixed(2), '(' + nameA.names.length + ' 个专名)');
  console.log('并行: 主导率 mean=' + nameB.overall.mean.toFixed(2), '(' + nameB.names.length + ' 个专名)');
  const worst = [...nameA.names, ...nameB.names].filter((n) => n.rate < 0.8);
  if (worst.length) console.log('低一致专名样例:', worst.slice(0, 8).map((n) => n.name + '→' + n.rendering + '(' + n.consistent + '/' + n.segments + ')').join(', '));

  if (review) {
    console.log('\n--- 审校 findings ---');
    console.log('串行:', JSON.stringify(review.serial));
    console.log('并行:', JSON.stringify(review.parallel));
  }

  const out = args.out || path.join('/tmp', 'session-ab-' + scopeBase + '.json');
  writeFileSync(out, JSON.stringify({
    meta: { at: new Date().toISOString(), base, model, segments: segments.length, batches: batches.length, targetLang },
    modes: {
      serial: { lane: modeA.lane, parallel: modeA.parallel, wallMs: modeA.wallMs, translations: Object.fromEntries(modeA.translations) },
      parallel: { lane: modeB.lane, parallel: modeB.parallel, wallMs: modeB.wallMs, translations: Object.fromEntries(modeB.translations) },
    },
    metrics: {
      similarity: { intraSerial, intraParallel, inter },
      wallMs: { serial: avgWall(runsA), parallel: avgWall(runsB) },
      lengthRatio: { serial: ratio(modeA), parallel: ratio(modeB) },
      names: { serial: nameA, parallel: nameB },
      review,
    },
    source: segments.map((s) => ({ id: s.id, text: s.text, contextPath: s.contextPath })),
  }, null, 2));
  console.log('\n原始译文与逐段对比已写入:', out);
}

main().catch((error) => {
  console.error('A/B 失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
