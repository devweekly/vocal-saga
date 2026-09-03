/**
 * 管线层并发度回归测试（P0-3）。
 *
 * 背景：`translateChunksWithRetry` 的 `concurrency` 参数曾经只是**打印进日志**
 * 而从不生效 —— 实现是 `chunks.map(worker)` + `Promise.all`，即一次性把所有
 * chunk 全部发出。长文（上百 chunk）会瞬间打满上游，触发 429。
 *
 * 这里在**管线真实路径**上断言并发上限，而不只是单测工具函数：
 * 只要有人把 `runWithConcurrency` 换回 `Promise.all`，本文件必须失败。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertPublicUrl } from '../lib/urlUtils';

// =============================================================================
// DeepSeek service mock：统计并记录并发峰值
// =============================================================================

let inFlight = 0;
let peak = 0;

/** 制造计数探针：每进入一次累加，退出时递减，并记录并发峰值 */
function makeProbe() {
  return async function translate(jsonContent: string): Promise<string> {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      // 模拟上游延迟，让并发窗口有机会叠加（否则串行也会"看起来"没超）
      await new Promise((r) => setTimeout(r, 10));
      const blocks = JSON.parse(jsonContent) as Array<{ id: string; text: string }>;
      return JSON.stringify(
        blocks.map((b) => ({ id: b.id, translated_text: `${b.text} [zh]` })),
      );
    } finally {
      inFlight--;
    }
  };
}

vi.mock('../lib/translate/service/deepseek', () => ({
  DeepSeekTranslationService: class {
    translate = makeProbe();
  },
}));

// OpenRouter 同理：它走动态 import，需要单独 mock
vi.mock('../lib/translate/service/openrouter', () => ({
  OpenRouterTranslationService: class {
    translate = makeProbe();
  },
}));

import { translateUrl } from '../lib/translate/pipeline';

// =============================================================================
// 本地 server：返回一篇足够长的文章，保证 chunk 数 > 并发上限
// =============================================================================

let server: http.Server;
let baseUrl: string;
let localPort = 0;

/** 只放行本地 server，其余交回 assertPublicUrl */
const localGuard = (url: string): void => {
  const { hostname, port } = new URL(url);
  if (hostname === '127.0.0.1' && port === String(localPort)) return;
  assertPublicUrl(url);
};

beforeAll(async () => {
  // 约束：
  //   1. 单段 textContent 必须 < MAX_TEXT_LENGTH(3072)，否则整段被丢弃；
  //   2. 段落之间不能高度重复，否则会被模板/样板文本检测判为噪声，
  //      最后只剩标题一个 block（实测踩过）。
  // 生成方式：用固定词表 + 下标哈希造句，段落各不相同且长度稳定在 ~2900 字符
  // （≈725 tokens）。chunkBuilder 的 TARGET_TOKENS 是 10000，约 14 段一个
  // chunk；140 段 → 约 10 个 chunk，远超 deepseek 的并发上限 4。
  const VOCAB = [
    'systems', 'latency', 'retries', 'jitter', 'timeouts', 'consensus',
    'replication', 'sharding', 'throughput', 'backpressure', 'idempotency',
    'observability', 'telemetry', 'scheduling', 'partitioning', 'durability',
    'failover', 'quorum', 'sagas', 'streaming', 'batching', 'throttling',
  ];

  const buildParagraph = (n: number): string => {
    // 120 个词 ≈ 1100 字符，稳稳落在 MAX_TEXT_LENGTH(3072) 以内。
    const words: string[] = [];
    let h = (n + 1) * 2654435761;
    for (let i = 0; i < 120; i++) {
      // xorshift 哈希：确定性、分布均匀，段落之间不重复
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      words.push(VOCAB[Math.abs(h) % VOCAB.length]);
    }
    return `<p>Section ${n} discusses ${words.join(' ')}.</p>`;
  };

  // 300 段 × ~1100 字符 ≈ 330k 字符 ≈ 82k tokens → 约 8 个 chunk
  const paragraphs = Array.from({ length: 300 }, (_, i) => buildParagraph(i)).join('\n');

  const html = `<!doctype html><html><head><title>Concurrency probe</title></head>
<body><article><h1>Concurrency probe</h1>${paragraphs}</article></body></html>`;

  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  localPort = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${localPort}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('translateUrl 并发上限（deepseek provider）', () => {
  it('同时在飞的 chunk 数不超过 provider 设定的并发度', async () => {
    inFlight = 0;
    peak = 0;

    const result = await translateUrl({
      url: `${baseUrl}/`,
      provider: 'deepseek',
      ssrfGuard: localGuard,
    });

    // 前置条件：chunk 数确实大于并发上限，否则这个断言是空转的
    expect(result.chunks).toBeGreaterThan(4);

    // deepseek 的并发上限是 4（见 runTranslationPipeline）
    expect(peak).toBeGreaterThan(1); // 确实并发了，不是串行
    expect(peak).toBeLessThanOrEqual(4); // 且没有突破上限

    // 所有 chunk 都翻完了，并发限制没有导致任务丢失
    expect(result.translatedBlocks).toBeGreaterThan(0);
    expect(result.html).toContain('[zh]');
  }, 30_000);

  it('限流严格的 provider（openrouter）串行为 1', async () => {
    inFlight = 0;
    peak = 0;

    const result = await translateUrl({
      url: `${baseUrl}/`,
      provider: 'openrouter',
      ssrfGuard: localGuard,
    });

    expect(result.chunks).toBeGreaterThan(4);
    expect(peak).toBe(1);
    expect(result.html).toContain('[zh]');
  }, 30_000);
});
