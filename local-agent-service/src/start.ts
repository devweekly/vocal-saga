/**
 * Service entrypoint.
 *
 * Load .env before dynamically importing server.ts because runtime configuration
 * is read when that module is evaluated. A missing .env is a supported default.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = process.env.LOCAL_AGENT_ENV_FILE?.trim()
  ? path.resolve(process.env.LOCAL_AGENT_ENV_FILE)
  : path.join(serviceDir, '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// 进程级兜底：没有这两个监听时，未捕获异常只会让进程静默退出，
// 终端里看不到任何线索，扩展端只会表现为「连不上本机服务」。
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error('[local-agent] 未处理的 Promise 拒绝：' + message);
});
process.on('uncaughtException', (error) => {
  console.error('[local-agent] 未捕获的异常（继续运行，避免整条翻译链路被动中断）：' + (error?.stack || String(error)));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('[local-agent] 收到 ' + signal + '，进程退出');
    // 注册监听会覆盖 Node 的默认终止行为，必须显式退出；
    // 否则进程会「收到了停止信号但仍然活着」，端口一直被占。
    process.exit(0);
  });
}

const { startLocalAgentServer } = await import('./server.ts');
startLocalAgentServer();
