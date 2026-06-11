import { describe, it, expect } from 'vitest';
import { parseSSELine, extractDeltaContent, parseSSEStream } from '../lib/translate/service/streamParser';

describe('parseSSELine', () => {
  it('should parse valid SSE data line', () => {
    const result = parseSSELine('data: {"choices":[{"delta":{"content":"hello"}}]}');
    expect(result).not.toBeNull();
    expect(result!.data).toBe('{"choices":[{"delta":{"content":"hello"}}]}');
  });

  it('should return null for [DONE]', () => {
    const result = parseSSELine('data: [DONE]');
    expect(result).toBeNull();
  });

  it('should return null for empty line', () => {
    expect(parseSSELine('')).toBeNull();
    expect(parseSSELine('   ')).toBeNull();
  });

  it('should return null for non-data line', () => {
    expect(parseSSELine('event: message')).toBeNull();
    expect(parseSSELine('id: 123')).toBeNull();
  });

  it('should handle line with extra whitespace', () => {
    const result = parseSSELine('  data: hello  ');
    expect(result).not.toBeNull();
    expect(result!.data).toBe('hello');
  });
});

describe('extractDeltaContent', () => {
  it('should extract content from valid delta', () => {
    const data = JSON.stringify({ choices: [{ delta: { content: 'hello' } }] });
    expect(extractDeltaContent(data)).toBe('hello');
  });

  it('should return null for missing content', () => {
    const data = JSON.stringify({ choices: [{ delta: {} }] });
    expect(extractDeltaContent(data)).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    expect(extractDeltaContent('not json')).toBeNull();
  });

  it('should return null for missing choices', () => {
    const data = JSON.stringify({});
    expect(extractDeltaContent(data)).toBeNull();
  });

  it('should handle multi-byte characters', () => {
    const data = JSON.stringify({ choices: [{ delta: { content: '你好世界' } }] });
    expect(extractDeltaContent(data)).toBe('你好世界');
  });
});

describe('parseSSEStream', () => {
  it('should parse complete SSE stream', async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      },
    });

    const reader = stream.getReader();
    const deltas: string[] = [];

    for await (const delta of parseSSEStream(reader)) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(['Hello', ' world']);
  });

  it('should handle fragmented data across reads', async () => {
    // Simulate data split across multiple reads
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel'));
        controller.enqueue(encoder.encode('lo"}}]}\n\ndata: {"choices":[{'));
        controller.enqueue(encoder.encode('"delta":{"content":" world"}}]}\n\n'));
        controller.close();
      },
    });

    const reader = stream.getReader();
    const deltas: string[] = [];

    for await (const delta of parseSSEStream(reader)) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(['Hello', ' world']);
  });

  it('should ignore malformed lines', async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"valid"}}]}\n\n',
      'data: invalid json\n\n',
      'data: {"choices":[{"delta":{"content":" after invalid"}}]}\n\n',
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      },
    });

    const reader = stream.getReader();
    const deltas: string[] = [];

    for await (const delta of parseSSEStream(reader)) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(['valid', ' after invalid']);
  });

  it('should handle empty stream', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const reader = stream.getReader();
    const deltas: string[] = [];

    for await (const delta of parseSSEStream(reader)) {
      deltas.push(delta);
    }

    expect(deltas).toEqual([]);
  });

  it('should release reader lock after completion', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const reader = stream.getReader();

    for await (const _ of parseSSEStream(reader)) {
      // consume
    }

    // Should not throw - reader is released
    expect(() => reader.releaseLock()).not.toThrow();
  });
});
