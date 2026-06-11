import { describe, it, expect, beforeEach } from 'vitest';
import { CacheManager } from '../lib/translate/cacheManager';

// @netlify/blobs 在 tests/setup.ts 已 mock
// 通过 import * as blobs 拿到的就是 mock 工厂返回的 getStore 函数引用，
// 借此可以让单测临时注入失败行为。
import * as blobs from '@netlify/blobs';

describe('CacheManager', () => {
  let cache: CacheManager;

  beforeEach(() => {
    // 清空所有 blob store（每个 store name 一个 Map）
    const all = (globalThis as any).__blobStores as Record<string, Map<string, unknown>>;
    if (all) {
      for (const m of Object.values(all)) m.clear();
    }
    cache = new CacheManager('test:cache', 1000);
  });

  // --- set and get ---

  it('stores and retrieves a value', async () => {
    await cache.set('key1', 'value1');
    const result = await cache.get<string>('key1');
    expect(result).toBe('value1');
  });

  it('returns null for missing key', async () => {
    const result = await cache.get<string>('nonexistent');
    expect(result).toBeNull();
  });

  it('stores and retrieves objects', async () => {
    const obj = { name: 'test', count: 42, nested: { deep: true } };
    await cache.set('obj', obj);
    const result = await cache.get<typeof obj>('obj');
    expect(result).toEqual(obj);
  });

  it('uses custom TTL', async () => {
    await cache.set('key1', 'value1', 100);
    await new Promise((r) => setTimeout(r, 150));
    const result = await cache.get<string>('key1');
    expect(result).toBeNull();
  });

  it('uses default TTL when not specified', async () => {
    const cache1 = new CacheManager('test:cache2', 100);
    await cache1.set('key1', 'value1');
    await new Promise((r) => setTimeout(r, 150));
    const result = await cache1.get<string>('key1');
    expect(result).toBeNull();
  });

  // --- remove ---

  it('removes a key', async () => {
    await cache.set('key1', 'value1');
    await cache.set('key2', 'value2');
    await cache.remove('key1');

    expect(await cache.get<string>('key1')).toBeNull();
    expect(await cache.get<string>('key2')).toBe('value2');
  });

  // --- clear ---

  it('clears all entries', async () => {
    await cache.set('key1', 'value1');
    await cache.set('key2', 'value2');
    await cache.clear();

    expect(await cache.get<string>('key1')).toBeNull();
    expect(await cache.get<string>('key2')).toBeNull();
  });

  // --- getStats ---

  it('reports memory and storage stats', async () => {
    await cache.set('key1', 'value1');
    await cache.set('key2', 'value2');

    const stats = await cache.getStats();
    expect(stats.memorySize).toBe(2);
    expect(stats.storageSize).toBe(2);
  });

  it('reports zero stats for empty cache', async () => {
    const stats = await cache.getStats();
    expect(stats.memorySize).toBe(0);
    expect(stats.storageSize).toBe(0);
  });

  // --- expiry ---

  it('removes expired entries from memory', async () => {
    await cache.set('key1', 'value1', 50);
    await new Promise((r) => setTimeout(r, 100));

    const result = await cache.get<string>('key1');
    expect(result).toBeNull();

    const stats = await cache.getStats();
    expect(stats.memorySize).toBe(0);
  });

  // --- memory cache (in-session speed) ---

  it('serves from memory cache on subsequent access', async () => {
    await cache.set('key1', 'value1');
    await cache.get<string>('key1');
    const result = await cache.get<string>('key1');
    expect(result).toBe('value1');
  });

  // --- multiple instances ---

  it('isolates data between different cache instances', async () => {
    const cache1 = new CacheManager('test:cache:a');
    const cache2 = new CacheManager('test:cache:b');

    await cache1.set('key', 'valueA');
    await cache2.set('key', 'valueB');

    expect(await cache1.get<string>('key')).toBe('valueA');
    expect(await cache2.get<string>('key')).toBe('valueB');
  });

  // --- 持久层异常时不挂（仅 log warn） ---

  it('falls back to memory cache when storage get fails', async () => {
    await cache.set('key1', 'value1');

    // 临时把 getStore 替换成抛异常的版本
    const orig = (blobs as any).getStore;
    (blobs as any).getStore = () => ({
      get: async () => { throw new Error('Storage unavailable'); },
      getJSON: async () => { throw new Error('Storage unavailable'); },
      set: async () => {},
      setJSON: async () => { throw new Error('Storage unavailable'); },
      delete: async () => {},
      list: async () => ({ blobs: [] }),
    });

    const result = await cache.get<string>('key1');
    expect(result).toBe('value1');

    (blobs as any).getStore = orig;
  });

  it('still writes to memory cache when storage set fails', async () => {
    const orig = (blobs as any).getStore;
    (blobs as any).getStore = () => ({
      get: async () => null,
      getJSON: async () => null,
      set: async () => {},
      setJSON: async () => { throw new Error('Storage write failed'); },
      delete: async () => {},
      list: async () => ({ blobs: [] }),
    });

    await cache.set('key1', 'value1');
    const result = await cache.get<string>('key1');
    expect(result).toBe('value1');

    (blobs as any).getStore = orig;
  });

  it('handles remove when storage is unavailable', async () => {
    await cache.set('key1', 'value1');

    const orig = (blobs as any).getStore;
    (blobs as any).getStore = () => ({
      get: async () => { throw new Error('Storage unavailable'); },
      getJSON: async () => { throw new Error('Storage unavailable'); },
      set: async () => {},
      setJSON: async () => {},
      delete: async () => { throw new Error('Storage unavailable'); },
      list: async () => ({ blobs: [] }),
    });

    await cache.remove('key1');
    expect(await cache.get<string>('key1')).toBeNull();

    (blobs as any).getStore = orig;
  });
});
