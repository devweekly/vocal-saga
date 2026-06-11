/**
 * Netlify Functions 入口（shim）。
 *
 * Hono 应用在 lib/dist/app.js；本文件注入 Netlify Blobs 作为 default storage，
 * 用 `hono/aws-lambda` 的 `handle()` 把 Hono 包成 Netlify 的 Lambda handler。
 */
import { handle } from 'hono/aws-lambda'
import { createApp, NetlifyBlobsStorage } from '../../lib/dist/index.js'

const app = createApp(new NetlifyBlobsStorage('main'))

export const handler = handle(app)
