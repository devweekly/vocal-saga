/**
 * Storage 层单测。
 *
 * 覆盖：
 *   - MapStorage: get/set/getJSON/setJSON/delete/list 的语义 + 跨实例共享 storeName
 *   - 静态方法 reset / resetAll 的隔离效果
 *   - JSON 解析坏数据时 getJSON 返回 null（fail-soft）
 *   - 全局注册表 setDefaultStorage / getDefaultStorage / clearDefaultStorage
 *
 * 故意不测 NetlifyBlobsStorage / CloudflareKVStorage：它们要真实 SDK / binding，
 * 单测里用 mock 反而把单测变成 mock 测试，价值低。集成覆盖留给 e2e。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MapStorage,
  setDefaultStorage,
  getDefaultStorage,
  clearDefaultStorage,
} from '../lib/storage';

describe('MapStorage', () => {
  beforeEach(() => {
    // 每个测试都从干净状态出发
    MapStorage.resetAll();
  });

  it('stores and retrieves a string', async () => {
    const s = new MapStorage('t1');
    await s.set('k', 'v');
    expect(await s.get('k')).toBe('v');
  });

  it('returns null for missing key', async () => {
    const s = new MapStorage('t1');
    expect(await s.get('absent')).toBeNull();
  });

  it('setJSON + getJSON round-trips objects and arrays', async () => {
    const s = new MapStorage('t1');
    const obj = { a: 1, b: ['x', 'y'], nested: { deep: true } };
    await s.setJSON('obj', obj);
    expect(await s.getJSON('obj')).toEqual(obj);
  });

  it('getJSON returns null for missing key', async () => {
    const s = new MapStorage('t1');
    expect(await s.getJSON<{ x: number }>('absent')).toBeNull();
  });

  it('getJSON returns null on corrupt JSON (fail-soft)', async () => {
    const s = new MapStorage('t1');
    await s.set('bad', '{not valid json');
    expect(await s.getJSON('bad')).toBeNull();
  });

  it('delete removes the key', async () => {
    const s = new MapStorage('t1');
    await s.set('k', 'v');
    await s.delete('k');
    expect(await s.get('k')).toBeNull();
  });

  it('list returns all keys in the store', async () => {
    const s = new MapStorage('t1');
    await s.set('a', '1');
    await s.set('b', '2');
    const keys = await s.list();
    expect([...keys].sort()).toEqual(['a', 'b']);
  });

  it('same storeName shares data across instances', async () => {
    const a = new MapStorage('shared');
    const b = new MapStorage('shared');
    await a.set('k', 'from-a');
    expect(await b.get('k')).toBe('from-a');
  });

  it('different storeName isolates data', async () => {
    const a = new MapStorage('storeA');
    const b = new MapStorage('storeB');
    await a.set('k', 'A');
    await b.set('k', 'B');
    expect(await a.get('k')).toBe('A');
    expect(await b.get('k')).toBe('B');
  });

  it('reset(StoreName) clears only that store', async () => {
    const a = new MapStorage('storeA');
    const b = new MapStorage('storeB');
    await a.set('k', '1');
    await b.set('k', '2');
    MapStorage.reset('storeA');
    expect(await a.get('k')).toBeNull();
    expect(await b.get('k')).toBe('2');
  });

  it('resetAll clears every store', async () => {
    const a = new MapStorage('storeA');
    const b = new MapStorage('storeB');
    await a.set('k', '1');
    await b.set('k', '2');
    MapStorage.resetAll();
    expect(await a.get('k')).toBeNull();
    expect(await b.get('k')).toBeNull();
  });
});

describe('default storage registry', () => {
  beforeEach(() => {
    clearDefaultStorage();
  });

  it('getDefaultStorage throws when nothing configured', () => {
    expect(() => getDefaultStorage()).toThrow(/Default storage not configured/);
  });

  it('setDefaultStorage + getDefaultStorage round-trips the same instance', () => {
    const s = new MapStorage('reg');
    setDefaultStorage(s);
    expect(getDefaultStorage()).toBe(s);
  });

  it('clearDefaultStorage removes the binding so next get throws', () => {
    setDefaultStorage(new MapStorage('reg'));
    clearDefaultStorage();
    expect(() => getDefaultStorage()).toThrow(/Default storage not configured/);
  });

  it('re-set after clear replaces the previous adapter', () => {
    const a = new MapStorage('a');
    const b = new MapStorage('b');
    setDefaultStorage(a);
    setDefaultStorage(b);
    expect(getDefaultStorage()).toBe(b);
  });
});
