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
export { normalizeUrl, cacheKeyUrl } from './urlUtils';
export {
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  DS_API_KEY,
  NVIDIA_API_KEY,
  OPENROUTER_API_KEY,
  CF_BASE,
  DS_BASE,
  NVIDIA_BASE,
  OPENROUTER_BASE,
  DS_MODELS,
  resolveModel,
} from './modelResolver';
