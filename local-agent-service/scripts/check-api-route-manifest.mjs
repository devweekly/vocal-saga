import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = resolve(here, '..');
const manifest = JSON.parse(await readFile(resolve(serviceRoot, 'api-route-manifest.json'), 'utf8'));

assert.equal(manifest.version, 1, 'update this checker when the manifest format changes');
assert.ok(Array.isArray(manifest.routes) && manifest.routes.length > 0, 'route manifest must not be empty');

const sourceCache = new Map();
for (const route of manifest.routes) {
  assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method), `invalid method: ${route.method}`);
  assert.ok(route.path.startsWith('/'), `route path must be absolute: ${route.path}`);
  assert.ok(route.signature && route.source, `route must identify its implementation: ${route.method} ${route.path}`);

  let source = sourceCache.get(route.source);
  if (!source) {
    source = await readFile(resolve(serviceRoot, route.source), 'utf8');
    sourceCache.set(route.source, source);
  }
  assert.ok(
    source.includes(route.signature),
    `API route manifest drift: no longer found in ${route.source}: ${route.method} ${route.path} (signature: ${route.signature})`,
  );
}


const manifestBySource = new Map();
for (const route of manifest.routes) {
  const entries = manifestBySource.get(route.source) || [];
  entries.push(route);
  manifestBySource.set(route.source, entries);
}

// Reverse coverage: discover route-dispatch conditions in the implementation and
// require each one to be represented in the manifest. The existing forward check
// above catches stale signatures; this catches newly added handlers that forgot
// to update the manifest. This is intentionally a lightweight source check, not an AST.
const commonSource = sourceCache.get('src/routes.ts');
const commonRoutes = manifestBySource.get('src/routes.ts') || [];
const commonConditions = commonSource.matchAll(/if\s*\(([\\s\\S]*?)\\)\\s*\\{/g);
for (const match of commonConditions) {
  const condition = match[1];
  if (!condition.includes('req.method') || !condition.includes('url.pathname')) continue;
  const method = condition.match(/req\\.method\\s*===\\s*'([A-Z]+)'/)?.[1];
  assert.ok(method, `could not determine HTTP method from route condition: ${condition}`);
  assert.ok(
    commonRoutes.some((route) => route.method === method && condition.includes(route.signature)),
    `API route manifest is missing a handler in src/routes.ts: ${method} (${condition.trim()})`,
  );
}

// The three one-shot literary/OpenAI endpoints are dispatched through the
// supported-method set rather than an outer req.method/pathname condition.
const supportedBlock = commonSource.match(/const supported = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(supportedBlock, 'could not locate supported endpoint set in src/routes.ts');
for (const match of supportedBlock[1].matchAll(/'([A-Z]+) (\/[^']+)'/g)) {
  const [, method, path] = match;
  assert.ok(
    commonRoutes.some((route) => route.method === method && route.path === path),
    `API route manifest is missing supported endpoint: ${method} ${path}`,
  );
}

const projectSource = sourceCache.get('src/documents/projectRoutes.ts');
const projectRoutes = manifestBySource.get('src/documents/projectRoutes.ts') || [];
const projectConditions = projectSource.matchAll(/if\s*\(([^)]*pathParts[^)]*)\)/g);
for (const match of projectConditions) {
  const condition = match[1];
  const method = condition.match(/method\s*===\s*'([A-Z]+)'/)?.[1];
  if (!method) continue; // Path guards are not endpoint handlers.
  assert.ok(
    projectRoutes.some((route) => route.method === method && condition.includes(route.signature)),
    `API route manifest is missing a handler in src/documents/projectRoutes.ts: ${method} (${condition.trim()})`,
  );
}

const identities = manifest.routes.map((route) => `${route.method} ${route.path}`);
assert.equal(new Set(identities).size, identities.length, 'duplicate method/path entries in API route manifest');

console.log(`API route manifest check passed: ${manifest.routes.length} route entries; source signatures are present.`);
console.log('Note: this checks inventory/source drift only, not full OpenAPI request/response schemas.');
