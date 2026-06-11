/**
 * vitest setup file
 *
 * 1. 注入 MapStorage 作为 default storage，让 cacheManager / glossaryStore
 *    在脱离 Netlify / Cloudflare 真实环境时也能跑通
 * 2. beforeEach 不会自动清空（不同测试可显式 MapStorage.reset() 或 .resetAll()）
 */
import { setDefaultStorage, MapStorage } from '../lib/storage';

// 单测默认 storage：所有 store name 共享一个 _default 的 Map。
// 想要测试间隔离的测试在 beforeEach 里调用 MapStorage.reset() / .resetAll()。
setDefaultStorage(new MapStorage('_default'));
