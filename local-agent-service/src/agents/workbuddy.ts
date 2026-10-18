import { REQUEST_TIMEOUT_MS, WORK_DIR } from '../config.ts';
import { parseJsonValue } from '../json.ts';
import { getTextPool } from './workbuddyPool.ts';
import { codeBuddyThinkingOption, type CodeBuddyTaskProfile } from './taskProfiles.ts';

// 原生 structured output 的工具名（CLI 内置，见 SDK 的 StructuredOutputTool 说明）。
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
// JSON 模式需要模型先调用 StructuredOutput 工具再结束，轮数必须大于单轮文本模式。
const JSON_MODE_MAX_TURNS = 5;

export interface WorkbuddyAgent {
  provider: string;
  model: string;
}

// prompt 组装：系统指令与用户请求拼成单轮文本（池复用与单次 query 共用）。
export function buildCombinedPrompt(prompt: string, systemPrompt: string): string {
  return [systemPrompt ? 'SYSTEM INSTRUCTIONS:\n' + systemPrompt : '', 'USER REQUEST:\n' + prompt]
    .filter(Boolean).join('\n\n');
}

// 组装 query() 的 options：纯文本模式禁用全部工具；
// JSON 模式开启原生 structured output（outputFormat 等官方 SDK 修复透传后生效，
// 当前实际生效的是 --json-schema 进程参数，由 transport 的 extraArgs 原样拼接）。
export function buildWorkbuddyOptions(agent: WorkbuddyAgent, schema?: Record<string, unknown>, taskProfile?: CodeBuddyTaskProfile) {
  const canUseTool = async (toolName: string) => {
    // StructuredOutput 是被动的数据收口工具，不需审批；其他工具一律拒绝。
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
    // Use documented SDK options rather than CLI-only extraArgs for reasoning behaviour.
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
    // JSON 模式（分析/审校需判断）保持 CLI 默认思考与 effort：这里只追加 json-schema。
    extraArgs: { 'json-schema': JSON.stringify(schema) },
  };
}

// 执行一次单轮 query，同时收集 assistant 文本与 result.structured_output。
// structured_output 只有 CLI 真正启用 jsonSchema 时才有，文本始终收集，用作兼容解析。
async function queryWorkbuddyRaw(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  options: Record<string, any>,
  _requestId = 'unknown',
): Promise<{ text: string; structuredOutput: unknown }> {
  const sdk = await import('@tencent-ai/agent-sdk');
  const combinedPrompt = buildCombinedPrompt(prompt, systemPrompt);
  const query = sdk.query({ prompt: combinedPrompt, options });
  let text = '';
  let structuredOutput: unknown;
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
      }
    }
  } catch (error) {
    if (timedOut) throw new Error('Workbuddy 调用超时（' + REQUEST_TIMEOUT_MS + ' ms）');
    throw new Error('Workbuddy Agent SDK 调用失败：' + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw new Error('Workbuddy 调用超时（' + REQUEST_TIMEOUT_MS + ' ms）');
  // Provider-level TTFT/JSON implementation details are intentionally not printed here.
  // The workflow trace records task, batch, total duration and output validity once, at the boundary.
  return { text: text.trim(), structuredOutput };
}

export async function runWorkbuddy(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
): Promise<string> {
  // 普通文本沿用已有池；书籍任务必须传专属 scope，绝不与网页/其他书共用上下文。
  const pool = getTextPool();
  const index = await pool.acquire(agent, sessionScope || 'shared-text-translation', undefined, taskProfile);
  try {
    // 对书籍会话只在新会话的首轮注入稳定 system prompt；后续轮次沿用会话上下文，
    // 当前章名、实体记忆与译文样例仍由调用方放在当轮 user payload 中。
    const firstMessage = !sessionScope || pool.isFresh(index)
      ? buildCombinedPrompt(prompt, systemPrompt)
      : prompt;
    const { text } = await pool.runPrompt(index, firstMessage, requestId);
    if (!text) throw new Error('Workbuddy 已结束，但没有返回译文');
    return text;
  } finally {
    pool.release(index);
  }
}

// 解析 structured 输出（对象或数组）：优先使用原生的 result.structured_output；
// 当前 SDK 的 JS 层尚未透传 outputFormat 时回退到从文本提取 JSON。
export function resolveWorkbuddyStructured(structuredOutput: unknown, text: string): Record<string, any> | any[] {
  if (structuredOutput && typeof structuredOutput === 'object') {
    return structuredOutput as Record<string, any> | any[];
  }
  const parsed = parseJsonValue(text);
  if (parsed !== null) return parsed;
  throw new Error('Workbuddy 返回内容不是有效 JSON');
}

// 对象专用版本（文学分析/审校）：数组视为形状错误。
export function resolveWorkbuddyJson(structuredOutput: unknown, text: string): Record<string, any> {
  const parsed = resolveWorkbuddyStructured(structuredOutput, text);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, any>;
  }
  throw new Error('Workbuddy 返回内容不是预期 JSON 对象');
}

// 需要严格 JSON（对象或数组）的调用走这里，返回解析好的值。
// 用途：重试升级轮——--json-schema 把形状写死做约束解码，逼模型吐完整结构。
export async function runWorkbuddyStructured(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
): Promise<Record<string, any> | any[]> {
  let text: string;
  let structuredOutput: unknown;
  if (sessionScope) {
    // 文学分析与 Reviewer 也使用会话，但按职责隔离，并使用各自固定的 JSON schema。
    const pool = getTextPool();
    const index = await pool.acquire(agent, sessionScope, schema, taskProfile);
    try {
      const promptForTurn = pool.isFresh(index) ? buildCombinedPrompt(prompt, systemPrompt) : prompt;
      const result = await pool.runPrompt(index, promptForTurn, requestId);
      text = result.text;
      structuredOutput = result.structuredOutput;
    } finally {
      pool.release(index);
    }
  } else {
    // 普通 JSON 请求维持一次性 query，避免改变网页/通用调用原有语义。
    const result = await queryWorkbuddyRaw(agent, prompt, systemPrompt, buildWorkbuddyOptions(agent, schema, taskProfile), requestId);
    text = result.text;
    structuredOutput = result.structuredOutput;
  }
  const parsed = resolveWorkbuddyStructured(structuredOutput, text);
  // Keep the native-vs-text parsing decision available to the caller through shape validation.
  // Printing it for every model call duplicated the useful workflow summary without explaining the task.
  return parsed;
}

// 需要严格 JSON 对象的调用走这里，返回解析好的对象而不是文本。
export async function runWorkbuddyJson(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
): Promise<Record<string, any>> {
  const parsed = await runWorkbuddyStructured(agent, prompt, systemPrompt, schema, requestId, sessionScope, taskProfile);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Workbuddy 返回内容不是预期 JSON 对象');
  }
  return parsed as Record<string, any>;
}
