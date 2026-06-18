/**
 * 全局配置：API keys 和 AI bindings。
 *
 * 由 worker.ts 的 injectEnv 设置，服务直接读取模块级变量。
 * 避免参数层层传递。
 */

let _dsApiKey = '';
let _openrouterApiKey = '';
let _nvidiaApiKey = '';
let _authKey = '';
let _mimoClientId = 'fanyi-proxy';

export function setDSApiKey(key: string) { _dsApiKey = key; }
export function getDSApiKey(): string { return _dsApiKey; }

export function setOpenrouterApiKey(key: string) { _openrouterApiKey = key; }
export function getOpenrouterApiKey(): string { return _openrouterApiKey; }

export function setNvidiaApiKey(key: string) { _nvidiaApiKey = key; }
export function getNvidiaApiKey(): string { return _nvidiaApiKey; }

export function setAuthKey(key: string) { _authKey = key; }
export function getAuthKey(): string { return _authKey; }

export function setMimoClientId(id: string) { _mimoClientId = id; }
export function getMimoClientId(): string { return _mimoClientId; }
