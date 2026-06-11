/**
 * Netlify Functions 入口（shim）。
 *
 * 实际路由在 `lib/dist/app.js`（平台无关的 Express app）。
 * 本文件只负责：注入 Netlify Blobs 作为 default storage，
 * 用 `serverless-http` 把 Express 包成 Netlify 的 handler。
 */
import serverless from 'serverless-http'
import { createApp, NetlifyBlobsStorage } from '../../lib/dist/index.js'

const app = createApp(new NetlifyBlobsStorage('main'))

export const handler = serverless(app)
