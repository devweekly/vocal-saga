/**
 * 公网暴露（Cloudflare Tunnel）相关行为的回归测试。
 *
 * 覆盖三件事：
 *   1. Host 白名单的匹配规则（精确 / 子域通配 / 不被后缀相似域名绕过）
 *   2. 「配了域名但没设 token」必须在启动阶段直接失败，而不是静默开放
 *   3. 真实服务上的端到端行为：隧道域名 + token 可用，缺 token 401，非白名单域名 403
 *
 * 第 3 组必须起真实进程：Host 头校验发生在中间件里，纯函数测试打不到中间件顺序
 * （CORS 先于 Host 检查）和 authorize() 的短路逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAllowedHost, assertExposureIsSafe } from '../src/middleware.ts';

const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Host 白名单：loopback 永远放行', () => {
  assert.equal(isAllowedHost('127.0.0.1', []), true);
  assert.equal(isAllowedHost('localhost', []), true);
  assert.equal(isAllowedHost('::1', []), true);
  assert.equal(isAllowedHost('127.0.0.1', ['local.example.com']), true);
});

test('Host 白名单：空名单只允许 loopback（默认行为不变）', () => {
  assert.equal(isAllowedHost('local.example.com', []), false);
  assert.equal(isAllowedHost('evil.example.com', []), false);
});

test('Host 白名单：精确匹配与子域通配', () => {
  const allowed = ['local.example.com', '*.trycloudflare.com'];
  assert.equal(isAllowedHost('local.example.com', allowed), true);
  assert.equal(isAllowedHost('abc-def.trycloudflare.com', allowed), true);
  assert.equal(isAllowedHost('local.example.com.evil.net', allowed), false);
  // 通配实现用 '.trycloudflare.com' 做后缀比较，裸域本身不匹配
  assert.equal(isAllowedHost('trycloudflare.com', allowed), false);
});

test('Host 白名单：后缀相似的域名不能被误放行', () => {
  const allowed = ['*.example.com'];
  // 关键：必须带前导点，否则 evil-example.com 会因字符串后缀命中
  assert.equal(isAllowedHost('evil-example.com', allowed), false);
  assert.equal(isAllowedHost('notexample.com', allowed), false);
  assert.equal(isAllowedHost('a.example.com', allowed), true);
});

test('配置了对外开放主机却没设 token 时，启动校验必须抛错', () => {
  assert.throws(
    () => assertExposureIsSafe(['local.example.com'], ''),
    /必须同时设置 LOCAL_AGENT_TOKEN/,
  );
});

test('只监听 loopback（无白名单）时允许不设 token', () => {
  assert.doesNotThrow(() => assertExposureIsSafe([], ''));
});

test('配置了白名单且设了 token 时通过', () => {
  assert.doesNotThrow(() => assertExposureIsSafe(['local.example.com'], 'secret-token'));
});

/** 找一个空闲端口，避免与其他测试或本机服务抢占。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 用 node:http 发请求：fetch 禁止覆盖 Host 头，而这里测的正是 Host。 */
function call(port, { host, route = '/api/documents/projects', token }) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'GET',
        headers: {
          ...(host ? { Host: host } : {}),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitReady(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await call(port, {});
      if (res.status > 0) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 起一个真实服务进程。detached + 整组 kill：tsx 是 wrapper，真正的 server 是它
 * fork 的子进程，只 kill wrapper 会留下占端口的孤儿。
 */
async function startService(extraEnv) {
  const port = await freePort();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vocal-exposure-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/start.ts'], {
    cwd: SERVICE_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LOCAL_AGENT_PORT: String(port),
      LOCAL_AGENT_DATA_DIR: dataDir,
      LOCAL_AGENT_PREWARM: 'false',
      LOCAL_AGENT_STORE_CONTENT: 'false',
      // 必须隔离真实 .env，否则测试会读到本机 token
      LOCAL_AGENT_ENV_FILE: path.join(dataDir, 'missing.env'),
      ...extraEnv,
    },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  return {
    port,
    child,
    getLog: () => log,
    async stop() {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* ignore */ }
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test('隧道域名 + 正确 token 可访问，缺 token 401，非白名单域名 403，loopback 免 token', async () => {
  const svc = await startService({
    LOCAL_AGENT_ALLOWED_HOSTS: 'local.example.com',
    LOCAL_AGENT_TOKEN: 'test-token-123',
  });
  try {
    assert.ok(await waitReady(svc.port), '服务未能启动：\n' + svc.getLog().slice(-2000));

    const viaTunnel = await call(svc.port, { host: 'local.example.com', token: 'test-token-123' });
    assert.equal(viaTunnel.status, 200, '白名单域名 + token 应通过：' + viaTunnel.body.slice(0, 200));

    const noToken = await call(svc.port, { host: 'local.example.com' });
    assert.equal(noToken.status, 401, '公网访问缺 token 必须 401：' + noToken.body.slice(0, 200));

    const wrongHost = await call(svc.port, { host: 'evil.example.net', token: 'test-token-123' });
    assert.equal(wrongHost.status, 403, '非白名单域名必须 403：' + wrongHost.body.slice(0, 200));

    // 本机 loopback 不要求 token：扩展/CLI 默认配置即可用，不需要额外填写。
    const loopbackNoToken = await call(svc.port, {});
    assert.equal(
      loopbackNoToken.status,
      200,
      'loopback 无 token 必须可用（token 只约束非本机访问）：' + loopbackNoToken.body.slice(0, 200),
    );

    // 服务端设了 token 也不影响 loopback —— 否则扩展不填 token 就用不了。
    const loopbackWrongToken = await call(svc.port, { token: 'wrong-token' });
    assert.equal(loopbackWrongToken.status, 200, 'loopback 不校验 token：' + loopbackWrongToken.body.slice(0, 200));
  } finally {
    await svc.stop();
  }
});

test('配置了白名单却没设 token 时，服务必须拒绝启动', async () => {
  const svc = await startService({ LOCAL_AGENT_ALLOWED_HOSTS: 'local.example.com' });
  try {
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 30_000);
      svc.child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    assert.ok(exited, '服务不应在缺少 token 时继续运行');
    assert.match(svc.getLog(), /必须同时设置 LOCAL_AGENT_TOKEN/);
  } finally {
    await svc.stop();
  }
});
