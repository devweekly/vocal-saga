/**
 * CodeBuddy 模型目录读取。
 *
 * CLI 的产品配置里带一份完整模型列表，每个模型有 `credits` 费率字段
 * （实际形态有三种："x0.00"、"x0.34 credits"、""）。本模块只做两件事：
 * 找到这份配置，以及按规则挑出「确认免费」的目标模型。
 *
 * 配置来源按可靠性排序：
 *   1. ACC_PRODUCT_CONFIG_PATH —— CLI 自己落盘的明文 JSON
 *   2. ~/.codebuddy/local_storage/*.info —— gzip + base64 的缓存副本
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

function readFromEnvPath(): CatalogModel[] {
  const file = (process.env.ACC_PRODUCT_CONFIG_PATH || '').trim();
  if (!file) return [];
  try {
    return modelsFromConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
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
  // 只尝试最近的几份：这些缓存每次产品配置更新都会新增一个，旧的没有价值。
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
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 6);

  for (const { full } of files) {
    try {
      // 缓存格式：JSON 字符串 → base64 → gzip → 产品配置 JSON
      const encoded = JSON.parse(fs.readFileSync(full, 'utf8').trim());
      const decoded = zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
      const models = modelsFromConfig(JSON.parse(decoded));
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
 * 从目录里挑目标模型。
 *
 * 三个条件缺一不可：
 *   1. 目录里存在 gpt-* 模型 —— 说明拿到的是完整目录，而不是被裁剪过的子集；
 *   2. 目录里有 deepseek-v4.1-flash；
 *   3. 该模型的 credits 明确为 0（不是 null、不是「没填」）。
 *
 * 任一不满足返回 null，由调用方回退到 CLI 默认模型。这里不做猜测：
 * 把「未标注费率」当成免费会让账单不可预期。
 */
export function pickPreferredWorkbuddyModel(catalog: readonly CatalogModel[]): string | null {
  if (!catalog.some((model) => model.id.startsWith('gpt-'))) return null;
  const target = catalog.find((model) => model.id === PREFERRED_WORKBUDDY_MODEL);
  if (!target || target.credits !== 0) return null;
  return target.id;
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
