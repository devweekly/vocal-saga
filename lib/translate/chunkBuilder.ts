import type { TextBlock } from './blockExtractor';

export interface Chunk {
  id: string;
  blocks: TextBlock[];
  jsonContent: string;
  estimatedTokens: number;
}

const MAX_INPUT_TOKENS = 500000;
const TARGET_TOKENS = 10000;

/**
 * 估算 token 数：CJK 字符约 0.5 tokens/char，拉丁文约 0.25 tokens/char。
 * 原实现 text.length/4 对中文严重低估，导致 chunk 过大 → API 截断 → 重试。
 */
export function estimateTokens(text: string): number {
  let cjkChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified
      (code >= 0x3040 && code <= 0x309f) ||   // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) ||   // Katakana
      (code >= 0xac00 && code <= 0xd7af)      // Hangul
    ) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(cjkChars * 0.5 + otherChars * 0.25);
}

function buildJsonContent(blocks: TextBlock[]): string {
  return JSON.stringify(
    blocks.map((b) => ({
      id: b.id,
      text: b.text,
      ...(b.contextPath ? { contextPath: b.contextPath } : {}),
      ...(b.kind ? { kind: b.kind } : {}),
      ...(Number.isInteger(b.level) ? { level: b.level } : {}),
      ...(b.marker ? { marker: b.marker } : {}),
    }))
  );
}

function isStructuralBoundary(block: TextBlock): boolean {
  return /^h[1-6]$/.test(block.tag);
}

const MAX_SEGMENT_CHARS = 2400;

/** 在句子/段落边界拆分超长正文，并保留片段间原始分隔符用于回拼。 */
function splitLongText(text: string, maxChars = MAX_SEGMENT_CHARS): Array<{ text: string; separatorBefore: string }> {
  const parts: Array<{ text: string; separatorBefore: string }> = [];
  let start = 0;
  let separatorBefore = '';

  while (text.length - start > maxChars) {
    const endLimit = Math.min(text.length, start + maxChars);
    const window = text.slice(start, endLimit);
    let splitAt = -1;
    let separator = '';

    // 优先按段落边界拆分。
    const paragraphPattern = /\n[\t ]*\n+/g;
    let match: RegExpExecArray | null;
    while ((match = paragraphPattern.exec(window)) !== null) {
      if (match.index >= Math.floor(maxChars * 0.45)) {
        splitAt = start + match.index;
        separator = match[0];
      }
    }

    // 其次在句末拆分；不依赖 lookbehind，兼容扩展构建目标。
    if (splitAt < 0) {
      const sentencePattern = /[.!?。！？][\t ]+/g;
      while ((match = sentencePattern.exec(window)) !== null) {
        if (match.index >= Math.floor(maxChars * 0.45)) {
          splitAt = start + match.index + 1;
          separator = match[0].slice(1);
        }
      }
    }

    // 退回空白边界，尽量避免切断单词。
    if (splitAt < 0) {
      const whitespacePattern = /\s+/g;
      while ((match = whitespacePattern.exec(window)) !== null) {
        if (match.index >= Math.floor(maxChars * 0.45)) {
          splitAt = start + match.index;
          separator = match[0];
        }
      }
    }

    // 对极长的无空白序列做硬切分，且不拆开 UTF-16 代理对。
    if (splitAt < 0 || splitAt <= start) {
      splitAt = endLimit;
      const last = text.charCodeAt(splitAt - 1);
      if (last >= 0xd800 && last <= 0xdbff && splitAt < text.length) splitAt--;
      separator = '';
    }

    const partText = text.slice(start, splitAt);
    if (!partText) {
      splitAt = endLimit;
      separator = '';
    }
    parts.push({ text: text.slice(start, splitAt), separatorBefore });
    start = splitAt + separator.length;
    separatorBefore = separator;
  }

  if (start < text.length) {
    parts.push({ text: text.slice(start), separatorBefore });
  }
  return parts;
}

/**
 * 只把长的可读正文拆成内部片段。片段有独立缓存 ID，但不会独立回填 DOM；
 * 翻译器把所有片段成功合并后，才将结果写回原始 block ID。
 */
function expandOversizedBlocks(blocks: TextBlock[]): TextBlock[] {
  const expanded: TextBlock[] = [];
  for (const block of blocks) {
    const tag = block.tag.toLowerCase();
    if (
      block.text.length <= MAX_SEGMENT_CHARS ||
      ['pre', 'code', 'script', 'style', 'textarea'].includes(tag)
    ) {
      expanded.push(block);
      continue;
    }
    const parts = splitLongText(block.text);
    if (parts.length <= 1) {
      expanded.push(block);
      continue;
    }
    parts.forEach((part, index) => {
      expanded.push({
        ...block,
        id: `${block.id}__segment_${index + 1}`,
        tag: 'p',
        text: part.text,
        segmentOf: block.id,
        segmentIndex: index,
        segmentCount: parts.length,
        separatorBefore: part.separatorBefore,
        renderHint: undefined,
        context: undefined,
      });
    });
  }
  return expanded;
}

/** 合并分段译文；任一片段缺失时不产出原块译文，避免部分覆盖原文。 */
export function mergeSegmentTranslations(
  chunks: Chunk[],
  translations: Map<string, string>,
): Map<string, string> {
  const segmentBlocks = chunks.flatMap((chunk) => chunk.blocks)
    .filter((block) => block.segmentOf && Number.isInteger(block.segmentIndex) && Number.isInteger(block.segmentCount));
  if (segmentBlocks.length === 0) return translations;

  const segmentIds = new Set(segmentBlocks.map((block) => block.id));
  const merged = new Map<string, string>();
  for (const [id, text] of translations) {
    if (!segmentIds.has(id)) merged.set(id, text);
  }

  const groups = new Map<string, TextBlock[]>();
  for (const block of segmentBlocks) {
    const group = groups.get(block.segmentOf!) ?? [];
    group.push(block);
    groups.set(block.segmentOf!, group);
  }

  for (const [originalId, group] of groups) {
    group.sort((a, b) => a.segmentIndex! - b.segmentIndex!);
    if (group.length !== group[0].segmentCount || group.some((block, index) => block.segmentIndex !== index)) continue;
    if (group.some((block) => !translations.get(block.id)?.trim())) continue;

    let text = translations.get(group[0].id)!;
    for (let index = 1; index < group.length; index++) {
      text += (group[index].separatorBefore ?? ' ') + translations.get(group[index].id)!;
    }
    merged.set(originalId, text);
  }
  return merged;
}

export function buildChunks(blocks: TextBlock[]): Chunk[] {
  console.log('[ChunkBuilder] buildChunks called with', blocks.length, 'blocks');
  if (blocks.length === 0) return [];

  const chunks: Chunk[] = [];
  let currentBlocks: TextBlock[] = [];
  let currentTokens = 0;
  let chunkIndex = 0;

  function flushChunk() {
    if (currentBlocks.length > 0) {
      chunkIndex++;
      chunks.push({
        id: `chunk${chunkIndex}`,
        blocks: currentBlocks,
        jsonContent: buildJsonContent(currentBlocks),
        estimatedTokens: currentTokens,
      });
      currentBlocks = [];
      currentTokens = 0;
    }
  }

  const inputBlocks = expandOversizedBlocks(blocks);
  for (let i = 0; i < inputBlocks.length; i++) {
    const block = inputBlocks[i];
    const blockTokens = estimateTokens(block.text) + 20;

    const isBoundary = isStructuralBoundary(block);
    const targetTokens = TARGET_TOKENS;
    const wouldExceed = currentTokens + blockTokens > targetTokens;
    const mustFlush = currentTokens + blockTokens > MAX_INPUT_TOKENS;

    if (mustFlush) {
      flushChunk();
      currentBlocks.push(block);
      currentTokens = blockTokens;
    } else if (wouldExceed && currentBlocks.length > 0) {
      if (isBoundary) {
        flushChunk();
        currentBlocks.push(block);
        currentTokens = blockTokens;
      } else {
        const nextBoundary = findNextBoundary(inputBlocks, i);
        if (nextBoundary && nextBoundary - i < 5) {
          for (let j = i; j <= nextBoundary; j++) {
            const b = inputBlocks[j];
            currentBlocks.push(b);
            currentTokens += estimateTokens(b.text) + 20;
          }
          i = nextBoundary;
          flushChunk();
        } else {
          flushChunk();
          currentBlocks.push(block);
          currentTokens = blockTokens;
        }
      }
    } else {
      currentBlocks.push(block);
      currentTokens += blockTokens;
    }
  }

  flushChunk();
  console.log('[ChunkBuilder] Built', chunks.length, 'chunks');
  if (chunks.length > 0) {
    // chunk 级别 summary：id / block 数 / token 估算 / blockId 列表。
    // 排查 chunk 切分问题（chunk 太大/太小、blockIds 是否连续）时这就够。
    // 单块的 tag/text 不打：20 块就要 21 行，污染日志。
    console.log(
      '[ChunkBuilder] Chunk sizes:',
      chunks.map((c) => ({
        id: c.id,
        blocks: c.blocks.length,
        tokens: c.estimatedTokens,
        blockIds: c.blocks.map((b) => b.id).join(','),
      })),
    );
  }
  return chunks;
}

function findNextBoundary(blocks: TextBlock[], startIndex: number): number | null {
  for (let i = startIndex + 1; i < blocks.length; i++) {
    if (isStructuralBoundary(blocks[i])) return i;
  }
  return null;
}
