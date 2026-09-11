import { configDefaults, defineConfig } from 'vitest/config';

/**
 * 依赖全局 document / window 的测试文件（其余文件用 node 环境，启动快得多）。
 *
 * 为什么要拆 projects：
 * 本机（macOS + 安全代理）每次文件 read 约 80ms。vitest 内置的 jsdom 环境要读
 * ~900 个模块文件，worker 冷启动 50~66s，超过 vitest 硬编码的 worker 启动上限
 * （START_TIMEOUT = 60s），于是每个测试文件都报
 * "Timeout waiting for worker to respond"，整个套件根本跑不起来。
 * happy-dom 的 dist 是打包好的少量大文件，启动成本低一个量级；
 * 但它也不是零成本，所以只给真正需要 DOM 的这 10 个文件开。
 */
const DOM_TESTS = [
  'tests/blockExtractor.test.ts',
  'tests/contentDetector.test.ts',
  'tests/contentHelper.test.ts',
  'tests/extraction.test.ts',
  'tests/extraction-404media.test.ts',
  'tests/processTranslationHtml.test.ts',
  'tests/readabilityRootMapper.test.ts',
  'tests/redirectGuard.test.ts',
  'tests/shared-walker.test.ts',
  'tests/translationDisplay.test.ts',
];

// CacheManager 测试需要 fake-indexeddb/@netlify/blobs mock，netlify Blobs 在 Node 下
// 不连真实环境，所以统一用 mock 走通测试
const COMMON = {
  globals: true,
  setupFiles: ['./tests/setup.ts'],
};

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          ...COMMON,
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...DOM_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          ...COMMON,
          environment: 'happy-dom',
          include: DOM_TESTS,
        },
      },
    ],
  },
});
