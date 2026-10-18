import { runOpenCode } from './opencode.ts';
import { runWorkbuddy, runWorkbuddyJson, runWorkbuddyStructured } from './workbuddy.ts';
import { parseJsonValue } from '../json.ts';
<<<<<<< HEAD
import { formatTurnUsageLog, type TurnUsage } from './usage.ts';
=======
import { applyCodeBuddyTaskPrompt, type CodeBuddyTaskProfile } from './taskProfiles.ts';
>>>>>>> 0feee1178869920eb5291de8df541df36441d80d

type AgentSpec = { provider: string; model: string };

function isWorkflowManaged(sessionScope?: string): boolean {
  return !!sessionScope && (sessionScope.startsWith('document:') || sessionScope.startsWith('context-graph:'));
}

function describeTask(requestId: string, sessionScope?: string): string {
  if (requestId.includes('style-review')) return '人物声音/文风审校';
  if (requestId.includes('-review-') || sessionScope?.includes(':review:')) return '准确性/术语审校';
  if (sessionScope?.startsWith('context-graph:') || requestId.startsWith('context-graph:')) return '全书预处理';
  if (sessionScope?.includes(':translation:') || /-b\d+-a\d+$/.test(requestId)) return '文档初译';
  if (requestId.includes('literary')) return '文学分析';
  return '通用模型请求';
}

function compactOutputSummary(value: unknown): string {
  if (typeof value === 'string') return '文本 ' + value.length + ' 字符';
  if (Array.isArray(value)) return '数组 ' + value.length + ' 项';
  if (!value || typeof value !== 'object') return typeof value;
  const row = value as Record<string, unknown>;
  const counts: string[] = [];
  for (const key of ['translations', 'findings', 'characters', 'entities', 'relationships', 'chapterSummaries', 'openQuestions']) {
    if (Array.isArray(row[key])) counts.push(key + '=' + (row[key] as unknown[]).length);
  }
  return counts.length ? counts.join(' ') : 'JSON 字段 ' + Object.keys(row).slice(0, 8).join(', ');
}

function logModelStart(
  agent: AgentSpec, prompt: string, systemPrompt: string, requestId: string,
  sessionScope: string | undefined, mode: string,
): void {
  if (isWorkflowManaged(sessionScope)) return; // Document Project emits richer batch/stage traces.
  const task = describeTask(requestId, sessionScope);
  console.info('[model] ' + task + ' · 开始 · request=' + requestId.slice(0, 12) +
    ' · ' + agent.provider + '/' + (agent.model || '运行时默认模型') +
    ' · 模式=' + mode + ' · 输入=' + prompt.length.toLocaleString() +
    ' 字符 · 系统指令=' + systemPrompt.length.toLocaleString() + ' 字符');
}

function logModelSuccess(
  agent: AgentSpec, output: unknown, requestId: string, sessionScope: string | undefined,
  startedAt: number, mode: string, usage: TurnUsage | null = null,
): void {
  if (isWorkflowManaged(sessionScope)) return;
  console.info('[model] ' + describeTask(requestId, sessionScope) + ' · 完成 · request=' + requestId.slice(0, 12) +
    ' · ' + agent.provider + '/' + (agent.model || '运行时默认模型') +
    ' · 耗时=' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's · 输出=' + compactOutputSummary(output) +
    ' · ' + formatTurnUsageLog(usage) + ' · 模式=' + mode);
}

function logModelFailure(
  agent: AgentSpec, error: unknown, requestId: string, sessionScope: string | undefined,
  startedAt: number, mode: string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const task = describeTask(requestId, sessionScope);
  const duration = ((Date.now() - startedAt) / 1000).toFixed(1) + 's';
  if (isWorkflowManaged(sessionScope)) {
    // The workflow event has the specific batch/stage ID. Avoid a duplicate low-level stack dump.
    return;
  }
  console.error('[model] ' + task + ' · 失败 · request=' + requestId.slice(0, 12) +
    ' · ' + agent.provider + '/' + (agent.model || '运行时默认模型') + ' · 耗时=' + duration + ' · ' + message);
  if (process.env.LOCAL_AGENT_LOG_LEVEL === 'debug' && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
}

<<<<<<< HEAD
export interface AgentRunResult<T> {
  result: T;
  /** 本轮 token 消耗（费用口径）；provider 不支持计量时为 null。 */
  usage: TurnUsage | null;
}

=======
/**
 * 统一的文本模型调用入口。
 * 根据 AgentSpec 选择 Workbuddy SDK 或 OpenCode，并统一记录开始/成功/失败日志。
 * document/context-graph 等工作流通过 sessionScope 由上层事件账本记录细节，避免重复输出噪声日志。
 */
>>>>>>> 0feee1178869920eb5291de8df541df36441d80d
export async function runAgent(
  agent: AgentSpec,
  prompt: string,
  systemPrompt: string,
  requestId = 'unknown',
  sessionScope?: string,
<<<<<<< HEAD
): Promise<AgentRunResult<string>> {
=======
  taskProfile?: CodeBuddyTaskProfile,
): Promise<string> {
>>>>>>> 0feee1178869920eb5291de8df541df36441d80d
  const startedAt = Date.now();
  const effective = taskProfile ? applyCodeBuddyTaskPrompt(prompt, systemPrompt, taskProfile) : { prompt, systemPrompt };
  const effectiveAgent = agent.provider === 'workbuddy' && taskProfile?.model
    ? { ...agent, model: taskProfile.model }
    : agent;
  logModelStart(effectiveAgent, effective.prompt, effective.systemPrompt, requestId, sessionScope, '文本');
  try {
    let output: string;
<<<<<<< HEAD
    let usage: TurnUsage | null = null;
    if (agent.provider === 'workbuddy') {
      const r = await runWorkbuddy(agent, prompt, systemPrompt, requestId, sessionScope);
      output = r.text;
      usage = r.usage;
    } else if (agent.provider === 'opencode') {
      output = await runOpenCode(agent, prompt, systemPrompt);
    } else throw new Error('不支持的本机 Agent：' + agent.provider);
    logModelSuccess(agent, output, requestId, sessionScope, startedAt, '文本', usage);
    return { result: output, usage };
=======
    if (effectiveAgent.provider === 'workbuddy') output = await runWorkbuddy(effectiveAgent, effective.prompt, effective.systemPrompt, requestId, sessionScope, taskProfile);
    else if (effectiveAgent.provider === 'opencode') output = await runOpenCode(effectiveAgent, effective.prompt, effective.systemPrompt);
    else throw new Error('不支持的本机 Agent：' + effectiveAgent.provider);
    logModelSuccess(effectiveAgent, output, requestId, sessionScope, startedAt, '文本');
    return output;
>>>>>>> 0feee1178869920eb5291de8df541df36441d80d
  } catch (error) {
    logModelFailure(effectiveAgent, error, requestId, sessionScope, startedAt, '文本');
    throw error;
  }
}

/** Strict JSON object output: prefer native structured output and validate the returned shape. */
export async function runAgentJson(
  agent: AgentSpec,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
<<<<<<< HEAD
): Promise<AgentRunResult<Record<string, any>>> {
=======
  taskProfile?: CodeBuddyTaskProfile,
): Promise<Record<string, any>> {
>>>>>>> 0feee1178869920eb5291de8df541df36441d80d
  const startedAt = Date.now();
  const effective = taskProfile ? applyCodeBuddyTaskPrompt(prompt, systemPrompt, taskProfile) : { prompt, systemPrompt };
  const effectiveAgent = agent.provider === 'workbuddy' && taskProfile?.model
    ? { ...agent, model: taskProfile.model }
    : agent;
  logModelStart(effectiveAgent, effective.prompt, effective.systemPrompt, requestId, sessionScope, 'JSON 对象');
  try {
    let parsed: Record<string, any>;
<<<<<<< HEAD
    let usage: TurnUsage | null = null;
    if (agent.provider === 'workbuddy') {
      const r = await runWorkbuddyJson(agent, prompt, systemPrompt, schema, requestId, sessionScope);
      parsed = r.parsed;
      usage = r.usage;
    } else if (agent.provider === 'opencode') {
      const output = await runOpenCode(agent, prompt, systemPrompt);
=======
    if (effectiveAgent.provider === 'workbuddy') {
      parsed = await runWorkbuddyJson(effectiveAgent, effective.prompt, effective.systemPrompt, schema, requestId, sessionScope, taskProfile);
    } else if (effectiveAgent.provider === 'opencode') {
      const output = await runOpenCode(effectiveAgent, effective.prompt, effective.systemPrompt);
>>>>>>> 0feee1178869920eb5291de8df541df36441d80d
      const value = parseJsonValue(output);
      if (!value || Array.isArray(value)) throw new Error('OpenCode 返回内容不是预期 JSON 对象');
      parsed = value as Record<string, any>;
    } else {
      throw new Error('不支持的本机 Agent：' + agent.provider);
    }
<<<<<<< HEAD
    logModelSuccess(agent, parsed, requestId, sessionScope, startedAt, 'JSON 对象', usage);
    return { result: parsed, usage };
=======
    logModelSuccess(effectiveAgent, parsed, requestId, sessionScope, startedAt, 'JSON 对象');
    return parsed;
>>>>>>> 0feee1178869920eb5291de8df541df36441d80d
  } catch (error) {
    logModelFailure(effectiveAgent, error, requestId, sessionScope, startedAt, 'JSON 对象');
    throw error;
  }
}

/** Strict JSON object/array output; used for translation arrays and schema-constrained retries. */
export async function runAgentStructured(
  agent: AgentSpec,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
<<<<<<< HEAD
): Promise<AgentRunResult<Record<string, any> | any[]>> {
=======
  taskProfile?: CodeBuddyTaskProfile,
): Promise<Record<string, any> | any[]> {
>>>>>>> 0feee1178869920eb5291de8df541df36441d80d
  const startedAt = Date.now();
  const effective = taskProfile ? applyCodeBuddyTaskPrompt(prompt, systemPrompt, taskProfile) : { prompt, systemPrompt };
  const effectiveAgent = agent.provider === 'workbuddy' && taskProfile?.model
    ? { ...agent, model: taskProfile.model }
    : agent;
  logModelStart(effectiveAgent, effective.prompt, effective.systemPrompt, requestId, sessionScope, '结构化 JSON');
  try {
    let result: Record<string, any> | any[];
<<<<<<< HEAD
    let usage: TurnUsage | null = null;
    if (agent.provider === 'workbuddy') {
      const r = await runWorkbuddyStructured(agent, prompt, systemPrompt, schema, requestId, sessionScope);
      result = r.parsed;
      usage = r.usage;
    } else if (agent.provider === 'opencode') {
      const output = await runOpenCode(agent, prompt, systemPrompt);
=======
    if (effectiveAgent.provider === 'workbuddy') {
      result = await runWorkbuddyStructured(effectiveAgent, effective.prompt, effective.systemPrompt, schema, requestId, sessionScope, taskProfile);
    } else if (effectiveAgent.provider === 'opencode') {
      const output = await runOpenCode(effectiveAgent, effective.prompt, effective.systemPrompt);
>>>>>>> 0feee1178869920eb5291de8df541df36441d80d
      const value = parseJsonValue(output);
      if (value === null) throw new Error('OpenCode 返回内容不是有效 JSON');
      result = value;
    } else {
      throw new Error('不支持的本机 Agent：' + agent.provider);
    }
<<<<<<< HEAD
    logModelSuccess(agent, result, requestId, sessionScope, startedAt, '结构化 JSON', usage);
    return { result, usage };
=======
    logModelSuccess(effectiveAgent, result, requestId, sessionScope, startedAt, '结构化 JSON');
    return result;
>>>>>>> 0feee1178869920eb5291de8df541df36441d80d
  } catch (error) {
    logModelFailure(effectiveAgent, error, requestId, sessionScope, startedAt, '结构化 JSON');
    throw error;
  }
}
