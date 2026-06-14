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
```

## Testing

```bash
npm test              # Vitest
npm run build:lib     # 编译 lib/
npm run typecheck     # 类型检查
```
