/**
 * 默认存储的注册与读取。
 *
 * 入口在启动时（每个冷启动一次）调用 `setDefaultStorage(adapter)` 注入具体实现。
 * 上层（glossaryStore / cacheManager）只通过 `getDefaultStorage()` 拿到 adapter。
 *
 * 用 globalThis 存储指针，避免 ESM 模块在测试 / HMR 中被多次 evaluate 时
 * 后一次的 import 拿到的是新的空指针。
 */
import type { StorageAdapter } from './types';

const KEY = '__vocalSagaDefaultStorage';

interface GlobalWithStorage {
  [KEY]?: StorageAdapter;
}

export function setDefaultStorage(s: StorageAdapter): void {
  (globalThis as unknown as GlobalWithStorage)[KEY] = s;
}

export function getDefaultStorage(): StorageAdapter {
  const s = (globalThis as unknown as GlobalWithStorage)[KEY];
  if (!s) {
    throw new Error(
      'Default storage not configured. Call setDefaultStorage() at startup ' +
      '(netlify/functions/api.mjs on Netlify, functions/api/[[path]].ts on Cloudflare, ' +
      'or tests/setup.ts in unit tests).'
    );
  }
  return s;
}

/** 单元测试 / 重置时调用，解除默认 storage 绑定 */
export function clearDefaultStorage(): void {
  delete (globalThis as unknown as GlobalWithStorage)[KEY];
}

export { NetlifyBlobsStorage } from './netlify';
export { CloudflareKVStorage } from './cloudflare';
export { MapStorage } from './memory';
export type { StorageAdapter } from './types';
