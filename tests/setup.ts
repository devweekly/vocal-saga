/**
 * vitest setup file
 *
 * 1. mock @netlify/blobs（不在 Netlify 部署环境下也能跑通 cacheManager 测试）
 *    stores 挂到 globalThis 上，便于测试间清空
 */
import { vi } from 'vitest';

// 1) @netlify/blobs mock
//    stores 挂在 globalThis.__blobStores 上，单测 beforeEach 可显式 .clear()
const globalAny = globalThis as any;
if (!globalAny.__blobStores) {
  globalAny.__blobStores = {} as Record<string, Map<string, { value: unknown }>>;
}

vi.mock('@netlify/blobs', () => {
  function getStore({ name }: { name: string; consistency?: string }) {
    const all = (globalThis as any).__blobStores as Record<string, Map<string, { value: unknown }>>;
    if (!all[name]) all[name] = new Map();
    const map = all[name];
    return {
      get: async (key: string, opts?: { type?: string }) => {
        const entry = map.get(key);
        if (!entry) return null;
        if (opts?.type === 'json') return entry.value;
        return entry.value as any;
      },
      getJSON: async (key: string) => {
        const entry = map.get(key);
        return entry ? (entry.value as any) : null;
      },
      set: async (key: string, value: unknown) => {
        map.set(key, { value });
      },
      setJSON: async (key: string, value: unknown) => {
        map.set(key, { value });
      },
      delete: async (key: string) => {
        map.delete(key);
      },
      list: async () => ({
        blobs: Array.from(map.keys()).map((key) => ({ key })),
      }),
    };
  }
  return { getStore };
});
