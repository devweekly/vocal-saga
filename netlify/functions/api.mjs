import express from 'express'
import serverless from 'serverless-http'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

// ── 环境变量 ────────────────────────────────────────────
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID
const CF_API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN
const DS_API_KEY    = process.env.DEEPSEEK_API_KEY

const CF_BASE  = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai`
const DS_BASE  = 'https://api.deepseek.com'

// ── 模型白名单 ──────────────────────────────────────────
const DS_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro'])

// ── 后端选择 ────────────────────────────────────────────
// 模型名包含 "/" → Cloudflare AI（如 @cf/meta/llama-3, deepseek/deepseek-v4-pro）
// 模型名在 DS_MODELS 中 → DeepSeek
// 其他 → 默认 deepseek-v4-flash
function resolveModel(model) {
  if (model && model.includes('/')) return { backend: 'cloudflare', model }
  if (model && DS_MODELS.has(model)) return { backend: 'deepseek', model }
  return { backend: 'deepseek', model: 'deepseek-v4-flash' }
}

// ── OpenAI 兼容代理 ────────────────────────────────────
// POST /api/v1/chat/completions
app.post('/api/v1/chat/completions', async (req, res) => {
  const { stream } = req.body || {}
  const resolved = resolveModel(req.body?.model)
  // 覆盖 model，确保上游收到正确模型名
  req.body = { ...req.body, model: resolved.model }
  const backend = resolved.backend

  // ── DeepSeek 特定优化 ──
  if (backend === 'deepseek') {
    // 默认禁用 thinking 模式（客户端可显式设置 thinking 覆盖）
    if (req.body.thinking === undefined) {
      req.body.thinking = { type: 'disabled' }
    }
  }

  let targetUrl, headers

  if (backend === 'cloudflare') {
    if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
      return res.status(500).json({ error: 'Cloudflare AI not configured' })
    }
    targetUrl = `${CF_BASE}/v1/chat/completions`
    headers = {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    }
  } else {
    if (!DS_API_KEY) {
      return res.status(500).json({ error: 'DeepSeek not configured' })
    }
    targetUrl = `${DS_BASE}/v1/chat/completions`
    headers = {
      'Authorization': `Bearer ${DS_API_KEY}`,
      'Content-Type': 'application/json',
    }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    })

    if (!upstream.ok) {
      const errData = await upstream.json()
      return res.status(upstream.status).json(errData)
    }

    // ── 流式响应 ──
    if (stream && upstream.body) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()

      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(decoder.decode(value, { stream: true }))
        }
      } finally {
        reader.releaseLock()
        res.end()
      }
      return
    }

    // ── 非流式响应 ──
    const data = await upstream.json()
    res.json({ ...data, _backend: backend })
  } catch (err) {
    console.error('Proxy error:', err)
    res.status(502).json({ error: 'Upstream request failed', detail: err.message })
  }
})

// GET /api/v1/models
app.get('/api/v1/models', async (_req, res) => {
  const models = []

  // DeepSeek 模型
  if (DS_API_KEY) {
    models.push(
      { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
      { id: 'deepseek-v4-pro',   object: 'model', owned_by: 'deepseek' },
    )
  }

  // Cloudflare AI 模型（可自行扩充）
  if (CF_ACCOUNT_ID && CF_API_TOKEN) {
    models.push(
      { id: '@cf/meta/llama-3.1-8b-instruct',        object: 'model', owned_by: 'cloudflare' },
      { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', object: 'model', owned_by: 'cloudflare' },
      { id: 'deepseek/deepseek-v4-pro',               object: 'model', owned_by: 'cloudflare' },
    )
  }

  res.json({ object: 'list', data: models })
})

// GET /api/hello
app.get('/api/hello', (req, res) => {
  const name = req.query.name || 'world'
  res.json({ message: `Hello, ${name}!`, timestamp: new Date().toISOString() })
})

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

export const handler = serverless(app)
