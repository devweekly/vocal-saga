import { runOpenCode } from './opencode.ts';
import { runWorkbuddy, runWorkbuddyJson, runWorkbuddyStructured } from './workbuddy.ts';
import { parseJsonValue } from '../json.ts';

export async function runAgent(
  agent: { provider: string; model: string },
  prompt: string,
  systemPrompt: string,
  requestId = 'unknown',
  sessionScope?: string,
): Promise<string> {
  const startedAt = Date.now();
  console.info(
    '[local-agent][' + requestId + '] provider-start provider=' + agent.provider +
    ' model=' + (agent.model || '<runtime-default>') +
    ' systemChars=' + systemPrompt.length +
    ' promptChars=' + prompt.length,
  );
  try {
    let output: string;
    if (agent.provider === 'workbuddy') output = await runWorkbuddy(agent, prompt, systemPrompt, requestId, sessionScope);
    else if (agent.provider === 'opencode') output = await runOpenCode(agent, prompt, systemPrompt);
    else throw new Error('不支持的本机 Agent：' + agent.provider);
    console.info(
      '[local-agent][' + requestId + '] provider-success provider=' + agent.provider +
      ' durationMs=' + (Date.now() - startedAt) +
      ' outputChars=' + output.length,
    );
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      '[local-agent][' + requestId + '] provider-failed provider=' + agent.provider +
      ' durationMs=' + (Date.now() - startedAt) +
      ' error=' + message,
    );
    if (error instanceof Error && error.stack) {
      console.error('[local-agent][' + requestId + '] provider-stack=' + error.stack);
    }
    throw error;
  }
}

// 需要严格 JSON 对象的调用走这里，直接返回解析好的对象。
// workbuddy 用原生 structured output；opencode 暂无对应开关，沿用文本输出再解析。
export async function runAgentJson(
  agent: { provider: string; model: string },
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
): Promise<Record<string, any>> {
  const startedAt = Date.now();
  console.info(
    '[local-agent][' + requestId + '] provider-start provider=' + agent.provider +
    ' model=' + (agent.model || '<runtime-default>') +
    ' mode=json systemChars=' + systemPrompt.length +
    ' promptChars=' + prompt.length,
  );
  try {
    let parsed: Record<string, any>;
    if (agent.provider === 'workbuddy') {
      parsed = await runWorkbuddyJson(agent, prompt, systemPrompt, schema, requestId, sessionScope);
    } else if (agent.provider === 'opencode') {
      const output = await runOpenCode(agent, prompt, systemPrompt);
      const value = parseJsonValue(output);
      if (!value || Array.isArray(value)) throw new Error('OpenCode 返回内容不是预期 JSON 对象');
      parsed = value as Record<string, any>;
    } else {
      throw new Error('不支持的本机 Agent：' + agent.provider);
    }
    console.info(
      '[local-agent][' + requestId + '] provider-success provider=' + agent.provider +
      ' mode=json durationMs=' + (Date.now() - startedAt),
    );
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      '[local-agent][' + requestId + '] provider-failed provider=' + agent.provider +
      ' mode=json durationMs=' + (Date.now() - startedAt) +
      ' error=' + message,
    );
    if (error instanceof Error && error.stack) {
      console.error('[local-agent][' + requestId + '] provider-stack=' + error.stack);
    }
    throw error;
  }
}

// 需要严格 JSON（对象或数组）的调用走这里。用途：重试升级轮——
// 数组形状（如翻译条目表）无法用"对象专用"的 runAgentJson 表达。
export async function runAgentStructured(
  agent: { provider: string; model: string },
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
): Promise<Record<string, any> | any[]> {
  const startedAt = Date.now();
  console.info(
    '[local-agent][' + requestId + '] provider-start provider=' + agent.provider +
    ' model=' + (agent.model || '<runtime-default>') +
    ' mode=structured systemChars=' + systemPrompt.length +
    ' promptChars=' + prompt.length,
  );
  try {
    let result: Record<string, any> | any[];
    if (agent.provider === 'workbuddy') {
      result = await runWorkbuddyStructured(agent, prompt, systemPrompt, schema, requestId, sessionScope);
    } else if (agent.provider === 'opencode') {
      const output = await runOpenCode(agent, prompt, systemPrompt);
      const value = parseJsonValue(output);
      if (value === null) throw new Error('OpenCode 返回内容不是有效 JSON');
      result = value;
    } else {
      throw new Error('不支持的本机 Agent：' + agent.provider);
    }
    console.info(
      '[local-agent][' + requestId + '] provider-success provider=' + agent.provider +
      ' mode=structured durationMs=' + (Date.now() - startedAt),
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      '[local-agent][' + requestId + '] provider-failed provider=' + agent.provider +
      ' mode=structured durationMs=' + (Date.now() - startedAt) +
      ' error=' + message,
    );
    if (error instanceof Error && error.stack) {
      console.error('[local-agent][' + requestId + '] provider-stack=' + error.stack);
    }
    throw error;
  }
}
