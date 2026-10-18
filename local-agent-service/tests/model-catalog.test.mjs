/**
 * CodeBuddy 模型目录与「免费模型」选择规则。
 *
 * 回归背景：workbuddy provider 未显式配置模型时，过去一律交给 CLI 默认模型，
 * 而默认模型可能是计费的。现在先从 CLI 的产品配置里读模型目录，
 * 只在「目录里存在 credits 明确为 0 的模型」时才自动切换。
 *
 * 2026-10-18 账号目录刷新后 gpt-* 全部下线、deepseek-v4.1-flash 变成 0.11 credits，
 * 早期用「目录里必须有 gpt-*」反推完整性的判据把正常目录判成残缺，一个模型都选不出来，
 * 因此改为只依据 credits 本身判断免费与否。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

import {
  parseCredits,
  pickPreferredWorkbuddyModel,
  readModelCatalog,
  resolveWorkbuddyModel,
  PREFERRED_WORKBUDDY_MODEL,
} from '../src/agents/modelCatalog.ts';

test('parseCredits 覆盖三种真实形态', () => {
  // 免费
  assert.equal(parseCredits('x0.00'), 0);
  // 带单位
  assert.equal(parseCredits('x0.34 credits'), 0.34);
  assert.equal(parseCredits('x3.31 credits'), 3.31);
  // 未填（default-model 的 credits 是空串）
  assert.equal(parseCredits(''), null);
  assert.equal(parseCredits(undefined), null);
  assert.equal(parseCredits(null), null);
  // 未知格式不能被当成 0
  assert.equal(parseCredits('free'), null);
  // 省略 x 前缀也接受
  assert.equal(parseCredits('1.5'), 1.5);
});

test('目录里有免费的目标模型时选中 deepseek-v4.1-flash', () => {
  const catalog = [
    { id: 'gpt-6-astra', credits: 6.67 },
    { id: 'gpt-5.4', credits: 1.65 },
    { id: PREFERRED_WORKBUDDY_MODEL, credits: 0 },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), PREFERRED_WORKBUDDY_MODEL);
});

test('没有 gpt-* 也照常选：厂商下线不该让完整目录被判成残缺', () => {
  // 2026-10-18 的真实目录：33 个模型，gpt-* 一个都没有
  const catalog = [
    { id: 'default', credits: 2 },
    { id: PREFERRED_WORKBUDDY_MODEL, credits: 0 },
    { id: 'hy3', credits: 0 },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), PREFERRED_WORKBUDDY_MODEL);
});

test('目标模型不再免费时退到 hy3', () => {
  const catalog = [
    { id: PREFERRED_WORKBUDDY_MODEL, credits: 0.11 },
    { id: 'hy3', credits: 0 },
    { id: 'step-5-preview', credits: 0 },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), 'hy3');
});

test('偏好表都没命中时取目录里第一个免费模型', () => {
  const catalog = [
    { id: 'glm-5.3', credits: 0.79 },
    { id: 'some-new-model', credits: 0 },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), 'some-new-model');
});

test('一个 credits=0 的模型都没有时返回 null', () => {
  const catalog = [
    { id: 'gpt-5.4', credits: 1.65 },
    { id: PREFERRED_WORKBUDDY_MODEL, credits: 0.11 },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), null);
});

test('费率非 0 的目标模型不会被选中', () => {
  const catalog = [
    { id: 'gpt-5.4', credits: 1.65 },
    { id: PREFERRED_WORKBUDDY_MODEL, credits: 0.03 },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), null);
});

test('费率未标注（null）不能被当成免费', () => {
  const catalog = [
    { id: 'gpt-5.4', credits: 1.65 },
    { id: PREFERRED_WORKBUDDY_MODEL, credits: null },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), null);
});

test('空目录不猜模型', () => {
  assert.equal(pickPreferredWorkbuddyModel([]), null);
});

/**
 * 回归背景：`LOCAL_WORKBUDDY_MODEL=auto`（扩展默认发送的取值）曾被当成真实模型 id，
 * 下游 parseAgentModel 再把它归一成空串，CLI 因此拿不到 --model，
 * 静默回退到账号默认模型 hy4-preview —— 计费，且不保证支持 json-schema。
 */
test('显式配置写成 auto 时按「没配置」处理，走目录挑选', () => {
  const catalog = [
    { id: 'gpt-5.4', credits: 1.65 },
    { id: PREFERRED_WORKBUDDY_MODEL, credits: 0 },
  ];
  assert.equal(resolveWorkbuddyModel('auto', catalog), PREFERRED_WORKBUDDY_MODEL);
  assert.equal(resolveWorkbuddyModel('  AUTO  ', catalog), PREFERRED_WORKBUDDY_MODEL);
  assert.equal(resolveWorkbuddyModel('', catalog), PREFERRED_WORKBUDDY_MODEL);
  assert.equal(resolveWorkbuddyModel(undefined, catalog), PREFERRED_WORKBUDDY_MODEL);
});

test('显式配置了真实模型时不覆盖', () => {
  const catalog = [
    { id: 'gpt-5.4', credits: 1.65 },
    { id: PREFERRED_WORKBUDDY_MODEL, credits: 0 },
  ];
  assert.equal(resolveWorkbuddyModel('gpt-5.4', catalog), 'gpt-5.4');
});

test('auto 且目录不可用时留空，交给 CLI 默认模型', () => {
  assert.equal(resolveWorkbuddyModel('auto', []), '');
  // 目录读到了，但没有任何确认免费的模型：同样不猜
  assert.equal(resolveWorkbuddyModel('auto', [{ id: PREFERRED_WORKBUDDY_MODEL, credits: 0.11 }]), '');
});

test('readModelCatalog 优先读 ACC_PRODUCT_CONFIG_PATH', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-catalog-'));
  const file = path.join(dir, 'acc-product-config-v3.json');
  await writeFile(file, JSON.stringify({
    models: [
      { id: 'gpt-5.4', credits: 'x1.65' },
      { id: PREFERRED_WORKBUDDY_MODEL, credits: 'x0.00' },
    ],
  }));
  const previous = process.env.ACC_PRODUCT_CONFIG_PATH;
  process.env.ACC_PRODUCT_CONFIG_PATH = file;
  try {
    const catalog = readModelCatalog();
    assert.equal(catalog.length, 2);
    assert.equal(catalog.find((m) => m.id === PREFERRED_WORKBUDDY_MODEL)?.credits, 0);
    assert.equal(pickPreferredWorkbuddyModel(catalog), PREFERRED_WORKBUDDY_MODEL);
  } finally {
    if (previous === undefined) delete process.env.ACC_PRODUCT_CONFIG_PATH;
    else process.env.ACC_PRODUCT_CONFIG_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('readModelCatalog 能从 local_storage 的 gzip+base64 缓存回退读取', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-catalog-ls-'));
  const config = {
    models: [
      { id: 'gpt-6-sol', credits: 'x1.33' },
      { id: PREFERRED_WORKBUDDY_MODEL, credits: 'x0.00' },
    ],
  };
  // 与真实缓存同格式：JSON 字符串包裹的 base64(gzip(json))
  const encoded = JSON.stringify(gzipSync(Buffer.from(JSON.stringify(config))).toString('base64'));
  await writeFile(path.join(dir, 'entry_test.info'), encoded);

  const previous = process.env.ACC_PRODUCT_CONFIG_PATH;
  delete process.env.ACC_PRODUCT_CONFIG_PATH;
  try {
    const catalog = readModelCatalog({ localStorageDir: dir });
    assert.equal(pickPreferredWorkbuddyModel(catalog), PREFERRED_WORKBUDDY_MODEL);
  } finally {
    if (previous !== undefined) process.env.ACC_PRODUCT_CONFIG_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('两个来源都不可用时返回空目录而不是抛错', () => {
  const previous = process.env.ACC_PRODUCT_CONFIG_PATH;
  process.env.ACC_PRODUCT_CONFIG_PATH = '/nonexistent/acc-product-config-v3.json';
  try {
    assert.deepEqual(readModelCatalog({ localStorageDir: '/nonexistent/local-storage' }), []);
  } finally {
    if (previous === undefined) delete process.env.ACC_PRODUCT_CONFIG_PATH;
    else process.env.ACC_PRODUCT_CONFIG_PATH = previous;
  }
});
