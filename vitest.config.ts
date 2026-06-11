import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // CacheManager 测试需要 fake-indexeddb/@netlify/blobs mock，netlify Blobs 在 Node 下
    // 不连真实环境，所以统一用 mock 走通测试
    setupFiles: ['./tests/setup.ts'],
  },
});
