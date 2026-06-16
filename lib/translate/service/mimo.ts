/**
 * MiMo 翻译服务：使用 MiMo Auto 免费 API。
 *
 * 两步认证：
 *   1. Bootstrap 获取 JWT（有效期约 1 小时）
 *   2. 使用 JWT 调用 OpenAI 兼容的 Chat API
 *
 * 参考：https://www.appinn.com/mimo-auto-free-api-guide-extract-from-mimo-code/
 */
import type { TranslationService, Glossary } from './_service';
import { parseSSEStream } from './streamParser';
import { getMimoClientId } from '../../config';
import { buildTranslationBody, stripMarkdownCodeBlock, cleanJsonString } from './shared';

const BOOTSTRAP_URL = 'https://api.xiaomimimo.com/api/free-ai/bootstrap';
const CHAT_URL = 'https://api.xiaomimimo.com/api/free-ai/openai/chat';
const MODEL = 'mimo-auto';
const SOURCE_HEADER = 'mimocode-cli-free';

// JWT 缓存（module-level，Worker 实例存活期间复用）
let _cachedJwt: string | null = null;
let _cachedExp = 0;

// 预留 5 分钟缓冲期，避免在临界时刻使用即将过期的 token
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface BootstrapResponse {
  jwt: string;
  exp: number; // unix timestamp in ms
}

async function bootstrap(): Promise<BootstrapResponse> {
  const clientId = getMimoClientId();
  console.log('[MiMo] Bootstrapping JWT with client:', clientId);

  const response = await fetch(BOOTSTRAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: clientId }),
  });

  const responseText = await response.text().catch(() => '');

  if (!response.ok) {
    throw new Error(`MiMo bootstrap error: HTTP ${response.status} - ${responseText.substring(0, 200)}`);
  }

  const data = JSON.parse(responseText) as BootstrapResponse;
  if (!data.jwt || !data.exp) {
    throw new Error(`MiMo bootstrap error: invalid response - ${responseText.substring(0, 200)}`);
  }

  console.log('[MiMo] JWT acquired, expires at:', new Date(data.exp).toISOString());
  return data;
}

async function getJwt(): Promise<string> {
  const now = Date.now();
  if (_cachedJwt && _cachedExp > now + EXPIRY_BUFFER_MS) {
    return _cachedJwt;
  }

  const data = await bootstrap();
  _cachedJwt = data.jwt;
  _cachedExp = data.exp;
  return _cachedJwt;
}

function buildHeaders(jwt: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt}`,
    'X-Mimo-Source': SOURCE_HEADER,
  };
}

async function callApi(body: string): Promise<string> {
  const jwt = await getJwt();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // MiMo 免费 API 可能较慢，给 120s

  let response: Response;
  try {
    response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: buildHeaders(jwt),
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('MiMo API timeout (120s)');
    }
    throw err;
  }
  clearTimeout(timeout);

  console.log('[MiMo] Response status:', response.status);

  const responseText = await response.text().catch(() => '');

  if (!response.ok) {
    // 401 可能表示 JWT 已过期，清除缓存让下次重新 bootstrap
    if (response.status === 401) {
      _cachedJwt = null;
      _cachedExp = 0;
    }
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorJson = JSON.parse(responseText);
      if (errorJson.error) {
        errorMessage += ` - ${errorJson.error.message || errorJson.error}`;
      } else if (errorJson.message) {
        errorMessage += ` - ${errorJson.message}`;
      } else {
        errorMessage += ` - ${responseText.substring(0, 200)}`;
      }
    } catch {
      errorMessage += ` - ${responseText.substring(0, 200)}`;
    }
    throw new Error(`MiMo API error: ${errorMessage}`);
  }

  const data = JSON.parse(responseText);
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('MiMo returned invalid response: missing choices[0].message.content');
  }

  let cleaned = stripMarkdownCodeBlock(content);
  try {
    JSON.parse(cleaned);
  } catch {
    cleaned = cleanJsonString(cleaned);
  }
  return cleaned;
}

export class MimoTranslationService implements TranslationService {
  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);
    const body = buildTranslationBody(blocks, sourceLang, targetLang, glossary, MODEL);
    const raw = await callApi(JSON.stringify(body));
    return raw;
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): AsyncGenerator<string, string, unknown> {
    const blocks = JSON.parse(jsonContent);
    const body = buildTranslationBody(blocks, sourceLang, targetLang, glossary, MODEL);
    (body as any).stream = true;

    const jwt = await getJwt();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    let response: Response;
    try {
      response = await fetch(CHAT_URL, {
        method: 'POST',
        headers: buildHeaders(jwt),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('MiMo stream timeout (120s)');
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      if (response.status === 401) {
        _cachedJwt = null;
        _cachedExp = 0;
      }
      const text = await response.text().catch(() => '');
      throw new Error(`MiMo API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
    }

    if (!response.body) {
      throw new Error('MiMo API error: response body is null');
    }

    const reader = response.body.getReader();
    let fullContent = '';

    for await (const delta of parseSSEStream(reader)) {
      fullContent += delta;
      yield fullContent;
    }

    return fullContent;
  }
}
