import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { LOCAL_TOKEN } from './config.ts';

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Host 头白名单判定。
 *
 * loopback 永远放行（本机/扩展/CLI 的默认路径）。其余主机名必须命中
 * LOCAL_AGENT_ALLOWED_HOSTS：精确匹配，或 `*.example.com` 形式的子域通配。
 * 通配用 `.example.com` 做后缀比较，因此 `evil-example.com` 不会被误放行。
 */
export function isAllowedHost(host: string, allowedHosts: readonly string[]): boolean {
  if (isLoopbackHost(host)) return true;
  return allowedHosts.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern,
  );
}

/**
 * 暴露到公网却没有 token，等于把本机执行入口开放给任何人。
 * 这不是可降级的配置错误，启动阶段直接拒绝，避免"配了域名忘了设 token"。
 */
export function assertExposureIsSafe(allowedHosts: readonly string[], token: string): void {
  if (allowedHosts.length > 0 && !token) {
    throw new Error(
      'LOCAL_AGENT_ALLOWED_HOSTS 已配置（服务可被非本机访问），必须同时设置 LOCAL_AGENT_TOKEN',
    );
  }
}

export function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).set('Cache-Control', 'no-store').json(body);
}

export function addCors(req: Request, res: Response): boolean {
  // A loopback service can still be targeted by a webpage open in the browser.
  // Permit browser extension origins only; allow command-line clients with no Origin header.
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return false; }
    if (!['chrome-extension:', 'moz-extension:', 'safari-web-extension:'].includes(parsed.protocol) || !parsed.hostname) {
      return false;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Source-File-Name');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

export function authorize(req: Request): boolean {
  if (!LOCAL_TOKEN) return true;
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedBytes = Buffer.from(LOCAL_TOKEN);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
