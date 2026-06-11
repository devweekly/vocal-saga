/**
 * Cloudflare Pages Function 入口。
 *
 * 把平台无关的 Express app 包成 Pages Function。
 * 通过内联 adapter 把 CF 的 `Request` 转成 Node 的 `IncomingMessage`、
 * 把 Express 的 `ServerResponse` 收成 `Response`。
 *
 * 部署：
 *   - wrangler.toml 里要 [[kv_namespaces]] binding = "VOCAL_SAGA_KV"
 *   - npm run build:lib   （构建 lib/dist）
 *   - wrangler pages dev ./public    本地开发
 *   - wrangler pages deploy ./public  部署
 *
 * 注意：CF 的全局 Request/Response 类型与 Node/DOM 的略有差异（带 getAll / cf props），
 * 桥接层使用 `any` 规避类型细节，但调用方仍按标准 Fetch API 使用。
 */

/// <reference types="@cloudflare/workers-types" />

import type { PagesFunction, EventContext } from '@cloudflare/workers-types';
import { setDefaultStorage, CloudflareKVStorage, createApp } from '../../lib/index';

interface Env {
  VOCAL_SAGA_KV: KVNamespace;
  [key: string]: unknown;
}

// ── 单例：app + bridge 复用，避免每次冷启动重建 ──────────────
let _handle: ((req: Request) => Promise<Response>) | null = null;

async function getHandle(env: Env): Promise<(req: Request) => Promise<Response>> {
  if (_handle) return _handle;
  setDefaultStorage(new CloudflareKVStorage(env.VOCAL_SAGA_KV));
  const app = createApp();
  _handle = makeNodeBridge(app);
  return _handle;
}

export const onRequest: PagesFunction<Env> = (context: EventContext<Env, string, unknown>) => {
  return (async () => {
    const handle = await getHandle(context.env);
    return handle(context.request as unknown as Request);
  })() as unknown as ReturnType<PagesFunction<Env>>;
};

// ── Node 桥接（CF Request ⇄ Node IncomingMessage / ServerResponse）──

function makeNodeBridge(app: any): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });

    const nodeReq = makeFakeReq(req, url, headers, req.method);
    const { promise, res: nodeRes } = makeFakeRes();

    await new Promise<void>((resolve, reject) => {
      void resolve;
      try {
        app(nodeReq, nodeRes, (err?: unknown) => {
          if (err) reject(err);
          else if (!nodeRes.finished) {
            nodeRes.statusCode = 404;
            nodeRes.setHeader('Content-Type', 'application/json');
            nodeRes.end('{"error":"Not found"}');
          }
        });
      } catch (err) {
        reject(err);
      }
    });
    return promise;
  };
}

function makeFakeReq(req: Request, url: URL, headers: Record<string, string>, method: string): any {
  // 一个 Node-style Readable 但 body 来自 req.body
  const iter = async function* () {
    if (!req.body) return;
    const reader = req.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };

  return {
    url: url.pathname + url.search,
    method,
    headers,
    body: req.body,
    // Node Readable 兼容方法（Express 内部可能调用）
    readable: true,
    destroyed: false,
    on() { return this; },
    once() { return this; },
    emit() { return true; },
    removeListener() { return this; },
    pause() { return this; },
    resume() { return this; },
    pipe() { return this; },
    unpipe() { return this; },
    setEncoding() { return this; },
    [Symbol.asyncIterator]: iter,
  };
}

interface FakeResBag {
  res: any;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
  promise: Promise<Response>;
}

function makeFakeRes(): FakeResBag {
  let resolveOuter!: (r: Response) => void;
  let rejectOuter!: (e: unknown) => void;
  const promise = new Promise<Response>((res, rej) => { resolveOuter = res; rejectOuter = rej; });

  const headers = new Headers();
  const body: Uint8Array[] = [];
  let finished = false;
  let statusCode = 200;

  const res: any = {
    statusCode,
    statusMessage: 'OK',
    headersSent: false,
    finished,
    _headers: {} as Record<string, string>,
    setHeader(name: string, value: string | number | string[]) {
      this._headers[name.toLowerCase()] = String(value);
      headers.set(name, String(value));
    },
    getHeader(name: string) { return this._headers[name.toLowerCase()]; },
    removeHeader(name: string) {
      delete this._headers[name.toLowerCase()];
      headers.delete(name);
    },
    getHeaders() { return { ...this._headers }; },
    hasHeader(name: string) { return name.toLowerCase() in this._headers; },
    writeHead(status: number, headersOrMessage?: any, maybeHeaders?: any) {
      this.statusCode = status;
      const hs = typeof headersOrMessage === 'string' ? maybeHeaders : headersOrMessage;
      if (hs) for (const [k, v] of Object.entries(hs)) this.setHeader(k, v as string);
      this.headersSent = true;
      return this;
    },
    write(chunk: any) {
      if (chunk == null) return true;
      const buf = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      body.push(buf);
      return true;
    },
    end(chunk?: any) {
      if (chunk != null) this.write(chunk);
      this.finished = true;
      this.headersSent = true;
      const out = concatUint8Arrays(body);
      const response = new Response(out as unknown as BodyInit, {
        status: this.statusCode,
        headers,
      });
      resolveOuter(response);
    },
    flushHeaders() { this.headersSent = true; },
    on() { return this; },
    once() { return this; },
    emit() { return true; },
    removeListener() { return this; },
  };

  return {
    res,
    resolve: resolveOuter,
    reject: rejectOuter,
    promise,
  };
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
