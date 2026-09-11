/**
 * vitest setup file
 *
 * 1. 注入 MapStorage 作为 default storage，让 cacheManager / glossaryStore
 *    在脱离 Netlify / Cloudflare 真实环境时也能跑通
 * 2. 注入浏览器 DOM 全局（document / window / ...），供依赖 DOM 的测试直接使用
 *
 * 关于 DOM 全局为什么手写、而不用 vitest 的 `environment: 'jsdom'`：
 * 本机（macOS + 安全代理）每次文件 read 约 80ms。jsdom 的模块图有 ~900 个文件，
 * 在 worker 里冷启动要 50~66s，超过 vitest 硬编码的 worker 启动上限
 * （START_TIMEOUT = 60s），于是每个测试文件都报
 * "Timeout waiting for worker to respond"，整个套件根本跑不起来。
 * 这里改为 `environment: 'node'` + happy-dom（dist 是打包好的少量大文件，
 * 冷启动 ~1.6s），手动把 DOM 全局挂到 globalThis —— worker 启动从 60s+ 降到 1s 级。
 *
 * beforeEach 不会自动清空 storage（不同测试可显式 MapStorage.reset() / .resetAll()）。
 */
import { setDefaultStorage, MapStorage } from '../lib/storage';
import { Window } from 'happy-dom';

// 单测默认 storage：所有 store name 共享一个 _default 的 Map。
// 想要测试间隔离的测试在 beforeEach 里调用 MapStorage.reset() / .resetAll()。
setDefaultStorage(new MapStorage('_default'));

// ── DOM 全局注入 ────────────────────────────────────────────
const win = new Window({ url: 'http://localhost:3000/' });

// Node 自带的全局不要被 happy-dom 覆盖（覆盖 fetch / URL / AbortController 等
// 会改变被测代码在 Node 下的行为）。
const NODE_GLOBALS = new Set([
  'global', 'globalThis', 'process', 'Buffer', 'require', 'module', 'exports',
  '__dirname', '__filename', 'console', 'queueMicrotask', 'structuredClone',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'setImmediate', 'clearImmediate', 'fetch', 'crypto', 'performance',
  'atob', 'btoa', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'AbortSignal', 'Blob', 'FormData', 'Headers',
  'Request', 'Response', 'WebSocket', 'EventSource', 'MessageChannel',
  'MessagePort', 'MessageEvent', 'Worker', 'SharedWorker',
]);

// 这些必须来自 happy-dom，即使 Node 已有同名全局。
const FORCE_OVERRIDE = new Set([
  'window', 'document', 'navigator', 'location', 'history', 'localStorage',
  'sessionStorage', 'getComputedStyle', 'DOMParser', 'XMLSerializer',
  'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia',
]);

const g = globalThis as unknown as Record<string, unknown>;
for (const key of Object.getOwnPropertyNames(win)) {
  if (NODE_GLOBALS.has(key)) continue;
  if (!FORCE_OVERRIDE.has(key) && key in g) continue;
  try {
    g[key] = (win as unknown as Record<string, unknown>)[key];
  } catch {
    // 某些全局是只读 getter，跳过即可
  }
}
