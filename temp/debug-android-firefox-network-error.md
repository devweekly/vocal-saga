# Debug: Android Firefox server translation NetworkError

## Status
[FIXED]

## Symptom
- Platform: Android Firefox with fanyi-extension
- Feature: Server-side translation (`/fanyi/page`)
- Error: `NetworkError when attempting to fetch resource`

## Root Cause
Firefox manifest 缺少默认翻译服务端 `s.sunxiunan.com` 的 host permission。content script 直接 `fetch` 未声明的跨域域名会被浏览器拦截，报 `NetworkError`。

## Evidence
- `fanyi-extension/wxt.config.ts`: Firefox `manifest.permissions` 原来只有 `['storage', 'https://api.deepseek.com/*']`。
- `fanyi-extension/src/entrypoints/content/serverTranslation.ts`: default `serverUrl` = `https://s.sunxiunan.com/fanyi/page`。
- 服务端 `vocal-saga/lib/app.ts` 已配置 `app.use('*', cors())`。

## Fix
在 `fanyi-extension/wxt.config.ts` 的 Firefox manifest permissions 中新增 `https://s.sunxiunan.com/*`。

## Verification
- `npm test` (fanyi-extension): 26 files, 646 passed.
- 需要用户在 Android Firefox 上重新构建并安装扩展后验证实际网络请求。
