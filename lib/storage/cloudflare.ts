/**
 * Cloudflare Workers KV 适配。
 *
 * 期望一个 `KVNamespace` binding（Cloudflare Pages Functions 通过 `env` 传入）。
 * 注意：KV 是最终一致；单 key 写后立即读自己写的一致（worker 内部 metadata 是同步的），
 * 但跨 key 列举可能短延迟才能看到新 key。glossary / cache 都是单 key 读写为主，
 * 列举仅用于 clear 场景，可以接受这种语义。
 */
import type { StorageAdapter } from './types';

export class CloudflareKVStorage implements StorageAdapter {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return await this.kv.get(key);
  }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    return await this.kv.get<T>(key, { type: 'json' });
  }

  async set(key: string, value: string): Promise<void> {
    await this.kv.put(key, value);
  }

  async setJSON(key: string, value: unknown): Promise<void> {
    await this.kv.put(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async list(): Promise<string[]> {
    const result = await this.kv.list();
    return result.keys.map((k: { name: string }) => k.name);
  }
}
