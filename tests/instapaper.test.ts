import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  save: vi.fn(),
  authorizationUrl: vi.fn(),
  exchangeCode: vi.fn(),
}));

vi.mock('instapaper-api', () => ({
  Instapaper: class {
    bookmarks = { save: sdk.save };
  },
  OAuth: class {
    authorizationUrl = sdk.authorizationUrl;
    exchangeCode = sdk.exchangeCode;
  },
}));

import { createApp } from '../lib/app';

const AUTH_KEY = 'test-vocal-saga-auth-key';
const TOKEN_KEY = 'vocal-saga:instapaper:access-token';

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    AUTH_KEY,
    INSTAPAPER_ACCESS_TOKEN: 'test-instapaper-access-token',
    INSTAPAPER_CLIENT_ID: 'test-client-id',
    INSTAPAPER_CLIENT_SECRET: 'test-client-secret',
    VOCAL_SAGA_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

function authHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: 'Bearer ' + AUTH_KEY,
    'Content-Type': 'application/json',
    ...extra,
  };
}

describe('Instapaper integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.save.mockResolvedValue({
      id: 42,
      url: 'https://example.com/article',
      title: 'Example article',
    });
    sdk.authorizationUrl.mockReturnValue('https://www.instapaper.com/oauth/authorize?state=test');
    sdk.exchangeCode.mockResolvedValue({ access_token: 'oauth-created-access-token' });
  });

  it('requires Vocal Saga authentication before saving a bookmark', async () => {
    const env = makeEnv();
    const app = createApp(env);
    const response = await app.request('/api/instapaper/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/article' }),
    }, env);

    expect(response.status).toBe(401);
    expect(sdk.save).not.toHaveBeenCalled();
  });

  it('validates URLs before calling the SDK', async () => {
    const env = makeEnv();
    const app = createApp(env);
    const response = await app.request('/api/instapaper/save', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ url: 'javascript:alert(1)' }),
    }, env);

    expect(response.status).toBe(400);
    expect(sdk.save).not.toHaveBeenCalled();
  });

  it('saves a bookmark using the official SDK without exposing the token', async () => {
    const env = makeEnv();
    const app = createApp(env);
    const response = await app.request('/api/instapaper/save', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url: 'https://example.com/article',
        title: 'Example article',
      }),
    }, env);

    expect(response.status).toBe(200);
    expect(sdk.save).toHaveBeenCalledWith({
      url: 'https://example.com/article',
      title: 'Example article',
    });
    const body = await response.json() as any;
    expect(body.saved).toBe(true);
    expect(body.bookmark.id).toBe(42);
    expect(JSON.stringify(body)).not.toContain('test-instapaper-access-token');
  });

  it('starts OAuth through the SDK and stores the callback token in KV', async () => {
    const env = makeEnv();
    const app = createApp(env);
    const connectResponse = await app.request('/api/instapaper/connect', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    }, env);

    expect(connectResponse.status).toBe(200);
    expect(sdk.authorizationUrl).toHaveBeenCalledWith({ state: expect.any(String) });
    const connectBody = await connectResponse.json() as any;
    expect(connectBody.authorizationUrl).toContain('instapaper.com');

    const cookie = connectResponse.headers.get('set-cookie') || '';
    const state = cookie.match(/vocal_saga_instapaper_state=([^;]+)/)?.[1];
    expect(state).toBeTruthy();

    const callbackResponse = await app.request('/instapaper?code=oauth-code&state=' + state, {
      method: 'GET',
      headers: { Cookie: 'vocal_saga_instapaper_state=' + state },
    }, env);

    expect(callbackResponse.status).toBe(200);
    expect(sdk.exchangeCode).toHaveBeenCalledWith('oauth-code');
    expect(env.VOCAL_SAGA_KV.put).toHaveBeenCalledWith(TOKEN_KEY, 'oauth-created-access-token');
    expect(await callbackResponse.text()).toContain('Instapaper 已连接');
    expect(callbackResponse.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects OAuth callbacks when state does not match the cookie', async () => {
    const env = makeEnv();
    const app = createApp(env);
    const response = await app.request('/instapaper?code=oauth-code&state=wrong', {
      headers: { Cookie: 'vocal_saga_instapaper_state=expected' },
    }, env);

    expect(response.status).toBe(400);
    expect(sdk.exchangeCode).not.toHaveBeenCalled();
    expect(env.VOCAL_SAGA_KV.put).not.toHaveBeenCalled();
  });
});
