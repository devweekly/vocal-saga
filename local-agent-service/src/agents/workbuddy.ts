import { REQUEST_TIMEOUT_MS, WORK_DIR } from '../config.ts';

export async function runWorkbuddy(agent: { provider: string; model: string }, prompt: string, systemPrompt: string): Promise<string> {
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
      persistSession: false,
      maxTurns: 1,
      canUseTool: async (toolName: string) => ({
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
