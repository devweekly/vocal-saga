#!/usr/bin/env node
/**
 * CodeBuddy 执行链路自检。
 *
 * 服务本身只暴露 /api/translate，失败时往往只剩一句「返回了空内容」或一个超时，
 * 分不清是配置、CLI 进程、模型选择还是网络的问题。这个脚本按层拆开逐段验证：
 *
 *   1. 配置      .env 是否被读到、provider 与模型解析成什么
 *   2. 模型目录  CodeBuddy 目录里有没有目标模型、费率是否为 0
 *   3. CLI 定位  PATH 里能不能找到 codebuddy
 *   4. 一次性调用 sdk.query()，最小 prompt，量 TTFT 与总耗时
 *   5. 池化会话  unstable_v2_createSession()（服务实际走的路径），并核对 CLI 进程的 --model
 *   6. 真实请求  从 CLI 日志里读出「这一轮到底用了哪个模型」—— 这是唯一可信的证据
 *   7. HTTP 层   GET 探活 + POST /v1/chat/completions 端到端，验证运行中的进程用哪个模型
 *
 * 用法：
 *   node --import tsx scripts/check-codebuddy-connectivity.mjs
 *   node --import tsx scripts/check-codebuddy-connectivity.mjs --dry       # 只查配置，不调模型（不花钱）
 *   node --import tsx scripts/check-codebuddy-connectivity.mjs --timeout=90000
 *
 * 注意：被 IDE / Agent 托管时（环境里有 CODEBUDDY_SESSION_ID），本进程 fork 的 CLI 子进程
 * 起不来，第 4/5 步会自动降级为警告；要在普通终端里跑才能验证真实模型调用。
 *
 * 退出码：0 全部通过；1 有阶段失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.resolve(process.env.LOCAL_AGENT_ENV_FILE?.trim() || path.join(SERVICE_DIR, '.env'));

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const TIMEOUT_MS = Number(argv.find((item) => item.startsWith('--timeout='))?.split('=')[1]) || 90_000;

// .env 必须在 import config.ts 之前加载：config 在模块求值时读取 process.env。
try {
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
} catch (error) {
  console.warn('[warn] 读取 .env 失败：' + (error instanceof Error ? error.message : String(error)));
}

const { DEFAULT_PROVIDER, DEFAULT_WORKBUDDY_MODEL, HOST, PORT, WORK_DIR, LOCAL_TOKEN } = await import('../src/config.ts');
const { readModelCatalog, pickPreferredWorkbuddyModel } = await import('../src/agents/modelCatalog.ts');
const { buildTextSessionOptions } = await import('../src/agents/workbuddyPool.ts');

/**
 * 被 IDE / Agent 托管时（环境里有 CODEBUDDY_SESSION_ID），本进程 fork 出来的 CLI 子进程
 * 会在沙箱里静默退出：不写日志、不发请求、stream 立刻结束。这不是服务的问题，
 * 所以这种环境下把 SDK 阶段降级成警告，避免误报。
 */
const SANDBOXED = Boolean(process.env.CODEBUDDY_SESSION_ID || process.env.WORKBUDDY_CONFIG_DIR);

const failures = [];
const warnings = [];
let stepNo = 0;

function head(text) {
  stepNo += 1;
  console.log('\n' + String(stepNo) + '. ' + text);
}

function ok(text) {
  console.log('   ✓ ' + text);
}

function warn(text) {
  warnings.push(text);
  console.log('   ! ' + text);
}

function fail(text) {
  failures.push(text);
  console.log('   ✗ ' + text);
}

/**
 * SDK 阶段的失败。被 IDE/Agent 托管时（本进程 fork 的 CLI 子进程会在沙箱里静默退出），
 * 这类失败是执行环境导致的，不是服务问题 —— 降级成警告并提示换终端重跑。
 */
function sdkIssue(text) {
  if (SANDBOXED) {
    warnings.push(text);
    console.log('   ! ' + text + ' —— 当前进程被 IDE/Agent 托管，子进程无法正常启动，属预期；请在普通终端重跑');
  } else {
    fail(text);
  }
}

function info(label, value) {
  console.log('   · ' + label + '：' + value);
}

function elapsed(startedAt) {
  return ((Date.now() - startedAt) / 1000).toFixed(1) + 's';
}

/** 超时/失败时把已经收到的内容打出来：空响应和「流了 500KB 却不结束」是完全不同的故障。 */
function reportPartial(state) {
  if (!state.text) return;
  info('已收到部分文本', state.text.length + ' 字符 · ' + JSON.stringify(state.text.slice(0, 100)));
}

/**
 * 每个阶段都带超时，避免某一段把整个脚本挂死。
 * 超时必须主动 interrupt：只让 Promise.race 拒绝的话，CLI 子进程会继续跑，
 * 一个卡住的请求能在后台一直流式输出，白白烧额度。
 */
async function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* 中断失败也要抛超时 */ }
      reject(new Error(label + ' 超时（' + ms + 'ms）'));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 1. 配置

head('配置解析');
info('.env', ENV_FILE + (fs.existsSync(ENV_FILE) ? '' : '（不存在）'));
info('provider', DEFAULT_PROVIDER);
info('模型（显式配置或目录挑选）', DEFAULT_WORKBUDDY_MODEL || '(空 → 交给 CLI 运行时默认模型)');
info('监听', HOST + ':' + PORT);
info('token', LOCAL_TOKEN ? '已设置（' + LOCAL_TOKEN.length + ' 字符）' : '(空，仅 loopback 可用)');
if (SANDBOXED) {
  info('执行环境', 'IDE/Agent 托管（SDK 阶段会自动降级为警告，模型调用请用普通终端验证）');
}

if (DEFAULT_PROVIDER !== 'workbuddy') {
  fail('LOCAL_AGENT_PROVIDER=' + DEFAULT_PROVIDER + '，本次自检针对 workbuddy');
}
if (!DEFAULT_WORKBUDDY_MODEL) {
  warn('没有解析出模型：CLI 会用它自己的默认模型（通常是账号默认，可能收费）');
}

// ---------------------------------------------------------------- 2. 模型目录

head('CodeBuddy 模型目录');
let catalog = [];
try {
  catalog = readModelCatalog();
} catch (error) {
  fail('读取目录失败：' + (error instanceof Error ? error.message : String(error)));
}
info('模型数量', catalog.length);
if (catalog.length) {
  const target = catalog.find((item) => item.id === DEFAULT_WORKBUDDY_MODEL);
  if (!target) {
    fail('目录里没有 ' + (DEFAULT_WORKBUDDY_MODEL || '(空)'));
  } else {
    ok('目标模型存在：' + target.id + ' · credits=' + JSON.stringify(target.credits));
    if (target.credits !== 0) warn('该模型 credits=' + JSON.stringify(target.credits) + '，不是 0（会计费）');
  }
  const free = catalog.filter((item) => item.credits === 0).map((item) => item.id);
  info('免费模型（credits=0）', free.length ? free.join(', ') : '无');
  const repick = pickPreferredWorkbuddyModel(catalog);
  if (repick !== DEFAULT_WORKBUDDY_MODEL) {
    warn('目录重算结果 ' + JSON.stringify(repick) + ' 与当前配置不一致（可能被环境变量覆盖）');
  }
} else {
  warn('目录为空：无法确认模型可用性与费率');
}

if (DRY) {
  console.log('\n--dry：跳过模型调用。');
  process.exit(failures.length ? 1 : 0);
}

// ---------------------------------------------------------------- 3. CLI 定位

head('CLI 可执行文件');
const cliCandidate = process.env.CODEBUDDY_CLI_PATH || process.env.WORKBUDDY_CLI_PATH || '';
let cliPath = cliCandidate;
if (!cliPath) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, 'codebuddy');
    if (fs.existsSync(candidate)) { cliPath = candidate; break; }
  }
}
if (cliPath && fs.existsSync(cliPath)) ok(cliPath);
else warn('PATH 里没有 codebuddy（SDK 可能自带 CLI，可忽略）');

// ---------------------------------------------------------------- 4. 一次性调用

const PROMPT = '只回复两个字：连通。不要解释。';

function collectText(message, state) {
  const raw = message && typeof message === 'object' ? message : {};
  if (raw.type === 'assistant' && raw.message && Array.isArray(raw.message.content)) {
    for (const part of raw.message.content) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        if (!state.firstTextAt) state.firstTextAt = Date.now();
        state.text += (state.text ? '\n' : '') + part.text;
      }
    }
  }
  if (raw.type === 'result') {
    if (raw.subtype) state.subtype = raw.subtype;
    if (raw.structured_output !== undefined) state.structuredOutput = raw.structured_output;
    if (raw.is_error) state.isError = true;
  }
  return raw;
}

const logCursor = markWorkspaceLog();

head('一次性调用（sdk.query）');
if (!DEFAULT_WORKBUDDY_MODEL) {
  warn('没有模型可传，本次只能验证「能不能连上」');
}
{
  const startedAt = Date.now();
  const state = { text: '', firstTextAt: 0, subtype: undefined, structuredOutput: undefined, isError: false };
  try {
    const sdk = await import('@tencent-ai/agent-sdk');
    const query = sdk.query({
      prompt: PROMPT,
      options: {
        ...(DEFAULT_WORKBUDDY_MODEL ? { model: DEFAULT_WORKBUDDY_MODEL } : {}),
        cwd: WORK_DIR,
        permissionMode: 'default',
        settingSources: [],
        persistSession: false,
        thinking: { type: 'disabled' },
        extraArgs: { effort: 'minimal' },
        tools: [],
        allowedTools: [],
        maxTurns: 1,
        canUseTool: async (toolName) => ({ behavior: 'deny', message: '自检不允许执行工具：' + toolName }),
      },
    });
    await withTimeout((async () => {
      for await (const message of query) {
        const raw = collectText(message, state);
        if (raw.type === 'result') break;
      }
    })(), TIMEOUT_MS, '一次性调用', () => query.interrupt?.());
    const total = Date.now() - startedAt;
    const ttft = state.firstTextAt ? state.firstTextAt - startedAt : null;
    if (state.text) ok('返回：' + JSON.stringify(state.text.slice(0, 80)));
    else sdkIssue('没有拿到任何 assistant 文本（subtype=' + String(state.subtype) + '）');
    info('TTFT', ttft === null ? '未收到文本' : ttft + 'ms');
    info('总耗时', total + 'ms');
    if (state.subtype && state.subtype !== 'success') warn('result.subtype=' + state.subtype);
    if (total > 30_000) warn('单次最小请求超过 30s，实际翻译会明显更慢');
  } catch (error) {
    sdkIssue('调用失败：' + (error instanceof Error ? error.message : String(error)) + ' · ' + elapsed(startedAt));
    reportPartial(state);
  }
}

// ---------------------------------------------------------------- 5. 池化会话

head('池化会话（服务实际路径：unstable_v2_createSession）');
{
  const startedAt = Date.now();
  const state = { text: '', firstTextAt: 0, subtype: undefined, structuredOutput: undefined, isError: false };
  let session;
  try {
    const sdk = await import('@tencent-ai/agent-sdk');
    const options = buildTextSessionOptions({
      provider: 'workbuddy',
      model: DEFAULT_WORKBUDDY_MODEL,
    });
    info('传给 session 的 model', JSON.stringify(options.model ?? null));
    session = sdk.unstable_v2_createSession({ ...options, cwd: WORK_DIR });
    await withTimeout(session.connect(), TIMEOUT_MS, '会话 connect', () => session?.interrupt?.());
    info('session.getModel()', JSON.stringify(session.getModel?.() ?? null));
    // SDK 侧的 getModel() 只是内存状态，真正生效的是 CLI 进程的 --model 参数。
    info('CLI 进程 --model', JSON.stringify(readCliModelArg(session.sessionId)));
    if (DEFAULT_WORKBUDDY_MODEL && session.getModel?.() !== DEFAULT_WORKBUDDY_MODEL) {
      warn('会话里的模型与请求的不一致：' + JSON.stringify(session.getModel?.()) + ' ≠ ' + JSON.stringify(DEFAULT_WORKBUDDY_MODEL));
    }
    await session.send(PROMPT);
    await withTimeout((async () => {
      for await (const message of session.stream()) {
        const raw = collectText(message, state);
        if (raw.type === 'result') break;
      }
    })(), TIMEOUT_MS, '池化会话', () => session?.interrupt?.());
    const total = Date.now() - startedAt;
    const ttft = state.firstTextAt ? state.firstTextAt - startedAt : null;
    if (state.text) ok('返回：' + JSON.stringify(state.text.slice(0, 80)));
    else sdkIssue('会话没有返回文本（subtype=' + String(state.subtype) + '）');
    info('TTFT', ttft === null ? '未收到文本' : ttft + 'ms');
    info('总耗时', total + 'ms');
  } catch (error) {
    sdkIssue('会话失败：' + (error instanceof Error ? error.message : String(error)) + ' · ' + elapsed(startedAt));
    reportPartial(state);
  } finally {
    try { session?.close(); } catch { /* 已关闭 */ }
  }
}

/**
 * 从 CLI 子进程的启动参数里读出 --model。
 * 这是判断「模型到底有没有传下去」的唯一直接证据：SDK 的 getModel() 只反映内存状态，
 * 而 CLI 没收到 --model 时会静默回退到账号默认模型（可能收费、也可能不支持 json-schema）。
 */
function readCliModelArg(sessionId) {
  if (!sessionId) return null;
  try {
    const listing = execSync('pgrep -fl codebuddy-headless || true', { encoding: 'utf8' });
    const line = listing.split('\n').find((row) => row.includes(sessionId));
    if (!line) return null;
    const args = line.split(' ').slice(2);
    const at = args.indexOf('--model');
    return at >= 0 ? args[at + 1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 6. 真实使用的模型

head('CLI 日志里实际发出的请求');
{
  const models = readModelsFromLog(logCursor);
  if (!models.length) {
    warn('日志里没有新增请求记录（路径：' + logPath() + '）');
  } else {
    info('本轮实际请求模型', models.map((item) => item.model + ' ×' + item.count).join(', '));
    if (DEFAULT_WORKBUDDY_MODEL) {
      const hit = models.filter((item) => item.model === DEFAULT_WORKBUDDY_MODEL);
      if (hit.length) ok('确实在用 ' + DEFAULT_WORKBUDDY_MODEL);
      else fail('没有一次请求用到 ' + DEFAULT_WORKBUDDY_MODEL + ' —— 模型参数没传到 CLI');
    }
  }
  const autoResolved = readAutoResolvedFromLog(logCursor);
  if (autoResolved.length) {
    info('CLI 自动解析记录', autoResolved.slice(-3).join(' | '));
  }
}

// ---------------------------------------------------------------- 7. HTTP

head('本机服务 HTTP 层');
{
  const base = 'http://' + (HOST === '::1' ? '[::1]' : HOST) + ':' + PORT;
  const headers = LOCAL_TOKEN ? { Authorization: 'Bearer ' + LOCAL_TOKEN } : {};
  const startedAt = Date.now();
  let reachable = false;
  try {
    const response = await withTimeout(
      fetch(base + '/api/documents/projects?limit=1', { headers }),
      8_000,
      'HTTP 探测',
    );
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      reachable = true;
      ok('GET /api/documents/projects → ' + response.status + ' · ' + elapsed(startedAt));
    } else {
      fail('GET /api/documents/projects → ' + response.status + ' · ' + JSON.stringify(body).slice(0, 120));
    }
  } catch (error) {
    fail('连不上 ' + base + '：' + (error instanceof Error ? error.message : String(error)) + '（服务没起？）');
  }

  // 端到端：走服务自己的 /v1/chat/completions，验证「运行中的进程」到底用哪个模型。
  // 配置文件和本脚本解析得再对，正在跑的服务也可能是旧进程 —— 只有这一步能证明。
  if (reachable) {
    const cursor = markWorkspaceLog();
    const callStartedAt = Date.now();
    try {
      const response = await withTimeout(fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: PROMPT }] }),
      }), TIMEOUT_MS, '端到端补全');
      const body = await response.json().catch(() => ({}));
      const content = body?.choices?.[0]?.message?.content;
      if (response.ok && typeof content === 'string' && content.trim()) {
        ok('POST /v1/chat/completions → ' + response.status + ' · ' + elapsed(callStartedAt) + ' · ' + JSON.stringify(content.slice(0, 40)));
      } else {
        fail('POST /v1/chat/completions → ' + response.status + ' · ' + JSON.stringify(body).slice(0, 140));
      }
      const used = readModelsFromLog(cursor);
      if (used.length) {
        info('服务实际请求模型', used.map((item) => item.model + ' ×' + item.count).join(', '));
        if (DEFAULT_WORKBUDDY_MODEL && !used.some((item) => item.model === DEFAULT_WORKBUDDY_MODEL)) {
          fail('运行中的服务没有用 ' + DEFAULT_WORKBUDDY_MODEL + '（多半是进程还没重启，仍在跑旧配置）');
        }
      } else {
        warn('服务这次没有产生新的模型请求记录（可能命中了缓存）');
      }
    } catch (error) {
      fail('端到端补全失败：' + (error instanceof Error ? error.message : String(error)));
    }
  }
}

// ---------------------------------------------------------------- 汇总

console.log('\n' + '─'.repeat(56));
if (failures.length === 0) {
  console.log('结果：通过' + (warnings.length ? '（' + warnings.length + ' 条警告）' : ''));
} else {
  console.log('结果：' + failures.length + ' 项失败');
  for (const item of failures) console.log('  ✗ ' + item);
}
if (warnings.length) for (const item of warnings) console.log('  ! ' + item);
process.exit(failures.length ? 1 : 0);

// ---------------------------------------------------------------- 日志工具

function logPath() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const dir = path.join(
    os.homedir(), '.codebuddy', 'logs',
    now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
  );
  if (!fs.existsSync(dir)) return '';
  // workspace__*.log 是 cwd 为本服务 WORK_DIR 的 CLI 进程日志。
  const candidates = fs.readdirSync(dir)
    .filter((name) => name.startsWith('workspace__') && name.endsWith('.log'))
    .map((name) => ({ file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file || '';
}

function markWorkspaceLog() {
  const file = logPath();
  return { file, offset: file ? fs.statSync(file).size : 0 };
}

function readLogDelta(cursor) {
  if (!cursor.file || !fs.existsSync(cursor.file)) return '';
  const size = fs.statSync(cursor.file).size;
  if (size <= cursor.offset) return '';
  const length = size - cursor.offset;
  const fd = fs.openSync(cursor.file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, cursor.offset);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readModelsFromLog(cursor) {
  const text = readLogDelta(cursor);
  const counts = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('Sending request')) continue;
    const match = /model=([\w.:-]+)/.exec(line);
    if (!match) continue;
    counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }
  return Array.from(counts, ([model, count]) => ({ model, count }));
}

function readAutoResolvedFromLog(cursor) {
  const text = readLogDelta(cursor);
  return text.split('\n')
    .filter((line) => line.includes('has no explicit model'))
    .map((line) => line.replace(/^\[([^\]]+)\].*resolved to /, '$1 → '));
}
