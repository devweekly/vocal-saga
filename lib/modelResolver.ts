/**
 * 模型解析：根据 model 和 backendHint 确定后端和模型名。
 *
 * 从 lib/app.ts 提取，保持主文件干净。
 */

import { getCfAccountId, getCfApiToken } from './config';

// ── LLM 代理上游配置 ────────────────────────────────────────
// 配置统一从 config getter 读取（由 createApp(env) 注入），不再直接读 process.env，
// 避免 CF Workers 启动期 process.env 未注入导致的空值问题（原依赖 worker.ts
// injectEnv 把 env → process.env 同步，现由 createApp 一次性注入 config 单例）。
export const CF_ACCOUNT_ID = (): string => getCfAccountId();
export const CF_API_TOKEN  = (): string => getCfApiToken();
export const CF_BASE       = (): string => `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID()}/ai`;
export const DS_BASE         = 'https://api.deepseek.com';
export const NVIDIA_BASE     = 'https://integrate.api.nvidia.com';
export const OPENROUTER_BASE = 'https://openrouter.ai/api';

export const DS_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const BACKENDS = new Set(['deepseek', 'cloudflare', 'nvidia', 'openrouter']);

/**
 * 根据 model 和 backendHint 确定后端和模型名。
 *
 * 返回 { backend, model } 或 { error }。
 */
export function resolveModel(model: string | undefined, backendHint: string | undefined) {
  if (backendHint) {
    if (!BACKENDS.has(backendHint)) {
      return { error: `unknown _backend: ${backendHint}` };
    }
    if (backendHint === 'deepseek') {
      return { backend: 'deepseek', model: DS_MODELS.has(model ?? '') ? model! : 'deepseek-v4-flash' };
    }
    return { backend: backendHint, model: model! };
  }
  if (model && model.startsWith('nvidia/')) return { backend: 'nvidia', model };
  if (model && model.includes(':'))        return { backend: 'openrouter', model };
  if (model && model.includes('/'))        return { backend: 'cloudflare', model };
  if (model && DS_MODELS.has(model))       return { backend: 'deepseek', model };
  return { backend: 'deepseek', model: 'deepseek-v4-flash' };
}
