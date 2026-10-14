/**
 * Service entrypoint.
 *
 * Load .env before dynamically importing server.ts because runtime configuration
 * is read when that module is evaluated. A missing .env is a supported default.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = process.env.LOCAL_AGENT_ENV_FILE?.trim()
  ? path.resolve(process.env.LOCAL_AGENT_ENV_FILE)
  : path.join(serviceDir, '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const { startLocalAgentServer } = await import('./server.ts');
startLocalAgentServer();
