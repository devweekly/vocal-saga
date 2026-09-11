import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 用 node 环境 + happy-dom 全局注入（见 tests/setup.ts）：
    // 本机每次文件 read 约 80ms，vitest 内置的 jsdom 环境要读 ~900 个模块文件，
    // 冷启动 50~66s，超过 worker 启动硬编码的 60s 上限（START_TIMEOUT），
    // 导致每个测试文件都报 "Timeout waiting for worker to respond"。
    // node 环境冷启动 ~0.4s，DOM 全局由 setup.ts 用 happy-dom 注入。
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // CacheManager 测试需要 fake-indexeddb/@netlify/blobs mock，netlify Blobs 在 Node 下
    // 不连真实环境，所以统一用 mock 走通测试
    setupFiles: ['./tests/setup.ts'],
  },
});
