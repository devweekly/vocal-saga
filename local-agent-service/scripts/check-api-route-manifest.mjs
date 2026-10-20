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

const identities = manifest.routes.map((route) => `${route.method} ${route.path}`);
assert.equal(new Set(identities).size, identities.length, 'duplicate method/path entries in API route manifest');

console.log(`API route manifest check passed: ${manifest.routes.length} route entries; source signatures are present.`);
console.log('Note: this checks inventory/source drift only, not full OpenAPI request/response schemas.');
