/**
 * 本机 Agent 服务的运行时配置。
 *
 * 这些常量在模块求值时从 process.env 读取，因此 start.ts 必须先 loadEnvFile，
 * 再动态导入依赖本模块的 server.ts。
 */
import path from 'node:path';
import { homedir } from 'node:os';

export const HOST = (process.env.LOCAL_AGENT_HOST || '127.0.0.1').trim();
export const PORT = Number.parseInt(process.env.LOCAL_AGENT_PORT || '8789', 10);
export const DATA_DIR = path.resolve(process.env.LOCAL_AGENT_DATA_DIR || path.join(homedir(), '.vocal-saga-local-agent'));
export const DATABASE_PATH = path.resolve(process.env.LOCAL_AGENT_DATABASE || path.join(DATA_DIR, 'local-agent.sqlite'));
export const WORK_DIR = path.resolve(process.env.LOCAL_AGENT_WORKDIR || path.join(DATA_DIR, 'workspace'));

const configuredToken = (process.env.LOCAL_AGENT_TOKEN || '').trim();
// Token is optional for loopback-only use. Treat the example placeholder as unset.
export const LOCAL_TOKEN = configuredToken && !/replace-with-a-long-random-token/i.test(configuredToken)
  ? configuredToken
  : '';

export const DEFAULT_PROVIDER = (process.env.LOCAL_AGENT_PROVIDER || 'workbuddy').toLowerCase();
export const DEFAULT_WORKBUDDY_MODEL = (process.env.LOCAL_WORKBUDDY_MODEL || process.env.WORKBUDDY_MODEL || process.env.CODEBUDDY_DEFAULT_MODEL || '').trim();
export const DEFAULT_OPENCODE_MODEL = (process.env.LOCAL_OPENCODE_MODEL || process.env.OPENCODE_MODEL || '').trim();

/** Parse optional integer settings without allowing malformed .env values to poison runtime timers/SQL. */
export function positiveIntegerEnv(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  if (raw == null || !raw.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn('[local-agent] Ignoring invalid ' + name + '=' + JSON.stringify(raw) + '; using default ' + fallback);
    return fallback;
  }
  return Math.max(minimum, parsed);
}

export const REQUEST_TIMEOUT_MS = positiveIntegerEnv('LOCAL_AGENT_TIMEOUT_MS', 180_000, 10_000);
export const MAX_BODY_BYTES = 6 * 1024 * 1024;
export const MAX_HISTORY_ROWS = positiveIntegerEnv('LOCAL_AGENT_MAX_HISTORY', 500, 50);
export const STORE_CONTENT = (process.env.LOCAL_AGENT_STORE_CONTENT || 'true').toLowerCase() !== 'false';
// Only a failed JSON response is previewed in local terminal logs; set false to suppress text previews.
export const LOG_RESPONSE_PREVIEW = (process.env.LOCAL_AGENT_LOG_RESPONSE_PREVIEW || 'true').toLowerCase() !== 'false';
