/**
 * Vocal Saga 共享 lib 入口。
 *
 * 平台入口（Netlify Functions / Cloudflare Pages Function）从这里 import
 * `createApp` 和 storage adapters。
 */
export { createApp } from './app';
export { requireAuth, factory } from './auth';
export {
  NetlifyBlobsStorage,
  CloudflareKVStorage,
  MapStorage,
  setDefaultStorage,
  getDefaultStorage,
  clearDefaultStorage,
} from './storage';
export type { StorageAdapter } from './storage';
