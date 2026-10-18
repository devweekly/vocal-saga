/**
 * 本机服务的终端日志格式。
 *
 * 目标是「出问题能在终端直接定位」：每条日志带作用域与本地时间戳，便于和扩展端、终端
 * 操作时间对齐；错误统一带一行摘要，栈只保留尾部若干行，避免刷屏盖住上下文。
 */

/** 本地时间戳（时:分:秒），与 `[agent …]` 现有格式一致。 */
export function logStamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export function formatLogLine(scope: string, message: string): string {
  return '[' + scope + ' ' + logStamp() + '] ' + message;
}

export function logInfo(scope: string, message: string): void {
  console.info(formatLogLine(scope, message));
}

export function logWarn(scope: string, message: string): void {
  console.warn(formatLogLine(scope, message));
}

export function logError(scope: string, message: string): void {
  console.error(formatLogLine(scope, message));
}

/**
 * 进度/状态行：走 stderr，避免污染 CLI 的 JSON stdout，同时保持统一时间戳格式。
 * 语义上是「正在进行」而非「出错」，所以不占用 logError 的红色级别。
 */
export function logProgress(scope: string, message: string): void {
  console.error(formatLogLine(scope, message));
}

/** 单行错误摘要：去掉换行、限制长度，日志里永远只占一行。 */
export function summarizeError(error: unknown, limit = 300): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** 错误栈尾部：保留最后几帧，足以看出是谁抛的，又不至于淹没日志。 */
export function errorStackTail(error: unknown, frames = 4): string {
  if (!(error instanceof Error) || !error.stack) return '';
  const lines = error.stack.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  return lines.slice(0, frames).join(' ← ');
}

/** 日志里只描述请求路径，丢掉查询串，避免 cursor 之类的滚动参数刷屏。 */
export function requestPath(url: string): string {
  return (url.split('?')[0] || '/').slice(0, 200);
}
