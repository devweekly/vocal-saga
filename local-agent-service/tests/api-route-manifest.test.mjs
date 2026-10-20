import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(here, '..');
const manifest = JSON.parse(await readFile(path.join(serviceDir, 'api-route-manifest.json'), 'utf8'));

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

test('API route manifest matches direct routes and project route predicates', async () => {
  const routesSource = await readFile(path.join(serviceDir, 'src/routes.ts'), 'utf8');
  const projectSource = await readFile(path.join(serviceDir, 'src/documents/projectRoutes.ts'), 'utf8');

  const directRoutes = new Set();
  const supportedBlock = routesSource.match(/const supported = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(supportedBlock, 'supported one-shot endpoints must remain discoverable');
  for (const match of supportedBlock[1].matchAll(/'((?:GET|POST|PUT|PATCH|DELETE|OPTIONS) \/[^']+)'/g)) {
    directRoutes.add(match[1]);
  }

  for (const line of routesSource.split('\n')) {
    let match = line.match(/if \(req\.method === '(GET|POST|PUT|PATCH|DELETE|OPTIONS)' && url\.pathname === '([^']+)'\)/);
    if (match) directRoutes.add(match[1] + ' ' + match[2]);
    match = line.match(/if \(req\.method === '(GET|POST|PUT|PATCH|DELETE|OPTIONS)' && url\.pathname\.startsWith\('([^']+)'\)\)/);
    if (match) directRoutes.add(match[1] + ' ' + match[2] + ':dynamic');
  }

  const projectConditions = [];
  for (const line of projectSource.split('\n')) {
    const match = line.match(/^\s*if \((.*)\) \{$/);
    if (match && match[1].includes('pathParts.length') && match[1].includes('method ===')) {
      projectConditions.push(match[1].replace(/\s+/g, ' ').trim());
    }
  }

  assert.deepEqual(sortedUnique([...directRoutes]), manifest.directRoutes,
    'direct routes changed: update api-route-manifest.json intentionally');
  assert.deepEqual(sortedUnique(projectConditions), manifest.projectRouteConditions,
    'project route predicates changed: update api-route-manifest.json intentionally');
});
