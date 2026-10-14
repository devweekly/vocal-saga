/**
 * Local Node.js translation provider for fanyi-extension.
 * Workbuddy uses @tencent-ai/agent-sdk query(); OpenCode uses 'opencode run --format json'.
 * The service binds to loopback only and denies tools for translation calls.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

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
const DEFAULT_WORKBUDDY_MODEL = (process.env.LOCAL_WORKBUDDY_MODEL || process.env.WORKBUDDY_MODEL || process.env.CODEBUDDY_DEFAULT_MODEL || '').trim();
const DEFAULT_OPENCODE_MODEL = (process.env.LOCAL_OPENCODE_MODEL || process.env.OPENCODE_MODEL || '').trim();

/** Parse optional integer settings without allowing malformed .env values to poison runtime timers/SQL. */
function positiveIntegerEnv(name, fallback, minimum = 1) {
  const raw = process.env[name];
  if (raw == null || !raw.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn('[local-agent] Ignoring invalid ' + name + '=' + JSON.stringify(raw) + '; using default ' + fallback);
    return fallback;
  }
  return Math.max(minimum, parsed);
}

const REQUEST_TIMEOUT_MS = positiveIntegerEnv('LOCAL_AGENT_TIMEOUT_MS', 180_000, 10_000);
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_HISTORY_ROWS = positiveIntegerEnv('LOCAL_AGENT_MAX_HISTORY', 500, 50);
const STORE_CONTENT = (process.env.LOCAL_AGENT_STORE_CONTENT || 'true').toLowerCase() !== 'false';

let db: DatabaseSync | undefined;
const app = express();
app.disable('x-powered-by');

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function sendJson(res: Response, status: number, body: unknown) {
  res.status(status).set('Cache-Control', 'no-store').json(body);
}

function addCors(req: Request, res: Response): boolean {
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

function authorize(req: Request): boolean {
  if (!LOCAL_TOKEN) return true;
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedBytes = Buffer.from(LOCAL_TOKEN);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function initDatabase(): DatabaseSync {
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
    'CREATE TABLE IF NOT EXISTS translation_cache (cache_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0);' +
    'CREATE INDEX IF NOT EXISTS idx_translation_cache_expires ON translation_cache(expires_at);' +
    'CREATE TABLE IF NOT EXISTS document_sessions (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, format TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS idx_document_sessions_updated ON document_sessions(updated_at DESC);' +
    'CREATE TABLE IF NOT EXISTS service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);'
  );
  database.prepare(
    'INSERT INTO service_settings(key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  ).run('store_content', String(STORE_CONTENT), new Date().toISOString());
  return database;
}


/** SQLite translation cache shared by webpages and document batches. */
function getTranslationCache(cacheKey: string) {
  const row = db.prepare(
    'SELECT payload_json FROM translation_cache WHERE cache_key = ? AND expires_at > ?'
  ).get(cacheKey, Date.now()) as { payload_json?: string } | undefined;
  if (!row?.payload_json) {
    db.prepare('DELETE FROM translation_cache WHERE cache_key = ? AND expires_at <= ?').run(cacheKey, Date.now());
    return null;
  }
  db.prepare('UPDATE translation_cache SET hits = hits + 1 WHERE cache_key = ?').run(cacheKey);
  try {
    const value = JSON.parse(row.payload_json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    db.prepare('DELETE FROM translation_cache WHERE cache_key = ?').run(cacheKey);
    return null;
  }
}

function setTranslationCache(cacheKey: string, value: unknown, ttlMs: number) {
  if (!cacheKey || cacheKey.length > 500) throw Object.assign(new Error('cacheKey 必须是 1-500 字符'), { status: 400 });
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload, 'utf8') > 2 * 1024 * 1024) {
    throw Object.assign(new Error('单条缓存超过 2 MiB'), { status: 413 });
  }
  const now = Date.now();
  const ttl = Number.isFinite(ttlMs) ? Math.max(60_000, Math.min(ttlMs, 90 * 24 * 60 * 60 * 1000)) : 7 * 24 * 60 * 60 * 1000;
  db.prepare(
    'INSERT INTO translation_cache(cache_key, payload_json, created_at, expires_at, hits) VALUES (?, ?, ?, ?, 0) ' +
    'ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json, created_at=excluded.created_at, expires_at=excluded.expires_at, hits=0'
  ).run(cacheKey, payload, new Date(now).toISOString(), now + ttl);
  // Opportunistic cleanup: expired rows and oldest/least-used rows are bounded.
  db.prepare('DELETE FROM translation_cache WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM translation_cache WHERE cache_key IN (SELECT cache_key FROM translation_cache ORDER BY hits ASC, created_at ASC LIMIT MAX(0, (SELECT COUNT(*) FROM translation_cache) - 20000))').run();
}

function normalizeDocumentSegments(input: unknown) {
  if (!Array.isArray(input) || input.length > 100000) throw Object.assign(new Error('segments 必须是数组，最多 100000 项'), { status: 400 });
  return input.flatMap((raw: any) => {
    if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.text !== 'string') return [];
    return [{
      id: raw.id.slice(0, 200),
      text: raw.text,
      kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 40) : 'paragraph',
      contextPath: typeof raw.contextPath === 'string' ? raw.contextPath.slice(0, 500) : '',
      page: Number.isFinite(raw.page) ? raw.page : null,
    }];
  });
}

/** Store resumable document state in SQLite; this is separate from short-lived request history. */
function saveDocumentSession(sessionId: string, title: string, format: string, payload: unknown, mergeExisting = false) {
  if (!sessionId || sessionId.length > 200) throw Object.assign(new Error('sessionId 必须是 1-200 字符'), { status: 400 });
  let storedPayload = payload;
  if (mergeExisting && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const existing = db.prepare('SELECT payload_json FROM document_sessions WHERE session_id = ?').get(sessionId) as { payload_json?: string } | undefined;
    if (existing?.payload_json) {
      try {
        const prior = JSON.parse(existing.payload_json);
        storedPayload = { ...prior, ...(payload as Record<string, unknown>) };
      } catch { /* corrupt prior session is replaced with the new valid snapshot */ }
    }
  }
  const json = JSON.stringify(storedPayload);
  if (Buffer.byteLength(json, 'utf8') > 5 * 1024 * 1024) throw Object.assign(new Error('文档快照超过 5 MiB'), { status: 413 });
  db.prepare(
    'INSERT INTO document_sessions(session_id, title, format, updated_at, payload_json) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, format=excluded.format, updated_at=excluded.updated_at, payload_json=excluded.payload_json'
  ).run(sessionId, title.slice(0, 500), format.slice(0, 20), new Date().toISOString(), json);
  db.prepare('DELETE FROM document_sessions WHERE session_id IN (SELECT session_id FROM document_sessions ORDER BY updated_at DESC LIMIT -1 OFFSET 30)').run();
}

function requestMetadata(body: any) {
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

function saveHistory({ id, endpoint, agent, body, output, error, durationMs, status }: any) {
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

export function parseAgentModel(modelValue: unknown, providerHint = '') {
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
  if (!model || model.toLowerCase() === 'auto') {
    model = provider === 'workbuddy' ? DEFAULT_WORKBUDDY_MODEL : DEFAULT_OPENCODE_MODEL;
    if (model.toLowerCase() === 'auto') model = '';
  }
  // 未显式配置模型时，交给已登录的 CLI/SDK 使用自身默认模型。
  // 只校验非空覆盖值，避免把“未设置模型”变成服务启动/路由故障。
  if (model && provider === 'opencode' && !model.includes('/')) {
    throw new Error('OpenCode 模型必须使用 provider/model 格式，例如 openai/gpt-5.4');
  }
  return { provider, model };
}

function normalizeMessages(messages: any) {
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

export function buildAgentPrompt(messages: any, jsonMode = false) {
  const normalized = normalizeMessages(messages);
  const formatRule = jsonMode
    ? '\n\n输出约束：只输出一个严格合法的 JSON 对象，不要 Markdown 代码围栏、前言或后记。保留调用方指定的全部字段和 ID。'
    : '';
  return { systemPrompt: normalized.systemPrompt, prompt: normalized.userPrompt + formatRule };
}

export function parseJsonObject(text: unknown): Record<string, any> | null {
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
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : null;
  } catch {
    const first = value.indexOf('{');
    const last = value.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try {
      const parsed = JSON.parse(value.slice(first, last + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : null;
    } catch {
      return null;
    }
  }
}

function buildOpenCodeConfig() {
  let existing: Record<string, any> = {};
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

function runOpenCode(agent: { provider: string; model: string }, prompt: string, systemPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullPrompt = [
      systemPrompt ? 'SYSTEM INSTRUCTIONS:\n' + systemPrompt : '',
      'USER REQUEST:\n' + prompt,
    ].filter(Boolean).join('\n\n');
    const args = ['run', '--format', 'json'];
    if (agent.model) args.push('--model', agent.model);
    args.push('--dir', WORK_DIR, '--agent', 'fanyi-local-translation', '--auto', fullPrompt);
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

async function runWorkbuddy(agent: { provider: string; model: string }, prompt: string, systemPrompt: string): Promise<string> {
  const sdk = await import('@tencent-ai/agent-sdk');
  const combinedPrompt = [systemPrompt ? 'SYSTEM INSTRUCTIONS:\n' + systemPrompt : '', 'USER REQUEST:\n' + prompt]
    .filter(Boolean).join('\n\n');
  const query = sdk.query({
    prompt: combinedPrompt,
    options: {
      ...(agent.model ? { model: agent.model } : {}),
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
      const raw: any = message && typeof message === 'object' ? message : {};
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

async function runAgent(agent: { provider: string; model: string }, prompt: string, systemPrompt: string): Promise<string> {
  if (agent.provider === 'workbuddy') return runWorkbuddy(agent, prompt, systemPrompt);
  if (agent.provider === 'opencode') return runOpenCode(agent, prompt, systemPrompt);
  throw new Error('不支持的本机 Agent：' + agent.provider);
}

function validateSegments(input: any, max: number, type: string) {
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

async function runLiteraryAnalysis(body: any) {
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

async function runLiteraryReview(body: any) {
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

async function handleRequest(req: Request, res: Response): Promise<void> {
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

  // These endpoints are local business/data operations; they do not invoke an LLM.
  if (req.method === 'POST' && url.pathname === '/api/cache/translation/get') {
    const cacheKey = typeof req.body?.cacheKey === 'string' ? req.body.cacheKey : '';
    if (!cacheKey || cacheKey.length > 500) { sendJson(res, 400, { error: 'cacheKey 必须是 1-500 字符' }); return; }
    const value = getTranslationCache(cacheKey);
    sendJson(res, 200, { hit: value !== null, value });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/cache/translation/set') {
    const cacheKey = typeof req.body?.cacheKey === 'string' ? req.body.cacheKey : '';
    if (!cacheKey || cacheKey.length > 500 || !Object.prototype.hasOwnProperty.call(req.body || {}, 'value')) {
      sendJson(res, 400, { error: 'cacheKey 与 value 为必填字段' }); return;
    }
    const ttlMs = Number.isFinite(req.body.ttlMs) ? req.body.ttlMs : 7 * 24 * 60 * 60 * 1000;
    setTranslationCache(cacheKey, req.body.value, ttlMs);
    sendJson(res, 200, { saved: true });
    return;
  }
  if (req.method === 'DELETE' && url.pathname === '/api/cache/translation') {
    db.prepare('DELETE FROM translation_cache').run();
    sendJson(res, 200, { cleared: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/documents/session/get') {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    const row = db.prepare('SELECT session_id, title, format, updated_at, payload_json FROM document_sessions WHERE session_id = ?').get(sessionId) as any;
    if (!row) { sendJson(res, 200, { found: false }); return; }
    try { sendJson(res, 200, { found: true, session: { sessionId: row.session_id, title: row.title, format: row.format, updatedAt: row.updated_at, payload: JSON.parse(row.payload_json) } }); }
    catch { db.prepare('DELETE FROM document_sessions WHERE session_id = ?').run(sessionId); sendJson(res, 200, { found: false }); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/documents/session/save') {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'payload')) { sendJson(res, 400, { error: 'payload 为必填字段' }); return; }
    saveDocumentSession(sessionId, typeof req.body.title === 'string' ? req.body.title : '未命名文档',
      typeof req.body.format === 'string' ? req.body.format : 'txt', req.body.payload, req.body.mergeExisting === true);
    sendJson(res, 200, { saved: true, updatedAt: new Date().toISOString() });
    return;
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/documents/session/')) {
    const sessionId = decodeURIComponent(url.pathname.slice('/api/documents/session/'.length));
    db.prepare('DELETE FROM document_sessions WHERE session_id = ?').run(sessionId);
    sendJson(res, 200, { deleted: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/documents/batches') {
    const segments = normalizeDocumentSegments(req.body?.segments);
    const maxChars = Number.isFinite(req.body?.budget?.maxChars) ? Math.max(100, Math.min(50000, Math.floor(req.body.budget.maxChars))) : 3000;
    const maxSegments = Number.isFinite(req.body?.budget?.maxSegments) ? Math.max(1, Math.min(500, Math.floor(req.body.budget.maxSegments))) : 24;
    const splitOnContextChange = req.body?.budget?.splitOnContextChange === true;
    const batches: Array<Array<{ id: string }>> = [];
    let current: Array<{ id: string }> = [];
    let chars = 0;
    let currentGroup = '';
    for (const segment of segments) {
      const group = segment.contextPath + '|page:' + (segment.page ?? '');
      if (current.length && (chars + segment.text.length > maxChars || current.length >= maxSegments ||
          (splitOnContextChange && group !== currentGroup))) {
        batches.push(current); current = []; chars = 0;
      }
      if (!current.length) currentGroup = group;
      current.push({ id: segment.id }); chars += segment.text.length;
    }
    if (current.length) batches.push(current);
    sendJson(res, 200, { batches, totalSegments: segments.length, totalChars: segments.reduce((n, item) => n + item.text.length, 0) });
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
  let body: any = {};
  let agent: { provider: string; model: string } = { provider: 'unknown', model: '' };
  let output = '';
  try {
    body = req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw Object.assign(new Error('JSON 请求体必须是对象'), { status: 400 });
    }
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
  db = initDatabase();

  // Run the origin/Host checks before parsing potentially large request bodies.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!addCors(req, res)) {
      sendJson(res, 403, { error: '本机服务不接受普通网页来源；请从浏览器扩展或本机命令行调用' });
      return;
    }
    const hostHeader = String(req.headers.host || '').trim().toLowerCase();
    const hostname = hostHeader.startsWith('[')
      ? hostHeader.slice(1, hostHeader.indexOf(']'))
      : hostHeader.replace(/:\d+$/, '');
    if (!isLoopbackHost(hostname)) {
      sendJson(res, 403, { error: '此服务只允许通过 localhost/127.0.0.1 访问' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: MAX_BODY_BYTES, strict: true }));
  app.use((req: Request, res: Response) => {
    void handleRequest(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  });
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = error?.status === 413 ? 413 : error?.status === 400 ? 400 : 500;
    sendJson(res, status, {
      error: status === 413
        ? '请求体超过 6 MiB 上限'
        : status === 400
          ? '请求体不是有效的 JSON'
          : '本机服务内部错误',
    });
  });

  const server = app.listen(PORT, HOST, () => {
    console.log('[local-agent] listening on http://' + HOST + ':' + PORT);
    console.log('[local-agent] provider default: ' + DEFAULT_PROVIDER);
    console.log('[local-agent] SQLite: ' + DATABASE_PATH);
    console.log('[local-agent] prompt/translation content storage: ' + String(STORE_CONTENT));
    if (!LOCAL_TOKEN) console.warn('[local-agent] LOCAL_AGENT_TOKEN is empty. Loopback-only access is enabled, but a token is recommended.');
    console.log('[local-agent] ready');
  });
  const shutdown = () => server.close(() => {
    try { db?.close(); } catch { /* ignore shutdown cleanup errors */ }
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}
