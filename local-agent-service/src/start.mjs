/**
 * Optional environment-file loader for the local service.
 *
 * Unlike --env-file-if-exists, this keeps a missing .env file quiet: all settings
 * have safe defaults and users should be able to start the local service without
 * creating a configuration file first.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(serviceDir, '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

await import('./server.mjs');
