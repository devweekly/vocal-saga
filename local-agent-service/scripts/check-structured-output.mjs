#!/usr/bin/env node
/**
 * 验证某个 workbuddy 模型对 `--json-schema` 结构化输出的支持。
 *
 * 为什么需要这个脚本：文档翻译、文学分析、审校都依赖严格 schema 解码
 * （`response_format: {type:'json_schema'}` → CLI `--json-schema`）。
 * 模型不支持时不会报错，而是回退成「自由文本里塞一段 JSON」，
 * 下游 `resolveWorkbuddyStructured` 拿到形状不对的对象，症状是内容缺字段或整段失败。
 * 换模型前跑一次，比在生产里试便宜得多。
 *
 * 前提：本机服务已经在跑（`npm start`），因为它负责拼 CLI 参数、管池化会话。
 *
 * 用法：
 *   node scripts/check-structured-output.mjs                      # 测 DEFAULT_WORKBUDDY_MODEL
 *   node scripts/check-structured-output.mjs hy3                  # 测指定模型
 *   node scripts/check-structured-output.mjs hy3 --base=http://127.0.0.1:8789
 *   node scripts/check-structured-output.mjs hy3 --skip-pool      # 跳过池化会话两轮
 *
 * 退出码：0 全部通过；1 有场景失败（或服务没起）。
 */
const args = process.argv.slice(2);
const baseArg = args.find((item) => item.startsWith('--base='));
const BASE = (baseArg ? baseArg.slice('--base='.length) : 'http://127.0.0.1:8789').replace(/\/+$/, '');
const skipPool = args.includes('--skip-pool');
const modelArg = args.find((item) => !item.startsWith('--')) || '';
// 不带模型名时用 workbuddy:<空>，服务侧会落到 DEFAULT_WORKBUDDY_MODEL（自动挑的那个）。
const model = modelArg ? (modelArg.includes(':') ? modelArg : 'workbuddy:' + modelArg) : 'workbuddy';

const FLAT_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'confidence', 'tags'],
  additionalProperties: false,
};

// 嵌套 + 数组，贴近真实的翻译 schema（translations / segments）。
const NESTED_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          translation: { type: 'string' },
          terms: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'translation', 'terms'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'segments'],
  additionalProperties: false,
};

const FLAT_PROMPT =
  '用一句话说明「光合作用」的作用，给 0-1 之间的置信度，并给出 3 个英文标签。'
  + '必须返回 answer / confidence / tags 三个字段。';
const NESTED_PROMPT =
  '把这两句翻译成英文并给出术语表：\n1) 光合作用把光能转成化学能。\n2) 叶绿体是反应场所。\n'
  + '返回 summary 和 segments（每段含 id、translation、terms）。';

function validFlat(value) {
  return typeof value?.answer === 'string'
    && typeof value?.confidence === 'number'
    && Array.isArray(value?.tags);
}

function validNested(value) {
  return typeof value?.summary === 'string'
    && Array.isArray(value?.segments)
    && value.segments.length > 0
    && value.segments.every((segment) =>
      typeof segment?.id === 'string'
      && typeof segment?.translation === 'string'
      && Array.isArray(segment?.terms));
}

async function callOnce({ schema, prompt, label, sessionId }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: '你是结构化输出测试助手，只按给定 schema 作答。' },
      { role: 'user', content: prompt },
    ],
    // 注意：本服务把 json_schema 直接当 CLI 的 --json-schema 用，是**裸 schema**，
    // 不是 OpenAI 的 {name, schema, strict} 信封。套信封会让 CLI 拿到一份无约束 schema。
    response_format: { type: 'json_schema', json_schema: schema },
    ...(sessionId ? { metadata: { documentSessionId: sessionId } } : {}),
    stream: false,
  };
  const started = Date.now();
  let response;
  try {
    response = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    return { ok: false, label, reason: '请求失败：' + (error?.message || error), seconds: 0 };
  }
  const text = await response.text();
  const seconds = (Date.now() - started) / 1000;
  if (!response.ok) {
    let message = text.slice(0, 200);
    try { message = JSON.parse(text)?.error?.message || message; } catch { /* 非 JSON */ }
    return { ok: false, label, reason: 'HTTP ' + response.status + '：' + message, seconds };
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, label, reason: '响应不是 JSON', seconds };
  }
  const content = payload.choices?.[0]?.message?.content;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, label, reason: 'content 不是 JSON：' + String(content).slice(0, 120), seconds };
  }
  const validator = schema === NESTED_SCHEMA ? validNested : validFlat;
  if (!validator(parsed)) {
    return {
      ok: false,
      label,
      reason: 'schema 不合规，实际字段 ' + Object.keys(parsed || {}).join(',')
        + '（出现了 data 包裹说明 --json-schema 没生效）',
      seconds,
    };
  }
  return { ok: true, label, reason: JSON.stringify(parsed).slice(0, 110), seconds };
}

async function main() {
  try {
    const ping = await fetch(BASE + '/health', { signal: AbortSignal.timeout(3000) });
    if (!ping.ok) throw new Error('health ' + ping.status);
  } catch (error) {
    console.error('无法连接本机服务 ' + BASE + '（' + (error?.message || error) + '）');
    console.error('请先在 local-agent-service 目录执行 npm start，再重跑本脚本。');
    process.exit(1);
  }

  console.log('服务   : ' + BASE);
  console.log('模型   : ' + model);
  console.log('');

  const cases = [
    { label: '扁平 schema', schema: FLAT_SCHEMA, prompt: FLAT_PROMPT },
    { label: '嵌套 schema', schema: NESTED_SCHEMA, prompt: NESTED_PROMPT },
  ];
  if (!skipPool) {
    // 池化会话是文档任务的真实路径：首轮新建、次轮复用，两轮都必须仍然合规。
    const sessionId = 'check-structured-' + Date.now();
    cases.push({ label: '池化会话 · 首轮', schema: NESTED_SCHEMA, prompt: NESTED_PROMPT, sessionId });
    cases.push({ label: '池化会话 · 复用轮', schema: NESTED_SCHEMA, prompt: NESTED_PROMPT, sessionId });
  }

  let failed = 0;
  for (const item of cases) {
    const result = await callOnce(item);
    if (result.ok) {
      console.log('  PASS  ' + item.label.padEnd(16) + result.seconds.toFixed(1) + 's  ' + result.reason);
    } else {
      failed += 1;
      console.log('  FAIL  ' + item.label.padEnd(16) + result.seconds.toFixed(1) + 's  ' + result.reason);
    }
  }

  console.log('');
  if (failed) {
    console.log(failed + ' 个场景失败：该模型不适合做需要严格 schema 的翻译/审校。');
    process.exit(1);
  }
  console.log('全部通过：' + model + ' 支持 --json-schema 结构化输出。');
  process.exit(0);
}

main();
