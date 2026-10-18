/**
 * CodeBuddy 模型目录读取。
 *
 * CLI 的产品配置里带一份完整模型列表，每个模型有 `credits` 费率字段
 * （实际形态有三种："x0.00"、"x0.34 credits"、""）。本模块只做两件事：
 * 找到这份配置，以及按规则挑出「确认免费」的目标模型。
 *
 * 配置来源按可靠性排序：
 *   1. ACC_PRODUCT_CONFIG_PATH —— CLI 自己落盘的明文 JSON
 *   2. ~/.codebuddy/local_storage/*.info —— 缓存副本（两种编码都见过，见 decodeProductConfig）
 * 两者都拿不到时返回空数组，调用方回退到 CLI 运行时默认模型。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export interface CatalogModel {
  id: string;
  /** 每单位用量消耗的 credits；0 表示免费，无法解析时为 null。 */
  credits: number | null;
}

/** 目标模型：目录确认它免费时优先使用。 */
export const PREFERRED_WORKBUDDY_MODEL = 'deepseek-v4.1-flash';

/**
 * 免费模型的偏好顺序。前一个不可用（下线、或不再免费）时退到下一个。
 * hy3 / step-5-preview 是当前账号里另外两个 credits=0 的模型，中文输出质量可用。
 */
const PREFERRED_FREE_MODELS = [PREFERRED_WORKBUDDY_MODEL, 'hy3', 'step-5-preview'] as const;

/**
 * 解析 credits 字段。
 *
 * 真实取值：`"x0.00"`（免费）、`"x0.34 credits"`（带单位）、`""`（未填，如 default-model）。
 * 只有能确定解析出数字时才算数 —— 空串和未知格式返回 null，避免把「没填」误判成「免费」。
 */
export function parseCredits(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = /^x?\s*(-?\d+(?:\.\d+)?)/i.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** 从产品配置对象里抽取模型列表；结构不符时返回空数组。 */
function modelsFromConfig(raw: unknown): CatalogModel[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { models?: unknown }).models;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: any) => {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) return [];
    return [{ id, credits: parseCredits(item.credits) }];
  });
}

/**
 * 把一份缓存文本解成模型列表。
 *
 * local_storage 的编码形态随 CLI 版本变过，两种都得认：
 *   1. 明文产品配置 JSON —— `{"$schema":"product-schema.json","models":[...]}`
 *   2. JSON 字符串 → base64 → gzip → 产品配置 JSON（更早的写法）
 * 2026-10-18 就踩过：新版把产品配置直接明文落盘，旧解码器一律抛「incorrect header check」，
 * 结果整份目录读成空数组，自动选模型静默失效。
 */
function decodeProductConfig(text: string): CatalogModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const direct = modelsFromConfig(parsed);
  if (direct.length) return direct;
  if (typeof parsed !== 'string') return [];
  try {
    const decoded = zlib.gunzipSync(Buffer.from(parsed, 'base64')).toString('utf8');
    return modelsFromConfig(JSON.parse(decoded));
  } catch {
    return [];
  }
}

function readFromEnvPath(): CatalogModel[] {
  const file = (process.env.ACC_PRODUCT_CONFIG_PATH || '').trim();
  if (!file) return [];
  try {
    return decodeProductConfig(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function readFromLocalStorage(dirOverride?: string): CatalogModel[] {
  const dir = dirOverride || path.join(os.homedir(), '.codebuddy', 'local_storage');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // 按 mtime 从新到旧全量尝试，不设固定窗口。
  // 曾按「最近 6 份」截断，结果 CLI 一次刷新写入 4 个非产品配置的缓存条目，
  // 把真正的产品配置挤出窗口，目录读空 —— 而漏读的代价是整个自动选模型失效，
  // 多读几个文件的代价只是一次 JSON.parse，不值得为省这点开销引入随机失效。
  const files = names
    .filter((name) => name.endsWith('.info'))
    .map((name) => {
      const full = path.join(dir, name);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is { full: string; mtime: number } => item !== null)
    .sort((a, b) => b.mtime - a.mtime);

  for (const { full } of files) {
    try {
      const models = decodeProductConfig(fs.readFileSync(full, 'utf8').trim());
      if (models.length) return models;
    } catch {
      // 不是产品配置、或文件正在被写 —— 继续试下一份
    }
  }
  return [];
}

/**
 * 读取模型目录；拿不到时返回空数组（不抛错，调用方据此回退）。
 * `localStorageDir` 仅供测试注入，生产调用不传。
 */
export function readModelCatalog(options: { localStorageDir?: string } = {}): CatalogModel[] {
  const fromEnv = readFromEnvPath();
  if (fromEnv.length) return fromEnv;
  return readFromLocalStorage(options.localStorageDir);
}

/**
 * 从目录里挑目标模型：只挑 credits 明确为 0 的，按 PREFERRED_FREE_MODELS 的顺序退让。
 *
 * 这里**不再**要求「目录里必须存在 gpt-* 才算完整目录」。那个判据来自早期实现，
 * 用某个厂商的模型是否下发来反推目录完整性；一旦该厂商整批下线（2026-10-18 就发生过，
 * gpt-* 全部消失、deepseek 也变成 0.11 credits），完整目录会被误判成残缺目录，
 * 结果一个模型都选不出来。credits 本身已经是「是否免费」的直接证据，
 * 不需要再借道第三方模型来间接证明。
 *
 * 一个 credits=0 的模型都没有时返回 null（不猜、不硬编码），由调用方回退 CLI 默认模型。
 */
export function pickPreferredWorkbuddyModel(catalog: readonly CatalogModel[]): string | null {
  const free = catalog.filter((model) => model.credits === 0);
  if (!free.length) return null;
  for (const id of PREFERRED_FREE_MODELS) {
    if (free.some((model) => model.id === id)) return id;
  }
  // 偏好表都没命中：取目录里第一个确认免费的（目录顺序即产品侧的推荐顺序）。
  return free[0]!.id;
}

/**
 * 把「显式配置」与「目录挑选」合成最终的默认模型。
 *
 * `auto` 必须当成「没配置」：扩展侧默认就发 model: "auto"，用户也习惯这么写。
 * 若把它原样当成模型 id，下游 parseAgentModel 会把 'auto' 归一成空串，
 * 于是 CLI 拿不到 --model，静默回退到账号默认模型（计费、且未必支持 json-schema），
 * 表面上一切正常，实际每次调用都在用错模型。空值同理。
 */
export function resolveWorkbuddyModel(
  explicit: string | undefined,
  catalog: readonly CatalogModel[],
): string {
  const value = (explicit || '').trim();
  if (value && value.toLowerCase() !== 'auto') return value;
  return pickPreferredWorkbuddyModel(catalog) || '';
}
