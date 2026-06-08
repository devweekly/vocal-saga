import express from 'express'
import serverless from 'serverless-http'

const app = express()
app.use(express.json())

// GET /api/hello
app.get('/api/hello', (req, res) => {
  const name = req.query.name || 'world'
  res.json({ message: `Hello, ${name}!`, timestamp: new Date().toISOString() })
})

// POST /api/echo
app.post('/api/echo', (req, res) => {
  res.json({ received: req.body })
})

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' })
})

export const handler = serverless(app)
