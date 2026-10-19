/**
 * CodeBuddy 模型目录与自动选模型规则。
 *
 * 回归背景：workbuddy provider 未显式配置模型时，过去一律交给 CLI 默认模型，
 * 而默认模型可能是计费的。现在先从 CLI 的产品配置里读模型目录，按偏好表挑选。
 *
 * 2026-10-18 账号目录刷新后 gpt-* 全部下线、deepseek-v4.1-flash 变成 0.11 credits，
 * 早期用「目录里必须有 gpt-*」反推完整性的判据把正常目录判成残缺，一个模型都选不出来，
 * 因此改为只依据 credits 本身判断价格。
 *
 * 选型标准后来从「必须免费」放宽为「够快 + 够便宜」：
 * glm-5.3-flash（0.06）升为首选，deepseek-v4.1-flash 加价格闸门（只在 0.08 时用），
 * hy3 因为太慢从表里移除并列入排除名单。
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
  PREFERRED_MODELS,
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

test('偏好表首位是 deepseek-v4.1-flash', () => {
  assert.equal(PREFERRED_WORKBUDDY_MODEL, 'deepseek-v4.1-flash');
  assert.deepEqual(PREFERRED_MODELS.map((rule) => rule.id), [
    'deepseek-v4.1-flash',
    'glm-5.3-flash',
    'hy3',
  ]);
});

test('首选不看价格：glm-5.3-flash 收费 0.06 也照选', () => {
  const catalog = [
    { id: 'gpt-6-astra', credits: 6.67 },
    { id: 'glm-5.3-flash', credits: 0.06 },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), 'glm-5.3-flash');
});

test('首选缺席时退到 deepseek-v4.1-flash，但只在 0.08 时', () => {
  const base = [
    { id: 'deepseek-v4.1-flash', credits: 0 },
    { id: 'step-5-preview', credits: 0 },
  ];
  // 目录确认 0.08：采用
  assert.equal(
    pickPreferredWorkbuddyModel([...base, { id: 'deepseek-v4.1-flash', credits: 0.08 }]),
    'deepseek-v4.1-flash',
  );
  // 涨价到 0.11：跳过，退到免费的 deepseek
  assert.equal(
    pickPreferredWorkbuddyModel([...base, { id: 'deepseek-v4.1-flash', credits: 0.11 }]),
    'deepseek-v4.1-flash',
  );
  // 降价到 0.05：同样跳过（闸门是精确匹配，不做「小于等于」猜测）
  assert.equal(
    pickPreferredWorkbuddyModel([...base, { id: 'deepseek-v4.1-flash', credits: 0.05 }]),
    'deepseek-v4.1-flash',
  );
});

test('价格未标注（null）不能满足闸门', () => {
  const catalog = [
    { id: 'deepseek-v4.1-flash', credits: null },
    { id: 'step-5-preview', credits: 0 },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), 'step-5-preview');
});

test('deepseek 涨价到 0.11 时不再被当作免费兜底', () => {
  const catalog = [
    { id: 'deepseek-v4.1-flash', credits: 0.11 },
    { id: 'step-5-preview', credits: 0 },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), 'step-5-preview');
});

test('hy3 可作为兜底被选中：偏好表全部落空时允许取 hy3', () => {
  const catalog = [
    { id: 'some-other-free', credits: 0 },
    { id: 'hy3', credits: 0 },
  ];
  // hy3 已列入偏好表兜底，因此优先于目录顺序中的其它免费模型
  assert.equal(pickPreferredWorkbuddyModel(catalog), 'hy3');
  // 只剩 hy3 一个免费模型时，允许选它作为兜底
  assert.equal(pickPreferredWorkbuddyModel([{ id: 'hy3', credits: 0 }]), 'hy3');
});

test('偏好表都没命中时取目录里第一个免费模型', () => {
  const catalog = [
    { id: 'glm-5.3', credits: 0.79 },
    { id: 'some-new-model', credits: 0 },
  ];
  assert.equal(pickPreferredWorkbuddyModel(catalog), 'some-new-model');
});

test('一个可用的免费模型都没有时返回 null', () => {
  const catalog = [
    { id: 'gpt-5.4', credits: 1.65 },
    { id: 'deepseek-v4.1-flash', credits: 0.11 },
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
    { id: 'glm-5.3-flash', credits: 0.06 },
  ];
  assert.equal(resolveWorkbuddyModel('auto', catalog), 'glm-5.3-flash');
  assert.equal(resolveWorkbuddyModel('  AUTO  ', catalog), 'glm-5.3-flash');
  assert.equal(resolveWorkbuddyModel('', catalog), 'glm-5.3-flash');
  assert.equal(resolveWorkbuddyModel(undefined, catalog), 'glm-5.3-flash');
});

test('显式配置了真实模型时不覆盖', () => {
  const catalog = [
    { id: 'gpt-5.4', credits: 1.65 },
    { id: 'glm-5.3-flash', credits: 0.06 },
  ];
  // 显式指定 hy3 也照用：排除名单只管自动挑选，不否决用户的选择
  assert.equal(resolveWorkbuddyModel('gpt-5.4', catalog), 'gpt-5.4');
  assert.equal(resolveWorkbuddyModel('hy3', catalog), 'hy3');
});

test('auto 且目录不可用时留空，交给 CLI 默认模型', () => {
  assert.equal(resolveWorkbuddyModel('auto', []), '');
  // 目录读到了，但偏好表和免费兜底都没命中：同样不猜
  assert.equal(resolveWorkbuddyModel('auto', [{ id: 'glm-5.3', credits: 0.79 }]), '');
});

test('readModelCatalog 优先读 ACC_PRODUCT_CONFIG_PATH', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-catalog-'));
  const file = path.join(dir, 'acc-product-config-v3.json');
  await writeFile(file, JSON.stringify({
    models: [
      { id: 'gpt-5.4', credits: 'x1.65' },
      { id: 'glm-5.3-flash', credits: 'x0.06' },
    ],
  }));
  const previous = process.env.ACC_PRODUCT_CONFIG_PATH;
  process.env.ACC_PRODUCT_CONFIG_PATH = file;
  try {
    const catalog = readModelCatalog();
    assert.equal(catalog.length, 2);
    assert.equal(catalog.find((m) => m.id === 'glm-5.3-flash')?.credits, 0.06);
    assert.equal(pickPreferredWorkbuddyModel(catalog), 'glm-5.3-flash');
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
      { id: 'deepseek-v4.1-flash', credits: 'x0.00' },
    ],
  };
  // 与真实缓存同格式：JSON 字符串包裹的 base64(gzip(json))
  const encoded = JSON.stringify(gzipSync(Buffer.from(JSON.stringify(config))).toString('base64'));
  await writeFile(path.join(dir, 'entry_test.info'), encoded);

  const previous = process.env.ACC_PRODUCT_CONFIG_PATH;
  delete process.env.ACC_PRODUCT_CONFIG_PATH;
  try {
    const catalog = readModelCatalog({ localStorageDir: dir });
    assert.equal(pickPreferredWorkbuddyModel(catalog), 'deepseek-v4.1-flash');
  } finally {
    if (previous !== undefined) process.env.ACC_PRODUCT_CONFIG_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('readModelCatalog 能读明文 JSON 形态的 local_storage 缓存', async () => {
  // 回归：2026-10-18 CLI 改成把产品配置明文落盘，旧解码器只认 base64+gzip，
  // 一律抛「incorrect header check」，目录读成空数组 → 自动选模型静默失效。
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-catalog-plain-'));
  await writeFile(path.join(dir, 'entry_plain.info'), JSON.stringify({
    $schema: 'product-schema.json',
    productName: 'WorkBuddy AI',
    models: [
      { id: 'hy4-preview', credits: 'x0.29' },
      { id: 'glm-5.3-flash', credits: 'x0.06' },
    ],
  }));

  const previous = process.env.ACC_PRODUCT_CONFIG_PATH;
  delete process.env.ACC_PRODUCT_CONFIG_PATH;
  try {
    const catalog = readModelCatalog({ localStorageDir: dir });
    assert.equal(catalog.length, 2);
    assert.equal(pickPreferredWorkbuddyModel(catalog), 'glm-5.3-flash');
  } finally {
    if (previous !== undefined) process.env.ACC_PRODUCT_CONFIG_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('新产品配置被无关缓存条目挤到后面时仍能读到', async () => {
  // 回归：曾按「最近 6 份」截断候选文件。CLI 一次刷新写入 4 个非产品配置条目
  // （键值存储、用户数据、字符串），加上 2 个解析失败的，真配置正好被挤出窗口。
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-catalog-window-'));
  const config = { models: [{ id: 'glm-5.3-flash', credits: 'x0.06' }] };
  await writeFile(path.join(dir, 'entry_oldest_product.info'), JSON.stringify(config));
  // 8 个更新的干扰文件，全部不是产品配置
  for (let i = 0; i < 8; i += 1) {
    const name = `entry_junk_${String(i).padStart(2, '0')}.info`;
    await writeFile(path.join(dir, name), JSON.stringify({ [`key${i}`]: { value: {}, timestamp: i } }));
    // 逐个后写，保证 mtime 单调递增，顺序确定
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const previous = process.env.ACC_PRODUCT_CONFIG_PATH;
  delete process.env.ACC_PRODUCT_CONFIG_PATH;
  try {
    const catalog = readModelCatalog({ localStorageDir: dir });
    assert.equal(pickPreferredWorkbuddyModel(catalog), 'glm-5.3-flash');
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
