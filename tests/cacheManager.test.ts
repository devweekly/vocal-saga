import { describe, it, expect, beforeEach } from 'vitest';
import { CacheManager } from '../lib/translate/cacheManager';
import { MapStorage, type StorageAdapter } from '../lib/storage';

describe('CacheManager', () => {
  let storage: MapStorage;
  let cache: CacheManager;

  beforeEach(() => {
    // 每个测试一个独立的 storage 实例，避免污染
    storage = new MapStorage('test:cache-' + Math.random().toString(36).slice(2));
    cache = new CacheManager('test:cache', 1000, storage);
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
    const cache1 = new CacheManager('test:cache2', 100, storage);
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
    const cache1 = new CacheManager('test:cache:a', undefined, storage);
    const cache2 = new CacheManager('test:cache:b', undefined, storage);

    await cache1.set('key', 'valueA');
    await cache2.set('key', 'valueB');

    expect(await cache1.get<string>('key')).toBe('valueA');
    expect(await cache2.get<string>('key')).toBe('valueB');
  });

  // --- 持久层异常时不挂（仅 log warn） ---

  function failingStorage(): StorageAdapter {
    return {
      get: async () => { throw new Error('Storage unavailable'); },
      getJSON: async () => { throw new Error('Storage unavailable'); },
      set: async () => {},
      setJSON: async () => { throw new Error('Storage unavailable'); },
      delete: async () => { throw new Error('Storage unavailable'); },
      list: async () => [],
    };
  }

  it('falls back to memory cache when storage get fails', async () => {
    const c = new CacheManager('test:failget', 1000, failingStorage());
    await c.set('key1', 'value1');
    const result = await c.get<string>('key1');
    expect(result).toBe('value1');
  });

  it('still writes to memory cache when storage set fails', async () => {
    const c = new CacheManager('test:failset', 1000, failingStorage());
    await c.set('key1', 'value1');
    const result = await c.get<string>('key1');
    expect(result).toBe('value1');
  });

  it('handles remove when storage is unavailable', async () => {
    const c = new CacheManager('test:failremove', 1000, failingStorage());
    await c.set('key1', 'value1');
    await c.remove('key1');
    expect(await c.get<string>('key1')).toBeNull();
  });

  // --- LRU eviction ---

  it('evicts oldest entries when exceeding maxMemoryEntries', async () => {
    const c = new CacheManager('test:lru', 1000, storage, 5);
    // 填满 5 个
    for (let i = 0; i < 5; i++) {
      await c.set(`key${i}`, `value${i}`);
    }
    const stats1 = await c.getStats();
    expect(stats1.memorySize).toBe(5);

    // 第 6 个触发淘汰（删最早 20% = 1 个）
    await c.set('key5', 'value5');
    const stats2 = await c.getStats();
    // 内存大小应 <= 5（淘汰后）
    expect(stats2.memorySize).toBeLessThanOrEqual(5);
    // key0 不应在内存中（但可能在 storage 里）
    // 通过 stats 检查内存大小而非 get（get 会回源 storage）
    expect(stats2.memorySize).toBeLessThanOrEqual(5);
  });

  it('preserves newer entries after eviction', async () => {
    const c = new CacheManager('test:lru2', 1000, storage, 5);
    for (let i = 0; i < 5; i++) {
      await c.set(`key${i}`, `value${i}`);
    }
    await c.set('key5', 'value5');

    // key5（最新）应该保留
    expect(await c.get<string>('key5')).toBe('value5');
    // key4（较新）应该保留
    expect(await c.get<string>('key4')).toBe('value4');
  });

  it('does not evict when under maxMemoryEntries', async () => {
    const c = new CacheManager('test:lru3', 1000, storage, 10);
    for (let i = 0; i < 5; i++) {
      await c.set(`key${i}`, `value${i}`);
    }
    const stats = await c.getStats();
    expect(stats.memorySize).toBe(5);
    // 没有淘汰，所有 key 都还在
    for (let i = 0; i < 5; i++) {
      expect(await c.get<string>(`key${i}`)).toBe(`value${i}`);
    }
  });

  it('uses default maxMemoryEntries when not specified', async () => {
    const c = new CacheManager('test:lru4', 1000, storage);
    // 默认 500，写 10 个不会触发淘汰
    for (let i = 0; i < 10; i++) {
      await c.set(`key${i}`, `value${i}`);
    }
    const stats = await c.getStats();
    expect(stats.memorySize).toBe(10);
  });

  it('eviction removes ~20% of entries', async () => {
    const c = new CacheManager('test:lru5', 1000, storage, 10);
    for (let i = 0; i < 10; i++) {
      await c.set(`key${i}`, `value${i}`);
    }
    // 第 11 个触发淘汰，应该删除 ceil(10 * 0.2) = 2 个
    await c.set('key10', 'value10');
    const stats = await c.getStats();
    expect(stats.memorySize).toBeLessThanOrEqual(9);
  });
});
