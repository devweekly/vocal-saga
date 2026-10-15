/**
 * CLI entrypoint: load the same local .env before importing modules that read process.env.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = process.env.LOCAL_AGENT_ENV_FILE?.trim()
  ? path.resolve(process.env.LOCAL_AGENT_ENV_FILE)
  : path.join(serviceDir, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const { runDocumentCli } = await import('./cli.ts');
await runDocumentCli();
