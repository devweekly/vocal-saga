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
