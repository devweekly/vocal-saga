/**
 * Netlify Blobs 适配。
 *
 * 每个实例对应一个 Netlify Blobs store（namespace）。
 * 部署到 Netlify 时由入口 `netlify/functions/api.mjs` 注入。
 */
import { getStore } from '@netlify/blobs';
import type { StorageAdapter } from './types';

export class NetlifyBlobsStorage implements StorageAdapter {
  constructor(private readonly storeName: string) {}

  private getStore() {
    return getStore({ name: this.storeName, consistency: 'strong' });
  }

  async get(key: string): Promise<string | null> {
    try {
      const v = await this.getStore().get(key, { type: 'text' });
      return (v as string | null) ?? null;
    } catch {
      return null;
    }
  }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    try {
      const v = await this.getStore().get(key, { type: 'json' });
      return (v as T | null) ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await this.getStore().set(key, value);
  }

  async setJSON(key: string, value: unknown): Promise<void> {
    await this.getStore().setJSON(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.getStore().delete(key);
  }

  async list(): Promise<string[]> {
    const { blobs } = await this.getStore().list();
    return blobs.map((b: { key: string }) => b.key);
  }
}
