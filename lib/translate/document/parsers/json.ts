import type { DocumentSegment, ParsedDocument } from '../types';
import { DEFAULT_MAX_SEGMENT_CHARS, splitLongText } from './text';

/**
 * JSON 解析：摊平成「叶子字符串 + JSONPath」。
 *
 * 用途是翻译 i18n 语言包 / 导出的数据文件，所以：
 *   - 只有叶子字符串进 segment，数字、布尔、null 原样保留
 *   - 保留 path，导出时按路径回填，结构完整还原
 *   - 默认跳过明显不该翻的东西（URL、邮箱、哈希、时间戳、纯符号）
 */

/** 一眼就不该送进模型的字符串。 */
const NON_TRANSLATABLE = [
  /^https?:\/\//i,
  /^[\w.+-]+@[\w-]+\.[\w.]+$/,
  /^[a-f0-9]{16,}$/i,
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/,
  /^#[0-9a-f]{3,8}$/i,
];

/** 至少含一个字母/中日韩字符，才认为是"语言"。 */
const HAS_WORD = /[\p{L}]/u;

export interface ParseJsonOptions {
  maxSegmentChars?: number;
  fileName?: string;
  /** 短于此长度的字符串跳过，默认 1（即不跳过）。 */
  minLength?: number;
  /** 额外跳过规则。 */
  skipPatterns?: RegExp[];
}

interface Leaf {
  path: string;
  text: string;
}

function formatKey(key: string | number): string {
  if (typeof key === 'number') return `[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `['${key.replace(/'/g, "\\'")}']`;
}

export function collectJsonLeaves(value: unknown, basePath = '$'): Leaf[] {
  const leaves: Leaf[] = [];

  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') {
      leaves.push({ path, text: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, `${path}${formatKey(key)}`);
      }
    }
  };

  walk(value, basePath);
  return leaves;
}

export function isTranslatableString(
  text: string,
  minLength: number,
  extra: RegExp[] = [],
): boolean {
  const trimmed = text.trim();
  if (trimmed.length < minLength) return false;
  if (!HAS_WORD.test(trimmed)) return false;
  if (NON_TRANSLATABLE.some((re) => re.test(trimmed))) return false;
  if (extra.some((re) => re.test(trimmed))) return false;
  return true;
}

export function parseJsonDocument(
  input: string,
  options: ParseJsonOptions = {},
): ParsedDocument {
  const max = options.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS;
  const minLength = options.minLength ?? 1;
  const extra = options.skipPatterns ?? [];
  const warnings: string[] = [];

  let root: unknown;
  try {
    root = JSON.parse(input);
  } catch (err) {
    return {
      format: 'json',
      title: (options.fileName ?? '').replace(/\.[^.]+$/, '') || '文档',
      segments: [],
      meta: {
        charCount: 0,
        segmentCount: 0,
        warnings: [`JSON 解析失败：${(err as Error).message}`],
      },
    };
  }

  const leaves = collectJsonLeaves(root).filter((leaf) =>
    isTranslatableString(leaf.text, minLength, extra),
  );

  const segments: DocumentSegment[] = [];
  let index = 0;
  for (const leaf of leaves) {
    for (const piece of splitLongText(leaf.text.trim(), max)) {
      segments.push({
        id: `s${index}`,
        index,
        text: piece,
        kind: 'other',
        path: leaf.path,
      });
      index++;
    }
  }

  if (!segments.length) warnings.push('JSON 中没有可翻译的字符串');

  return {
    format: 'json',
    title: (options.fileName ?? '').replace(/\.[^.]+$/, '') || '文档',
    segments,
    meta: {
      charCount: segments.reduce((n, s) => n + s.text.length, 0),
      segmentCount: segments.length,
      warnings,
    },
  };
}
