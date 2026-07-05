/**
 * 全局配置：API keys 和 AI bindings。
 *
 * 由 worker.ts 的 injectEnv 设置，服务直接读取模块级变量。
 * 避免参数层层传递。
 */

let _dsApiKey = '';
let _openrouterApiKey = '';
let _nvidiaApiKey = '';
let _geminiApiKey1 = '';
let _geminiApiKey2 = '';
let _opencodeApiKey = '';
let _authKey = '';
let _mimoClientId = 'fanyi-proxy';

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
