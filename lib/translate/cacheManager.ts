/**
 * Netlify Blobs 适配的 CacheManager。
 *
 * 与 fanyi-extension 的 @wxt-dev/storage 实现的区别：
 *   - WXT 版本：所有 key 存在同一个大对象下（O(N) 序列化）
 *   - Netlify Blobs 版本：每个 key 独立存储（O(1) 读写）
 *   - 公共 API（get / set / remove / clear / getStats）保持一致，
 *     translateApi.ts 等调用方无需改动
 *
 * 缓存层：
 *   - 进程内 Map（首次访问后命中率高时省一次 Blobs roundtrip）
 *   - Netlify Blobs（跨冷启动持久化）
 */

import { getStore } from '@netlify/blobs';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export class CacheManager {
  private memoryCache = new Map<string, CacheEntry<any>>();
  private storeName: string;
  private defaultTTL: number;

  constructor(storeName: string, defaultTTL = 24 * 60 * 60 * 1000) {
    this.storeName = storeName;
    this.defaultTTL = defaultTTL;
  }

  private getStore() {
    return getStore({ name: this.storeName, consistency: 'strong' });
  }

  async get<T>(key: string): Promise<T | null> {
    // 1) 内存层
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry && !this.isExpired(memoryEntry)) {
      return memoryEntry.data as T;
    }
    if (memoryEntry) {
      this.memoryCache.delete(key);
    }

    // 2) 持久层
    try {
      const entry = await this.getStore().get(key, { type: 'json' }) as CacheEntry<T> | null;
      if (entry) {
        if (!this.isExpired(entry)) {
          this.memoryCache.set(key, entry);
          return entry.data;
        }
        // 过期 → 顺手删
        await this.getStore().delete(key).catch(() => {});
      }
    } catch (err) {
      console.warn(`[CacheManager:${this.storeName}] get failed for ${key}:`, (err as Error).message);
    }

    return null;
  }

  async set<T>(key: string, data: T, ttl?: number): Promise<void> {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl: ttl ?? this.defaultTTL,
    };

    this.memoryCache.set(key, entry);

    try {
      await this.getStore().setJSON(key, entry);
    } catch (err) {
      console.warn(`[CacheManager:${this.storeName}] set failed for ${key}:`, (err as Error).message);
    }
  }

  async remove(key: string): Promise<void> {
    this.memoryCache.delete(key);
    try {
      await this.getStore().delete(key);
    } catch (err) {
      console.warn(`[CacheManager:${this.storeName}] remove failed for ${key}:`, (err as Error).message);
    }
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    try {
      const { blobs } = await this.getStore().list();
      await Promise.all(blobs.map(({ key }) => this.getStore().delete(key)));
    } catch (err) {
      console.warn(`[CacheManager:${this.storeName}] clear failed:`, (err as Error).message);
    }
  }

  async getStats(): Promise<{ memorySize: number; storageSize: number }> {
    let storageSize = 0;
    try {
      const { blobs } = await this.getStore().list();
      storageSize = blobs.length;
    } catch {
      // ignore
    }
    return {
      memorySize: this.memoryCache.size,
      storageSize,
    };
  }

  private isExpired(entry: CacheEntry<any>): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }
}

// 30 天默认 TTL（与 fanyi-extension 行为一致）
export const analysisCache = new CacheManager('analysis', 30 * 24 * 60 * 60 * 1000);
export const translationCache = new CacheManager('translations', 30 * 24 * 60 * 60 * 1000);
