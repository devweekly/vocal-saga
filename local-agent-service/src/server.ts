/**
 * 本机 Agent 服务入口模块。
 *
 * 运行时配置与业务逻辑已经拆分到 config/db/agents/literary/routes 等模块，
 * 本文件负责组装 Express 应用并重新导出测试/外部调用需要的公共 API。
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';

import {
  DEFAULT_PROVIDER, HOST, PORT, MAX_BODY_BYTES, DATABASE_PATH, STORE_CONTENT,
} from './config.ts';
import { initDatabase } from './db.ts';
import { sendJson, addCors, isLoopbackHost } from './middleware.ts';
import { handleRequest } from './routes.ts';
import { getTextPool } from './agents/workbuddyPool.ts';
import { getDocumentProjectStore } from './documents/projectStore.ts';

// 兼容旧入口与测试：继续从 server.ts 导出这些函数。
export { parseAgentModel, buildAgentPrompt, parseJsonObject, parseJsonValue, normalizeMessages } from './json.ts';
export { validateSegments } from './literary.ts';

const app = express();
app.disable('x-powered-by');

export function startLocalAgentServer() {
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    throw new Error('LOCAL_AGENT_HOST 必须是 loopback 地址（默认 127.0.0.1），本服务不允许监听局域网');
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('LOCAL_AGENT_PORT 不合法');
  initDatabase();
  // Create/repair the catalog and mark interrupted document runs resumable before serving requests.
  getDocumentProjectStore();

  // Run the origin/Host checks before parsing potentially large request bodies.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!addCors(req, res)) {
      sendJson(res, 403, { error: '本机服务不接受普通网页来源；请从浏览器扩展或本机命令行调用' });
      return;
    }
    const hostHeader = String(req.headers.host || '').trim().toLowerCase();
    const hostname = hostHeader.startsWith('[')
      ? hostHeader.slice(1, hostHeader.indexOf(']'))
      : hostHeader.replace(/:\d+$/, '');
    if (!isLoopbackHost(hostname)) {
      sendJson(res, 403, { error: '此服务只允许通过 localhost/127.0.0.1 访问' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: MAX_BODY_BYTES, strict: true }));
  app.use((req: Request, res: Response) => {
    void handleRequest(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  });
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = error?.status === 413 ? 413 : error?.status === 400 ? 400 : 500;
    sendJson(res, status, {
      error: status === 413
        ? '请求体超过 6 MiB 上限'
        : status === 400
          ? '请求体不是有效的 JSON'
          : '本机服务内部错误',
    });
  });

  const server = app.listen(PORT, HOST, () => {
    console.log('[local-agent] listening on http://' + HOST + ':' + PORT);
    console.log('[local-agent] provider default: ' + DEFAULT_PROVIDER);
    console.log('[local-agent] SQLite: ' + DATABASE_PATH);
    console.log('[local-agent] prompt/translation content storage: ' + String(STORE_CONTENT));
    // 后台预热会话池：首波翻译不付 CLI 启动费。只 boot 进程不调模型；
    // 失败自吞，首单懒创建同效。测试用 LOCAL_AGENT_PREWARM=false 关闭。
    if ((process.env.LOCAL_AGENT_PREWARM || 'true').toLowerCase() !== 'false') {
      void getTextPool().prewarm({ provider: 'workbuddy', model: '' }).catch(() => {});
    }
  });
  void server;
  void path;
}
