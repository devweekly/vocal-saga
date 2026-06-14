/**
 * 模型解析：根据 model 和 backendHint 确定后端和模型名。
 *
 * 从 lib/app.ts 提取，保持主文件干净。
 */

// ── LLM 代理上游配置 ────────────────────────────────────────
// 必须 lazy 读 process.env：CF Workers 启动期 wrangler 还没把 .dev.vars 注入
// process.env（只在 fetch handler 的 env 参数里给），所以模块顶层 const 会读到空串。
// src/worker.ts 的 injectEnv() 在首个请求时把 env → process.env 同步一次，之后
// 这些 getter 就能拿到真值。和 AUTH_KEY 一样 per-request 拿，不要放回顶层 const。
export const CF_ACCOUNT_ID      = (): string => process.env.CLOUDFLARE_ACCOUNT_ID || '';
export const CF_API_TOKEN       = (): string => process.env.CLOUDFLARE_API_TOKEN || '';
export const DS_API_KEY         = (): string => process.env.DEEPSEEK_API_KEY || '';
export const NVIDIA_API_KEY     = (): string => process.env.NVIDIA_API_KEY || '';
export const OPENROUTER_API_KEY = (): string => process.env.OPENROUTER_API_KEY || '';

// CF_BASE 也得是函数，因为依赖 CF_ACCOUNT_ID()（lazy 读 env）
export const CF_BASE         = (): string => `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID()}/ai`;
export const DS_BASE         = 'https://api.deepseek.com';
export const NVIDIA_BASE     = 'https://integrate.api.nvidia.com';
export const OPENROUTER_BASE = 'https://openrouter.ai/api';

export const DS_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const BACKENDS  = new Set(['deepseek', 'cloudflare', 'nvidia', 'openrouter']);

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
  if (model && model.startsWith('nvidia/')) return { backend: 'nvidia',     model };
  if (model && model.includes(':'))        return { backend: 'openrouter', model };
  if (model && model.includes('/'))        return { backend: 'cloudflare', model };
  if (model && DS_MODELS.has(model))       return { backend: 'deepseek',   model };
  return { backend: 'deepseek', model: 'deepseek-v4-flash' };
}
