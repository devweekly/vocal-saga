/**
 * 诊断本地 /force/<target> 端点完整响应。
 *
 * 直接调用 createApp() + app.request()，复现 vocal-saga 从路由解析、抓取、
 * 翻译到返回 HTML 的完整流程。会消耗 LLM API token（如果配置了 KEY）。
 */
import { createApp } from '../lib/app';

const target = process.argv[2] || 'llm-as-a-verifier.com';
const path = `/force/${encodeURIComponent(target)}`;

async function main() {
  const app = createApp();

  // 模拟两次请求：检查是否触发 rate limit
  for (let i = 0; i < 2; i++) {
    console.log(`\n[Diagnose] Request ${i + 1}: GET ${path}`);
    const res = await app.request(new Request(`http://test${path}`));
    console.log(`[Diagnose] status=${res.status}`);

    for (const [k, v] of res.headers.entries()) {
      if (k.toLowerCase().startsWith('x-translate') || k.toLowerCase() === 'content-type') {
        console.log(`[Diagnose] header ${k}=${v}`);
      }
    }

    const body = await res.text();
    if (res.status >= 400) {
      console.log(`[Diagnose] body: ${body.slice(0, 500)}`);
    } else {
      console.log(`[Diagnose] html length=${body.length}`);
      console.log(`[Diagnose] snippet: ${body.slice(0, 200).replace(/\n/g, ' ')}...`);
    }
  }
}

main().catch((err) => {
  console.error('[Diagnose] Failed:', err);
  process.exit(1);
});
