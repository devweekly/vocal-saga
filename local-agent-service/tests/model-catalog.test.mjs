/**
 * CodeBuddy 模型目录与「免费模型」选择规则。
 *
 * 回归背景：workbuddy provider 未显式配置模型时，过去一律交给 CLI 默认模型，
 * 而默认模型可能是计费的。现在先从 CLI 的产品配置里读模型目录，
 * 只有在「目录完整 + 目标模型存在 + 费率明确为 0」三个条件同时成立时才切到免费模型。
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

test('目录完整且目标免费时选中 deepseek-v4.1-flash', () => {
  const catalog = [
    { id: 'gpt-6-astra', credits: 6.67 },
    { id: 'gpt-5.4', credits: 1.65 },
    { id: PREFERRED_WORKBUDDY_MODEL, credits: 0 },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), PREFERRED_WORKBUDDY_MODEL);
});

test('目录里没有 gpt-* 时视为不完整，不切换', () => {
  // 只有目标模型，无法证明拿到的是完整目录
  assert.equal(pickPreferredWorkbuddyModel([{ id: PREFERRED_WORKBUDDY_MODEL, credits: 0 }]), null);
  assert.equal(pickPreferredWorkbuddyModel([]), null);
});

test('目标模型费率非 0 时不切换', () => {
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

test('目标模型不在目录里时不切换', () => {
  assert.equal(pickPreferredWorkbuddyModel([{ id: 'gpt-5.4', credits: 1.65 }]), null);
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
