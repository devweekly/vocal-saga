# Vocal Saga

OpenAI-compatible LLM proxy + translation API，部署在 **Cloudflare Workers**。

## Quick Start

```bash
# 安装依赖
npm install

# 本地开发
npm run dev:cf

# 测试
npm test

# 部署
npm run deploy:cf
```

## Endpoints

| Path | 说明 |
|------|------|
| `/translate/<url>` | 翻译页面（浏览器直访） |
| `/force/<url>` | 强制重新翻译 |
| `/openrt/<url>` | OpenRouter 免费模型翻译 |
| `/nvd/<url>` | NVIDIA kimi-k2.6 翻译 |
| `/nvd/deepseek/<url>` | NVIDIA deepseek-v4-pro 翻译 |
| `/original/<url>` | 原始页面（不翻译） |
| `/o/<url>` | /original 别名 |
| `/api/v1/chat/completions` | LLM 代理（需 auth） |
| `/api/instapaper/save` | 保存文章到 Instapaper（需 AUTH_KEY） |
| `/api/instapaper/connect` | 发起 Instapaper OAuth（需 AUTH_KEY） |
| `/instapaper` | Instapaper OAuth callback：`https://s.sunxiunan.com/instapaper` |

## Tech Stack

- **Hono** — CF Workers 原生运行
- **linkedom** — 纯 JS DOM 解析
- **DeepSeek / OpenRouter / NVIDIA** — LLM API
- **Cloudflare KV** — 缓存存储
- **Cloudflare D1** — 翻译结果持久化

## Configuration

```bash
# 设置 secrets
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put NVIDIA_API_KEY
wrangler secret put AUTH_KEY
wrangler secret put INSTAPAPER_ACCESS_TOKEN
# 如需 OAuth 连接/切换账号，再设置下面两项：
wrangler secret put INSTAPAPER_CLIENT_ID
wrangler secret put INSTAPAPER_CLIENT_SECRET
```

Instapaper OAuth 应用的 Callback URL 需精确配置为 `https://s.sunxiunan.com/instapaper`。常规保存优先使用 Cloudflare 的 `INSTAPAPER_ACCESS_TOKEN`；完成 OAuth 连接后，授权 token 会写入 `VOCAL_SAGA_KV`。浏览器只会调用 Vocal Saga API，不会获得 Instapaper token。

## Testing

```bash
npm test              # Vitest
npm run build:lib     # 编译 lib/
npm run typecheck     # 类型检查
```
