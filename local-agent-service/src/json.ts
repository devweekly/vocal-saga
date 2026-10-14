import { DEFAULT_OPENCODE_MODEL, DEFAULT_PROVIDER, DEFAULT_WORKBUDDY_MODEL } from './config.ts';

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

export function normalizeMessages(messages: any) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages 必须是非空数组');
  const system: string[] = [];
  const conversation: string[] = [];
  for (const item of messages) {
    if (!item || !['system', 'developer', 'user', 'assistant'].includes(item.role)) continue;
    const content = typeof item.content === 'string'
      ? item.content
      : Array.isArray(item.content)
        ? item.content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('\n')
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
    ? '\n\n输出约束：只输出一个严格合法的 JSON 对象或数组；具体结构以 SYSTEM INSTRUCTIONS 和 USER REQUEST 为准。不要 Markdown 代码围栏、前言或后记。保留调用方指定的全部字段与 ID。'
    : '';
  return { systemPrompt: normalized.systemPrompt, prompt: normalized.userPrompt + formatRule };
}

/**
 * 解析模型输出中的 JSON 对象或数组。
 *
 * 翻译提示词的历史协议允许返回 JSON 数组，而文学分析/Reviewer 使用 JSON 对象。
 * 不能因为顶层是数组就把成功的翻译响应误判为 502。
 * 同时接受代码围栏，或 JSON 前后附带少量解释文本的常见模型输出。
 */
export function parseJsonValue(text: unknown): Record<string, any> | any[] | null {
  const original = String(text ?? '').trim();
  if (!original) return null;

  const fence = String.fromCharCode(96).repeat(3);
  const fenceStart = original.indexOf(fence);
  const fenceEnd = original.lastIndexOf(fence);
  let value = original;
  if (fenceStart >= 0 && fenceEnd > fenceStart) {
    value = original.slice(fenceStart + fence.length, fenceEnd).trim();
    value = value.replace(/^json\s*/i, '');
  }

  const parseContainer = (candidate: string): Record<string, any> | any[] | null => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed !== null && typeof parsed === 'object'
        ? parsed as Record<string, any> | any[]
        : null;
    } catch {
      return null;
    }
  };

  const direct = parseContainer(value);
  if (direct !== null) return direct;

  // Find the first complete top-level object/array while respecting escaped quotes and nesting.
  // This handles output such as "Result:\\n[{...}]" without slicing on braces inside strings.
  for (let start = 0; start < value.length; start += 1) {
    const opening = value[start];
    if (opening !== '{' && opening !== '[') continue;
    const stack: string[] = [opening === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
      const char = value[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if (char === '}' || char === ']') {
        if (stack[stack.length - 1] !== char) break;
        stack.pop();
        if (stack.length === 0) {
          const parsed = parseContainer(value.slice(start, index + 1));
          if (parsed !== null) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

/** Retain an object-only parser for the literary analysis and Reviewer schemas. */
export function parseJsonObject(text: unknown): Record<string, any> | null {
  const parsed = parseJsonValue(text);
  return parsed && !Array.isArray(parsed) ? parsed as Record<string, any> : null;
}
