import { REQUEST_TIMEOUT_MS, WORK_DIR } from '../config.ts';
import { parseJsonValue } from '../json.ts';
import { getTextPool } from './workbuddyPool.ts';
import { parseTurnUsage, type TurnUsage } from './usage.ts';
import { codeBuddyThinkingOption, type CodeBuddyTaskProfile } from './taskProfiles.ts';

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
export function buildWorkbuddyOptions(agent: WorkbuddyAgent, schema?: Record<string, unknown>, taskProfile?: CodeBuddyTaskProfile) {
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
    persistSession: false,
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
): Promise<{ text: string; structuredOutput: unknown; usage: TurnUsage | null }> {
  const sdk = await import('@tencent-ai/agent-sdk');
  const query = sdk.query({ prompt: buildCombinedPrompt(prompt, systemPrompt), options });
  let text = '';
  let structuredOutput: unknown;
  let usage: TurnUsage | null = null;
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
  } catch (error) {
    if (timedOut) throw new Error('Workbuddy 调用超时（' + REQUEST_TIMEOUT_MS + ' ms）');
    throw new Error('Workbuddy Agent SDK 调用失败：' + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw new Error('Workbuddy 调用超时（' + REQUEST_TIMEOUT_MS + ' ms）');
  return { text: text.trim(), structuredOutput, usage };
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
): Promise<{ parsed: Record<string, any> | any[]; usage: TurnUsage | null }> {
  let result: { text: string; structuredOutput: unknown; usage: TurnUsage | null };
  if (taskProfile) {
    // Query Options formally supports reasoning settings; SessionOptions does not expose them.
    result = await queryWorkbuddyRaw(agent, prompt, systemPrompt, buildWorkbuddyOptions(agent, schema, taskProfile), requestId);
  } else if (sessionScope) {
    const pool = getTextPool();
    const index = await pool.acquire(agent, sessionScope, schema);
    try {
      const promptForTurn = pool.isFresh(index) ? buildCombinedPrompt(prompt, systemPrompt) : prompt;
      const value = await pool.runPrompt(index, promptForTurn, requestId);
      result = { text: value.text, structuredOutput: value.structuredOutput, usage: value.usage };
    } finally {
      pool.release(index);
    }
  } else {
    result = await queryWorkbuddyRaw(agent, prompt, systemPrompt, buildWorkbuddyOptions(agent, schema), requestId);
  }
  return { parsed: resolveWorkbuddyStructured(result.structuredOutput, result.text), usage: result.usage };
}

export async function runWorkbuddyJson(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
): Promise<{ parsed: Record<string, any>; usage: TurnUsage | null }> {
  const result = await runWorkbuddyStructured(agent, prompt, systemPrompt, schema, requestId, sessionScope, taskProfile);
  if (!result.parsed || typeof result.parsed !== 'object' || Array.isArray(result.parsed)) {
    throw new Error('Workbuddy 返回内容不是预期 JSON 对象');
  }
  return { parsed: result.parsed as Record<string, any>, usage: result.usage };
}
