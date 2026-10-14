import { runOpenCode } from './opencode.ts';
import { runWorkbuddy } from './workbuddy.ts';

export async function runAgent(
  agent: { provider: string; model: string },
  prompt: string,
  systemPrompt: string,
  requestId = 'unknown',
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
    if (agent.provider === 'workbuddy') output = await runWorkbuddy(agent, prompt, systemPrompt);
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
