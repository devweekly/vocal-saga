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
});
