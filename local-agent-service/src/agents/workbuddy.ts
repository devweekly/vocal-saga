import { REQUEST_TIMEOUT_MS, WORK_DIR } from '../config.ts';
import { parseJsonValue } from '../json.ts';
import { getTextPool } from './workbuddyPool.ts';
import { parseTurnUsage, type TurnUsage } from './usage.ts';
import { codeBuddyThinkingOption, type CodeBuddyTaskProfile } from './taskProfiles.ts';
import { logInfo, logWarn } from '../log.ts';

const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
const JSON_MODE_MAX_TURNS = 5;

export interface WorkbuddyAgent {
  provider: string;
  model: string;
}

export function buildCombinedPrompt(prompt: string, systemPrompt: string): string {
  return [systemPrompt ? 'SYSTEM INSTRUCTIONS:\n' + systemPrompt : '', 'USER REQUEST:\n' + prompt]
    .filter(Boolean).join('\n\n');
}

/**
 * query() exposes the documented Options contract (thinking/effort/fallbackModel).
 * V2 SessionOptions currently documents a narrower contract, so task profiles use query()
 * rather than silently passing unsupported fields to unstable_v2_createSession().
 */
export function buildWorkbuddyOptions(
  agent: WorkbuddyAgent,
  schema?: Record<string, unknown>,
  taskProfile?: CodeBuddyTaskProfile,
  workflowSession: { sessionId?: string; persistSession?: boolean } = {},
) {
  const canUseTool = async (toolName: string) => {
    if (schema && toolName === STRUCTURED_OUTPUT_TOOL) return { behavior: 'allow' as const };
    return { behavior: 'deny' as const, message: '本机翻译 Provider 不允许执行工具：' + toolName };
  };
  const base = {
    ...(agent.model ? { model: agent.model } : {}),
    ...(taskProfile?.fallbackModel ? { fallbackModel: taskProfile.fallbackModel } : {}),
    cwd: WORK_DIR,
    permissionMode: 'default' as const,
    settingSources: [],
    persistSession: workflowSession.persistSession ?? false,
    ...(workflowSession.sessionId ? { resume: workflowSession.sessionId } : {}),
    thinking: taskProfile ? codeBuddyThinkingOption(taskProfile) : schema
      ? { type: 'adaptive' as const }
      : { type: 'disabled' as const },
    effort: taskProfile?.effort || (schema ? 'medium' as const : 'low' as const),
    canUseTool,
  };
  if (!schema) return { ...base, tools: [], allowedTools: [], maxTurns: 1 };
  return {
    ...base,
    tools: [STRUCTURED_OUTPUT_TOOL],
    allowedTools: [STRUCTURED_OUTPUT_TOOL],
    maxTurns: JSON_MODE_MAX_TURNS,
    outputFormat: { type: 'json_schema' as const, schema },
    extraArgs: { 'json-schema': JSON.stringify(schema) },
  };
}

async function queryWorkbuddyRaw(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  options: Record<string, any>,
  _requestId = 'unknown',
  timeoutMs = REQUEST_TIMEOUT_MS,
  onSessionId?: (sessionId: string) => void,
): Promise<{ text: string; structuredOutput: unknown; usage: TurnUsage | null; sessionId?: string }> {
  const sdk = await import('@tencent-ai/agent-sdk');
  const query = sdk.query({ prompt: buildCombinedPrompt(prompt, systemPrompt), options });
  const startedAt = Date.now();
  let text = '';
  let structuredOutput: unknown;
  let usage: TurnUsage | null = null;
  let sessionId: string | undefined;
  let timedOut = false;
  // 事件计数用于心跳：结构化输出只在结束时一次性返回，文本可能一直是 0 字，
  // 只看字数会让人误判成「没动静」。
  let messageCount = 0;
  // 与池化会话同理：interrupt() 不保证让事件流结束，超时必须由竞速来判定，
  // 否则 CLI 卡住时这里会永久挂着，调用方（例如全书预处理）永远停在「运行中」。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      logWarn('agent', '一次性调用超时 · ' + (timeoutMs / 1000).toFixed(0) + 's · request=' + String(_requestId).slice(0, 40)
        + ' · 上限可用 LOCAL_AGENT_TIMEOUT_MS（单次调用）/ LOCAL_AGENT_ANALYSIS_TIMEOUT_MS（全书预处理）调整');
      try { Promise.resolve(query.interrupt?.()).catch(() => {}); } catch { /* timeout is handled below */ }
      reject(new Error('Workbuddy 调用超时（' + (timeoutMs / 1000).toFixed(0) + 's 内未返回）'));
    }, timeoutMs);
    timer.unref?.();
  });
  const consume = (async () => {
    for await (const message of query) {
      const raw: any = message && typeof message === 'object' ? message : {};
      messageCount += 1;
      // SDK init events carry the durable session_id needed to resume a later workflow stage.
      const observedSessionId = [raw.session_id, raw.sessionId, raw.session?.id, raw.message?.session_id]
        .find((value) => typeof value === 'string' && value.trim());
      if (typeof observedSessionId === 'string' && observedSessionId !== sessionId) {
        sessionId = observedSessionId;
        onSessionId?.(sessionId);
      }
      if (raw.type === 'assistant' && raw.message && Array.isArray(raw.message.content)) {
        for (const part of raw.message.content) {
          if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            text += (text ? '\n' : '') + part.text;
          }
        }
      }
      if (raw.type === 'result') {
        if (raw.subtype && raw.subtype !== 'success') {
          throw new Error('Workbuddy 执行失败：' + String(raw.error?.message || raw.error || raw.subtype));
        }
        if (raw.structured_output !== undefined) structuredOutput = raw.structured_output;
        usage = parseTurnUsage(raw);
      }
    }
  })();
  // 长任务（全书预处理）动辄十几分钟：中途没有任何输出时，终端无法区分「在跑」和「卡死」。
  // 心跳只在放宽了上限的长调用上开，普通翻译批次保持安静。
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (timeoutMs > 60_000) {
    heartbeat = setInterval(() => {
      logInfo('agent', '调用仍在进行 · 已等待 ' + ((Date.now() - startedAt) / 1000).toFixed(0) + 's'
        + ' · 事件 ' + messageCount + ' 条 · 已收文本 ' + text.length + ' 字 · request=' + String(_requestId).slice(0, 40));
    }, 30_000);
    heartbeat.unref?.();
  }
  try {
    await Promise.race([consume, timeoutPromise]);
  } catch (error) {
    if (timedOut) throw new Error('Workbuddy 调用超时（' + (timeoutMs / 1000).toFixed(0) + 's 内未返回）');
    throw new Error('Workbuddy Agent SDK 调用失败：' + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
  }
  if (timedOut) throw new Error('Workbuddy 调用超时（' + (timeoutMs / 1000).toFixed(0) + 's 内未返回）');
  return { text: text.trim(), structuredOutput, usage, ...(sessionId ? { sessionId } : {}) };
}

export async function runWorkbuddy(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
): Promise<{ text: string; usage: TurnUsage | null }> {
  // Task profiles must go through query() so thinking/effort/fallbackModel are honored.
  if (taskProfile) {
    const result = await queryWorkbuddyRaw(agent, prompt, systemPrompt, buildWorkbuddyOptions(agent, undefined, taskProfile), requestId);
    if (!result.text) throw new Error('Workbuddy 已结束，但没有返回译文');
    return { text: result.text, usage: result.usage };
  }
  const pool = getTextPool();
  const index = await pool.acquire(agent, sessionScope || 'shared-text-translation');
  try {
    const firstMessage = !sessionScope || pool.isFresh(index)
      ? buildCombinedPrompt(prompt, systemPrompt)
      : prompt;
    const result = await pool.runPrompt(index, firstMessage, requestId);
    if (!result.text) throw new Error('Workbuddy 已结束，但没有返回译文');
    return { text: result.text, usage: result.usage };
  } finally {
    pool.release(index);
  }
}

export function resolveWorkbuddyStructured(structuredOutput: unknown, text: string): Record<string, any> | any[] {
  if (structuredOutput && typeof structuredOutput === 'object') {
    return structuredOutput as Record<string, any> | any[];
  }
  const parsed = parseJsonValue(text);
  if (parsed !== null) return parsed;
  throw new Error('Workbuddy 返回内容不是有效 JSON');
}

export function resolveWorkbuddyJson(structuredOutput: unknown, text: string): Record<string, any> {
  const parsed = resolveWorkbuddyStructured(structuredOutput, text);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, any>;
  }
  throw new Error('Workbuddy 返回内容不是预期 JSON 对象');
}

export async function runWorkbuddyStructured(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
  options: {
    timeoutMs?: number;
    sessionId?: string;
    persistSession?: boolean;
    onSessionId?: (sessionId: string) => void;
  } = {},
): Promise<{ parsed: Record<string, any> | any[]; usage: TurnUsage | null; sessionId?: string }> {
  let result: { text: string; structuredOutput: unknown; usage: TurnUsage | null };
  // 长任务（全书预处理）显式放宽上限；普通翻译批次沿用 REQUEST_TIMEOUT_MS。
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (taskProfile) {
    // Query Options formally supports reasoning settings; SessionOptions does not expose them.
    result = await queryWorkbuddyRaw(
      agent, prompt, systemPrompt,
      buildWorkbuddyOptions(agent, schema, taskProfile, options),
      requestId, timeoutMs, options.onSessionId,
    );
  } else if (sessionScope) {
    const pool = getTextPool();
    const index = await pool.acquire(agent, sessionScope, schema);
    try {
      const promptForTurn = pool.isFresh(index) ? buildCombinedPrompt(prompt, systemPrompt) : prompt;
      const value = await pool.runPrompt(index, promptForTurn, requestId, timeoutMs);
      result = { text: value.text, structuredOutput: value.structuredOutput, usage: value.usage };
    } finally {
      pool.release(index);
    }
  } else {
    result = await queryWorkbuddyRaw(
      agent, prompt, systemPrompt, buildWorkbuddyOptions(agent, schema, undefined, options),
      requestId, timeoutMs, options.onSessionId,
    );
  }
  return {
    parsed: resolveWorkbuddyStructured(result.structuredOutput, result.text),
    usage: result.usage,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  };
}

export async function runWorkbuddyJson(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
  options: { timeoutMs?: number } = {},
): Promise<{ parsed: Record<string, any>; usage: TurnUsage | null }> {
  const result = await runWorkbuddyStructured(agent, prompt, systemPrompt, schema, requestId, sessionScope, taskProfile, options);
  if (!result.parsed || typeof result.parsed !== 'object' || Array.isArray(result.parsed)) {
    throw new Error('Workbuddy 返回内容不是预期 JSON 对象');
  }
  return { parsed: result.parsed as Record<string, any>, usage: result.usage };
}
