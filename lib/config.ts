/**
 * 全局配置：API keys 和 AI bindings。
 *
 * 注入路径（单一入口）：createApp(env) 启动时从 CF env bindings（生产）或
 * process.env（Node 测试兼容）读取所有 key，调 setter 写入模块级变量。
 * 所有 service / modelResolver / auth 统一通过 getter 读取，不直接访问
 * process.env，避免双路径不一致（原 worker.ts injectEnv + createApp process.env 双写）。
 */

let _dsApiKey = '';
let _openrouterApiKey = '';
let _nvidiaApiKey = '';
let _geminiApiKey1 = '';
let _geminiApiKey2 = '';
let _opencodeApiKey = '';
let _authKey = '';
let _mimoClientId = 'fanyi-proxy';
let _cfAccountId = '';
let _cfApiToken = '';

export function setDSApiKey(key: string) { _dsApiKey = key; }
export function getDSApiKey(): string { return _dsApiKey; }

export function setOpenrouterApiKey(key: string) { _openrouterApiKey = key; }
export function getOpenrouterApiKey(): string { return _openrouterApiKey; }

export function setNvidiaApiKey(key: string) { _nvidiaApiKey = key; }
export function getNvidiaApiKey(): string { return _nvidiaApiKey; }

export function setGeminiApiKey1(key1: string) { _geminiApiKey1 = key1;}
export function setGeminiApiKey2(key2: string) { _geminiApiKey2 = key2; }

export function getGeminiApiKey1(): string { return _geminiApiKey1; }
export function getGeminiApiKey2(): string { return _geminiApiKey2; }

export function setOpencodeApiKey(key: string) { _opencodeApiKey = key; }
export function getOpencodeApiKey(): string { return _opencodeApiKey; }

export function setAuthKey(key: string) { _authKey = key; }
export function getAuthKey(): string { return _authKey; }

export function setMimoClientId(id: string) { _mimoClientId = id; }
export function getMimoClientId(): string { return _mimoClientId; }

// Cloudflare AI 配置（account 级 REST API：api.cloudflare.com/.../accounts/{id}/ai）
export function setCfAccountId(id: string) { _cfAccountId = id; }
export function getCfAccountId(): string { return _cfAccountId; }
export function setCfApiToken(token: string) { _cfApiToken = token; }
export function getCfApiToken(): string { return _cfApiToken; }
