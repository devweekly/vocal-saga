import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { LOCAL_TOKEN } from './config.ts';

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
