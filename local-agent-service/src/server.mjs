/**
 * Local Node.js translation provider for fanyi-extension.
 * Workbuddy uses @tencent-ai/agent-sdk query(); OpenCode uses 'opencode run --format json'.
 * The service binds to loopback only and denies tools for translation calls.
 */
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = (process.env.LOCAL_AGENT_HOST || '127.0.0.1').trim();
const PORT = Number.parseInt(process.env.LOCAL_AGENT_PORT || '8789', 10);
const DATA_DIR = path.resolve(process.env.LOCAL_AGENT_DATA_DIR || path.join(homedir(), '.vocal-saga-local-agent'));
const DATABASE_PATH = path.resolve(process.env.LOCAL_AGENT_DATABASE || path.join(DATA_DIR, 'local-agent.sqlite'));
const WORK_DIR = path.resolve(process.env.LOCAL_AGENT_WORKDIR || path.join(DATA_DIR, 'workspace'));
const configuredToken = (process.env.LOCAL_AGENT_TOKEN || '').trim();
// Token is optional for loopback-only use. Treat the example placeholder as unset.
const LOCAL_TOKEN = configuredToken && !/replace-with-a-long-random-token/i.test(configuredToken)
  ? configuredToken
  : '';
const DEFAULT_PROVIDER = (process.env.LOCAL_AGENT_PROVIDER || 'opencode').toLowerCase();
const DEFAULT_WORKBUDDY_MODEL = process.env.LOCAL_WORKBUDDY_MODEL || process.env.WORKBUDDY_MODEL || process.env.CODEBUDDY_DEFAULT_MODEL || '';
const DEFAULT_OPENCODE_MODEL = process.env.LOCAL_OPENCODE_MODEL || process.env.OPENCODE_MODEL || '';
const REQUEST_TIMEOUT_MS = Math.max(10_000, Number.parseInt(process.env.LOCAL_AGENT_TIMEOUT_MS || '180000', 10));
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_HISTORY_ROWS = Math.max(50, Number.parseInt(process.env.LOCAL_AGENT_MAX_HISTORY || '500', 10));
const STORE_CONTENT = (process.env.LOCAL_AGENT_STORE_CONTENT || 'true').toLowerCase() !== 'false';

let db;

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function addCors(req, res) {
  // A loopback service can still be targeted by a webpage open in the browser.
  // Permit browser extension origins only; allow command-line clients with no Origin header.
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { return false; }
    if (!['chrome-extension:', 'moz-extension:', 'safari-web-extension:'].includes(parsed.protocol) || !parsed.hostname) {
      return false;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function authorize(req) {
  if (!LOCAL_TOKEN) return true;
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedBytes = Buffer.from(LOCAL_TOKEN);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error('请求体超过 6 MiB 上限'), { status: 413 });
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON 请求体必须是对象');
    return body;
  } catch (error) {
    throw Object.assign(new Error('请求体不是有效的 JSON：' + (error instanceof Error ? error.message : String(error))), { status: 400 });
  }
}

function initDatabase() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  const database = new DatabaseSync(DATABASE_PATH);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  database.exec(
    'CREATE TABLE IF NOT EXISTS request_history (' +
    'id TEXT PRIMARY KEY, created_at TEXT NOT NULL, endpoint TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, ' +
    'status TEXT NOT NULL, duration_ms INTEGER NOT NULL, input_chars INTEGER NOT NULL, output_chars INTEGER NOT NULL, ' +
    'request_json TEXT, response_text TEXT, error TEXT);' +
    'CREATE INDEX IF NOT EXISTS idx_request_history_created_at ON request_history(created_at DESC);' +
    'CREATE TABLE IF NOT EXISTS service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);'
  );
  database.prepare(
    'INSERT INTO service_settings(key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  ).run('store_content', String(STORE_CONTENT), new Date().toISOString());
  return database;
}

function requestMetadata(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const joined = messages.map((item) => typeof item?.content === 'string' ? item.content : '').join('\n');
  return {
    model: typeof body.model === 'string' ? body.model.slice(0, 240) : '',
    messageCount: messages.length,
    inputChars: joined.length,
    responseFormat: body.response_format?.type || 'text',
    messageRoles: messages.map((item) => typeof item?.role === 'string' ? item.role : 'unknown'),
  };
}

function saveHistory({ id, endpoint, agent, body, output, error, durationMs, status }) {
  const record = requestMetadata(body || {});
  const requestJson = STORE_CONTENT
    ? JSON.stringify(body || {})
    : JSON.stringify({ ...record, contentStored: false });
  const responseText = STORE_CONTENT ? (output || null) : null;
  db.prepare(
    'INSERT INTO request_history (id, created_at, endpoint, provider, model, status, duration_ms, input_chars, output_chars, request_json, response_text, error) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id, new Date().toISOString(), endpoint, agent?.provider || 'unknown',
    agent?.model || record.model, status, durationMs, record.inputChars,
    (output || '').length, requestJson, responseText, error ? String(error).slice(0, 2000) : null,
  );
  db.prepare(
    'DELETE FROM request_history WHERE id IN (' +
    'SELECT id FROM request_history ORDER BY created_at DESC LIMIT -1 OFFSET ?)'
  ).run(MAX_HISTORY_ROWS);
}

export function parseAgentModel(modelValue, providerHint = '') {
  const raw = typeof modelValue === 'string' ? modelValue.trim() : '';
  const hint = typeof providerHint === 'string' ? providerHint.trim().toLowerCase() : '';
  let provider = DEFAULT_PROVIDER;
  let model = '';

  const match = /^(?:local-)?(workbuddy|opencode)(?::(.+))?$/i.exec(raw);
  if (match) {
    provider = match[1].toLowerCase();
    model = (match[2] || '').trim();
  } else if (['workbuddy', 'opencode'].includes(hint)) {
    provider = hint;
    model = raw && raw.toLowerCase() !== 'auto' ? raw : '';
  } else if (raw.includes('/') && DEFAULT_PROVIDER === 'opencode') {
    provider = 'opencode';
    model = raw;
  }

  if (provider !== 'workbuddy' && provider !== 'opencode') throw new Error('LOCAL_AGENT_PROVIDER 只支持 workbuddy 或 opencode');
  if (!model || model.toLowerCase() === 'auto') model = provider === 'workbuddy' ? DEFAULT_WORKBUDDY_MODEL : DEFAULT_OPENCODE_MODEL;
  if (!model) {
    const required = provider === 'workbuddy'
      ? '请设置 LOCAL_WORKBUDDY_MODEL（也兼容 WORKBUDDY_MODEL / CODEBUDDY_DEFAULT_MODEL）'
      : '请设置 LOCAL_OPENCODE_MODEL（格式为 provider/model，例如 openai/gpt-5.4）';
    throw new Error('没有配置 ' + provider + ' 模型。' + required);
  }
  if (provider === 'opencode' && !model.includes('/')) throw new Error('OpenCode 模型必须使用 provider/model 格式，例如 openai/gpt-5.4');
  return { provider, model };
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages 必须是非空数组');
  const system = [];
  const conversation = [];
  for (const item of messages) {
    if (!item || !['system', 'developer', 'user', 'assistant'].includes(item.role)) continue;
    const content = typeof item.content === 'string'
      ? item.content
      : Array.isArray(item.content)
        ? item.content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n')
        : '';
    if (!content.trim()) continue;
    if (item.role === 'system' || item.role === 'developer') system.push(content.trim());
    else conversation.push(item.role.toUpperCase() + ':\n' + content.trim());
  }
  if (!conversation.length) throw new Error('messages 中没有有效的 user/assistant 内容');
  return { systemPrompt: system.join('\n\n'), userPrompt: conversation.join('\n\n') };
}

export function buildAgentPrompt(messages, jsonMode = false) {
  const normalized = normalizeMessages(messages);
  const formatRule = jsonMode
    ? '\n\n输出约束：只输出一个严格合法的 JSON 对象，不要 Markdown 代码围栏、前言或后记。保留调用方指定的全部字段和 ID。'
    : '';
  return { systemPrompt: normalized.systemPrompt, prompt: normalized.userPrompt + formatRule };
}

export function parseJsonObject(text) {
  let value = String(text || '').trim();
  // Avoid brittle escaping for Markdown fences; model runtimes sometimes wrap valid JSON this way.
  const fence = String.fromCharCode(96).repeat(3);
  if (value.startsWith(fence)) {
    value = value.slice(fence.length).trimStart();
    if (value.slice(0, 4).toLowerCase() === 'json') value = value.slice(4).trimStart();
  }
  if (value.endsWith(fence)) value = value.slice(0, -fence.length).trimEnd();
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const first = value.indexOf('{');
    const last = value.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try {
      const parsed = JSON.parse(value.slice(first, last + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function buildOpenCodeConfig() {
  let existing = {};
  if (process.env.OPENCODE_CONFIG_CONTENT?.trim()) {
    try { existing = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT); }
    catch { throw new Error('OPENCODE_CONFIG_CONTENT 不是合法 JSON'); }
  }
  const agents = existing.agent && typeof existing.agent === 'object' && !Array.isArray(existing.agent) ? existing.agent : {};
  const prior = agents['fanyi-local-translation'] && typeof agents['fanyi-local-translation'] === 'object'
    ? agents['fanyi-local-translation'] : {};
  return JSON.stringify({
    ...existing,
    agent: {
      ...agents,
      'fanyi-local-translation': {
        ...prior,
        mode: 'primary',
        tools: { ...(prior.tools || {}), '*': false },
        permission: { ...(prior.permission || {}), '*': 'deny' },
      },
    },
  });
}

function runOpenCode(agent, prompt, systemPrompt) {
  return new Promise((resolve, reject) => {
    const fullPrompt = [
      systemPrompt ? 'SYSTEM INSTRUCTIONS:\n' + systemPrompt : '',
      'USER REQUEST:\n' + prompt,
    ].filter(Boolean).join('\n\n');
    const args = ['run', '--format', 'json', '--model', agent.model, '--dir', WORK_DIR,
      '--agent', 'fanyi-local-translation', '--auto', fullPrompt];
    const child = spawn('opencode', args, {
      cwd: WORK_DIR,
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: buildOpenCodeConfig() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let answer = '';
    let stdoutFallback = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 3000).unref();
    }, REQUEST_TIMEOUT_MS);
    timer.unref();

    const handleLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;
      let event;
      try { event = JSON.parse(line); }
      catch { stdoutFallback += (stdoutFallback ? '\n' : '') + line; return; }
      if (event.type === 'text' && typeof event.part?.text === 'string') answer += event.part.text;
      if (event.type === 'error') stderr += '\n' + String(event.error?.message || event.message || 'OpenCode 调用失败');
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error('无法启动 OpenCode CLI。请确认 opencode 命令和登录状态：' + error.message));
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (buffer.trim()) handleLine(buffer);
      const output = answer.trim() || stdoutFallback.trim();
      if (timedOut) {
        reject(new Error('OpenCode 调用超时（' + REQUEST_TIMEOUT_MS + ' ms）'));
        return;
      }
      if (signal || code !== 0) {
        reject(new Error('OpenCode 执行失败（exit=' + code + (signal ? ', signal=' + signal : '') + '）：' + (stderr.trim() || output.slice(-1000) || '无详细错误')));
        return;
      }
      if (!output) {
        reject(new Error('OpenCode 已退出，但没有输出译文。' + (stderr.trim() ? ' ' + stderr.trim().slice(-1000) : '')));
        return;
      }
      resolve(output);
    });
  });
}

async function runWorkbuddy(agent, prompt, systemPrompt) {
  const sdk = await import('@tencent-ai/agent-sdk');
  const combinedPrompt = [systemPrompt ? 'SYSTEM INSTRUCTIONS:\n' + systemPrompt : '', 'USER REQUEST:\n' + prompt]
    .filter(Boolean).join('\n\n');
  const query = sdk.query({
    prompt: combinedPrompt,
    options: {
      model: agent.model,
      cwd: WORK_DIR,
      permissionMode: 'default',
      tools: [],
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
      canUseTool: async (toolName) => ({
        behavior: 'deny',
        message: '本机翻译 Provider 不允许执行工具：' + toolName,
      }),
    },
  });
  let answer = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { Promise.resolve(query.interrupt?.()).catch(() => {}); } catch { /* timeout is handled below */ }
  }, REQUEST_TIMEOUT_MS);
  timer.unref();
  try {
    for await (const message of query) {
      const raw = message && typeof message === 'object' ? message : {};
      if (raw.type === 'assistant' && raw.message && Array.isArray(raw.message.content)) {
        for (const part of raw.message.content) {
          if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) answer += (answer ? '\n' : '') + part.text;
        }
      }
      if (raw.type === 'result' && raw.subtype && raw.subtype !== 'success') {
        throw new Error('Workbuddy 执行失败：' + String(raw.error?.message || raw.error || raw.subtype));
      }
    }
  } catch (error) {
    if (timedOut) throw new Error('Workbuddy 调用超时（' + REQUEST_TIMEOUT_MS + ' ms）');
    throw new Error('Workbuddy Agent SDK 调用失败：' + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw new Error('Workbuddy 调用超时（' + REQUEST_TIMEOUT_MS + ' ms）');
  if (!answer.trim()) throw new Error('Workbuddy 已结束，但没有返回译文');
  return answer.trim();
}

async function runAgent(agent, prompt, systemPrompt) {
  if (agent.provider === 'workbuddy') return runWorkbuddy(agent, prompt, systemPrompt);
  if (agent.provider === 'opencode') return runOpenCode(agent, prompt, systemPrompt);
  throw new Error('不支持的本机 Agent：' + agent.provider);
}

function validateSegments(input, max, type) {
  if (!Array.isArray(input) || input.length < 1 || input.length > max) {
    throw Object.assign(new Error('segments 必须是 1-' + max + ' 个片段的数组'), { status: 400 });
  }
  const seen = new Set();
  const segments = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim()) continue;
    if (seen.has(raw.id)) throw Object.assign(new Error('segments 包含重复 ID：' + raw.id), { status: 400 });
    seen.add(raw.id);
    if (type === 'review') {
      if (typeof raw.source !== 'string' || !raw.source.trim() || typeof raw.draft !== 'string' || !raw.draft.trim()) continue;
      segments.push({
        id: raw.id.slice(0, 160), source: raw.source.slice(0, 4000), draft: raw.draft.slice(0, 5000),
        kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 30) : 'paragraph',
        contextPath: typeof raw.contextPath === 'string' ? raw.contextPath.slice(0, 160) : '',
      });
    } else {
      if (typeof raw.text !== 'string' || !raw.text.trim()) continue;
      segments.push({
        id: raw.id.slice(0, 160), text: raw.text.slice(0, 900),
        kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 30) : 'paragraph',
        contextPath: typeof raw.contextPath === 'string' ? raw.contextPath.slice(0, 160) : '',
      });
    }
  }
  if (!segments.length) throw Object.assign(new Error('没有有效的片段'), { status: 400 });
  return segments;
}

async function runLiteraryAnalysis(body) {
  const chapterTitle = typeof body.chapterTitle === 'string' ? body.chapterTitle.slice(0, 160) : '未命名章节';
  const segments = validateSegments(body.segments, 24, 'analyze');
  const memory = body.memory && typeof body.memory === 'object' ? body.memory : {};
  const systemPrompt = [
    '你是文学作品的书籍记忆分析器，不是翻译器。',
    '只根据给定原文提取记忆，不猜测未出现的事实。新建实体与关系均是建议项，reviewStatus 必须是 suggested；模型不能声称任何条目已经过人工确认。',
    '已有实体的 source→target 规范译名必须沿用，不能擅自更改；人物/事物关系只记录原文支持的明确事实。',
    '实体字段：source、target、kind（person/place/object/organization/concept/other）、aliases、description、evidence、reviewStatus。',
    '关系字段：subject、predicate、object、evidence、reviewStatus。',
    '只返回 JSON 对象：{ "entities": [], "relationships": [], "styleGuide": {}, "chapterSummary": "" }。styleGuide 可包含 narrativeVoice、register、rhythm、dialogue、diction、avoid。',
  ].join('\n');
  const prompt = [
    '目标语言：' + (body.target || 'zh'), '章节：' + chapterTitle,
    '当前书籍记忆（只读参考；模型条目不能当作人工确认）：', JSON.stringify(memory).slice(0, 30000),
    '本章原文片段：', JSON.stringify(segments),
  ].join('\n\n');
  const agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
  const output = await runAgent(agent, prompt, systemPrompt);
  const parsed = parseJsonObject(output);
  if (!parsed || !Array.isArray(parsed.entities) || !Array.isArray(parsed.relationships)) {
    throw new Error('本章分析结果不是预期 JSON；请重试分析');
  }
  const summary = typeof parsed.chapterSummary === 'string' ? parsed.chapterSummary.slice(0, 420) : '';
  return {
    analyzed: true,
    chapterTitle,
    memory: {
      version: 1,
      entities: parsed.entities.slice(0, 120).map((item) => ({ ...item, reviewStatus: 'suggested' })),
      relationships: parsed.relationships.slice(0, 160).map((item) => ({ ...item, reviewStatus: 'suggested' })),
      styleGuide: parsed.styleGuide && typeof parsed.styleGuide === 'object' ? parsed.styleGuide : {},
      chapterSummaries: summary ? [{ chapter: chapterTitle, summary }] : [],
      recentExamples: [],
    },
  };
}

async function runLiteraryReview(body) {
  const segments = validateSegments(body.segments, 32, 'review');
  const memory = body.memory && typeof body.memory === 'object' ? body.memory : {};
  const systemPrompt = [
    '你是文学翻译的独立审校者。目标是找到明确错误，不是把译文改成你偏好的文风。',
    '每个片段输出 finalTranslation 和 findings。category 只能 accuracy、terminology、style；priority 只能 must_fix、optional。',
    '只有明确改变原意、事实、情节、否定/时态/视角/指代/人物关系，或违反已有规范译名时才允许 must_fix。style 一律 optional。',
    '只要没有 must_fix，finalTranslation 必须与 draft 完全相同，不许改写正文。must_fix 时仅做最小修正。',
    '只返回严格 JSON：{ "results": [{ "id": "...", "finalTranslation": "...", "findings": [{ "category": "accuracy|terminology|style", "priority": "must_fix|optional", "sourceExcerpt": "...", "draftExcerpt": "...", "reason": "...", "suggestion": "..." }] }] }。',
  ].join('\n');
  const prompt = [
    '目标语言：' + (body.target || 'zh'),
    '章节：' + (typeof body.chapterTitle === 'string' ? body.chapterTitle : ''),
    '书籍记忆（只读）：', JSON.stringify(memory).slice(0, 30000),
    '待审校片段：', JSON.stringify(segments),
  ].join('\n\n');
  const agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
  const output = await runAgent(agent, prompt, systemPrompt);
  const parsed = parseJsonObject(output);
  if (!parsed || !Array.isArray(parsed.results)) throw new Error('Reviewer 返回格式异常；请重试，扩展端会保留初译');
  const byId = new Map(segments.map((item) => [item.id, item]));
  const translations = {};
  const findings = [];
  for (const raw of parsed.results.slice(0, 32)) {
    if (!raw || typeof raw.id !== 'string' || !byId.has(raw.id)) continue;
    const original = byId.get(raw.id);
    const candidateFindings = [];
    if (Array.isArray(raw.findings)) {
      for (const item of raw.findings.slice(0, 12)) {
        if (!item || !['accuracy', 'terminology', 'style'].includes(item.category)) continue;
        const priority = item.category !== 'style' && item.priority === 'must_fix' ? 'must_fix' : 'optional';
        const finding = {
          id: raw.id, category: item.category, priority,
          sourceExcerpt: typeof item.sourceExcerpt === 'string' ? item.sourceExcerpt.slice(0, 240) : '',
          draftExcerpt: typeof item.draftExcerpt === 'string' ? item.draftExcerpt.slice(0, 240) : '',
          reason: typeof item.reason === 'string' ? item.reason.slice(0, 400) : '',
          suggestion: typeof item.suggestion === 'string' ? item.suggestion.slice(0, 400) : '',
        };
        if (finding.reason || finding.suggestion) candidateFindings.push(finding);
      }
    }
    findings.push(...candidateFindings);
    const hasMustFix = candidateFindings.some((item) => item.priority === 'must_fix');
    const candidate = typeof raw.finalTranslation === 'string' && raw.finalTranslation.trim()
      ? raw.finalTranslation.trim().slice(0, 5000) : original.draft;
    translations[raw.id] = hasMustFix ? candidate : original.draft;
  }
  const expectedIds = segments.map((item) => item.id);
  return {
    translations,
    reviewedIds: expectedIds.filter((id) => typeof translations[id] === 'string'),
    missingIds: expectedIds.filter((id) => typeof translations[id] !== 'string'),
    findings: findings.slice(0, 240),
  };
}

async function handleRequest(req, res) {
  if (!addCors(req, res)) {
    sendJson(res, 403, { error: '本机服务不接受普通网页来源；请从浏览器扩展或本机命令行调用' });
    return;
  }
  const hostHeader = String(req.headers.host || '').trim().toLowerCase();
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(1, hostHeader.indexOf(']'))
    : hostHeader.replace(/:\\d+$/, '');
  if (!isLoopbackHost(hostname)) { sendJson(res, 403, { error: '此服务只允许通过 localhost/127.0.0.1 访问' }); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true, service: 'vocal-saga-local-agent', version: '1.0.0',
      providers: ['workbuddy', 'opencode'], defaultProvider: DEFAULT_PROVIDER,
      database: path.basename(DATABASE_PATH), storeContent: STORE_CONTENT,
    });
    return;
  }
  if ((url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) && !authorize(req)) {
    sendJson(res, 401, { error: { message: '本机服务 Token 不正确或未提供', type: 'authentication_error' } });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: [
      { id: 'workbuddy', object: 'model', owned_by: 'local' },
      { id: 'opencode', object: 'model', owned_by: 'local' },
    ] });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('limit') || '30', 10)));
    const rows = db.prepare(
      'SELECT id, created_at, endpoint, provider, model, status, duration_ms, input_chars, output_chars, request_json, response_text, error ' +
      'FROM request_history ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
    sendJson(res, 200, { rows, storeContent: STORE_CONTENT });
    return;
  }
  if (req.method === 'DELETE' && url.pathname === '/api/history') {
    db.exec('DELETE FROM request_history;');
    sendJson(res, 200, { cleared: true });
    return;
  }
  const supported = new Set([
    'POST /v1/chat/completions',
    'POST /api/translate/document/literary/analyze',
    'POST /api/translate/document/literary/review',
  ]);
  if (!supported.has(req.method + ' ' + url.pathname)) {
    sendJson(res, 404, { error: { message: '未知端点：' + req.method + ' ' + url.pathname } });
    return;
  }

  const startedAt = Date.now();
  const requestId = randomUUID();
  let body = {};
  let agent = { provider: 'unknown', model: '' };
  let output = '';
  try {
    body = await readJson(req);
    if (url.pathname === '/v1/chat/completions') {
      if (typeof body.model !== 'string' || !body.model.trim()) throw Object.assign(new Error('model 是必填字段'), { status: 400 });
      const normalized = normalizeMessages(body.messages);
      agent = parseAgentModel(body.model);
      const jsonMode = body.response_format?.type === 'json_object';
      const prompt = jsonMode
        ? normalized.userPrompt + '\n\n输出约束：只返回严格合法的 JSON 对象，不要 Markdown、前言或后记。'
        : normalized.userPrompt;
      output = await runAgent(agent, prompt, normalized.systemPrompt);
      if (jsonMode) {
        const parsedOutput = parseJsonObject(output);
        if (!parsedOutput) throw new Error('本机 Agent 返回内容不是有效 JSON；请重试该批次');
        output = JSON.stringify(parsedOutput);
      }
      sendJson(res, 200, {
        id: 'chatcmpl-' + requestId, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: output }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } else if (url.pathname.endsWith('/analyze')) {
      agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
      const result = await runLiteraryAnalysis(body);
      output = JSON.stringify(result);
      sendJson(res, 200, result);
    } else {
      agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
      const result = await runLiteraryReview(body);
      output = JSON.stringify(result);
      sendJson(res, 200, result);
    }
    saveHistory({ id: requestId, endpoint: url.pathname, agent, body, output,
      durationMs: Date.now() - startedAt, status: 'success' });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 502;
    const message = error instanceof Error ? error.message : String(error);
    saveHistory({ id: requestId, endpoint: url.pathname, agent, body, output,
      error: message, durationMs: Date.now() - startedAt, status: 'error' });
    const payload = url.pathname === '/v1/chat/completions'
      ? { error: { message, type: 'local_agent_error' } } : { error: message };
    if (!res.headersSent) sendJson(res, status, payload);
    else res.end();
  }
}

export function startLocalAgentServer() {
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    throw new Error('LOCAL_AGENT_HOST 必须是 loopback 地址（默认 127.0.0.1），本服务不允许监听局域网');
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('LOCAL_AGENT_PORT 不合法');
  // Local single-user service: authentication is optional because the server binds
  // exclusively to loopback. If configured, the token is still enforced per request.
  db = initDatabase();
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  });
  server.listen(PORT, HOST, () => {
    console.log('[local-agent] listening on http://' + HOST + ':' + PORT);
    console.log('[local-agent] provider default: ' + DEFAULT_PROVIDER);
    console.log('[local-agent] SQLite: ' + DATABASE_PATH);
    console.log('[local-agent] prompt/translation content storage: ' + String(STORE_CONTENT));
    if (!LOCAL_TOKEN) console.warn('[local-agent] LOCAL_AGENT_TOKEN is empty. Loopback-only access is enabled, but a token is recommended.');
  });
  const shutdown = () => server.close(() => { try { db?.close(); } catch {} process.exit(0); });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startLocalAgentServer();
