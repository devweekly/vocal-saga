import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentPrompt, parseAgentModel, parseJsonObject } from '../src/server.mjs';

test('routes explicit Workbuddy model aliases', () => {
  const result = parseAgentModel('workbuddy:claude-sonnet-example', 'opencode');
  assert.equal(result.provider, 'workbuddy');
  assert.equal(result.model, 'claude-sonnet-example');
});

test('routes explicit OpenCode provider/model aliases', () => {
  const result = parseAgentModel('opencode:openai/gpt-5.4', 'workbuddy');
  assert.equal(result.provider, 'opencode');
  assert.equal(result.model, 'openai/gpt-5.4');
});

test('parses JSON inside a Markdown code fence', () => {
  const fence = String.fromCharCode(96).repeat(3);
  const newline = String.fromCharCode(10);
  assert.deepEqual(parseJsonObject(fence + 'json' + newline + '{"ok":true}' + newline + fence), { ok: true });
});

test('parses a JSON object wrapped in explanation', () => {
  assert.deepEqual(parseJsonObject('result:\n{"ok":true}\nthanks'), { ok: true });
});

test('separates system prompt and preserves JSON-only request', () => {
  const result = buildAgentPrompt([
    { role: 'system', content: 'Translate faithfully.' },
    { role: 'user', content: 'JSON: [{"id":"s0","text":"Hello"}]' },
  ], true);
  assert.equal(result.systemPrompt, 'Translate faithfully.');
  assert.match(result.prompt, /USER:/);
  assert.match(result.prompt, /严格合法的 JSON/);
  assert.match(result.prompt, /JSON:/);
});


/** Reserve an available loopback port for the child-process integration test. */
async function reserveLoopbackPort() {
  const socket = createTcpServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a TCP port');
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('starts without LOCAL_AGENT_TOKEN, allows extension requests, and blocks web-page origins', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vocal-saga-local-agent-test-'));
  const port = await reserveLoopbackPort();
  const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const script = path.join(serviceDir, 'src', 'server.mjs');
  const env = {
    ...process.env,
    LOCAL_AGENT_HOST: '127.0.0.1',
    LOCAL_AGENT_PORT: String(port),
    LOCAL_AGENT_DATA_DIR: tempDir,
    LOCAL_AGENT_DATABASE: path.join(tempDir, 'test.sqlite'),
    LOCAL_AGENT_WORKDIR: path.join(tempDir, 'workspace'),
    LOCAL_AGENT_STORE_CONTENT: 'false',
  };
  delete env.LOCAL_AGENT_TOKEN;

  const child = spawn(process.execPath, [script], {
    cwd: serviceDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2500))]);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) assert.fail('Local service exited during startup: ' + logs);
    try {
      health = await fetch(baseUrl + '/health');
      if (health.ok) break;
    } catch {
      // The child may still be creating its SQLite database and binding the socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(health?.ok, 'service should start without a token; logs: ' + logs);

  const models = await fetch(baseUrl + '/v1/models');
  assert.equal(models.status, 200, 'tokenless local API requests should work');

  const deniedOrigin = await fetch(baseUrl + '/v1/models', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://untrusted.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(deniedOrigin.status, 403, 'ordinary webpage origins must not access the local service');

  const extensionOrigin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const allowedOrigin = await fetch(baseUrl + '/v1/models', {
    method: 'OPTIONS',
    headers: {
      Origin: extensionOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(allowedOrigin.status, 204);
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), extensionOrigin);
});
