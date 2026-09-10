export interface SSEEvent {
  data: string;
}

export function parseSSELine(line: string): SSEEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) return null;

  const data = trimmed.slice(6);
  if (data === '[DONE]') return null;

  return { data };
}

export function extractDeltaContent(data: string): string | null {
  try {
    const parsed = JSON.parse(data);
    return parsed.choices?.[0]?.delta?.content || null;
  } catch {
    return null;
  }
}

/** DeepSeek 流式尾帧（需请求带 stream_options.include_usage=true）携带的用量，含 KV Cache 命中信息。 */
export interface SSEUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/** 从单条 SSE data 中解析 usage（流式尾帧）。无 usage 返回 null。 */
export function extractUsage(data: string): SSEUsage | null {
  try {
    const parsed = JSON.parse(data) as { usage?: unknown };
    if (parsed && typeof parsed.usage === 'object' && parsed.usage !== null) {
      return parsed.usage as SSEUsage;
    }
  } catch {
    /* 非 JSON / 无 usage 字段 */
  }
  return null;
}

export interface SSEChunk {
  delta: string | null;
  usage: SSEUsage | null;
}

export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const event = parseSSELine(line);
        if (!event) continue;

        const delta = extractDeltaContent(event.data);
        if (delta) {
          yield delta;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 与 parseSSEStream 行为一致，但额外从流式尾帧解析 usage（请求需带
 * stream_options.include_usage=true）。usage 通常出现在 choices 为空的最后
 * 一帧，含 prompt_cache_hit_tokens / prompt_cache_miss_tokens 供 KV Cache 遥测。
 * delta 与 usage 独立 yield，互不阻塞。
 */
export async function* parseSSEStreamWithUsage(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<SSEChunk, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const event = parseSSELine(line);
        if (!event) continue;

        const delta = extractDeltaContent(event.data);
        const usage = extractUsage(event.data);
        if (delta || usage) {
          yield { delta, usage };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
