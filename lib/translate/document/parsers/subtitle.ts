import type { DocumentSegment, ParsedDocument } from '../types';

/**
 * SRT / VTT 字幕解析。
 *
 * 关键取舍：**每个 cue 单独成一个 segment**，而不是先合并再翻译。
 * 字幕翻译的价值在于"时间轴对齐"—— 合并会让译文无法回填到原时间码。
 * cue 数量多（上千条）的问题交给上层 chunkBuilder 分批解决，
 * 它本来就是按 token 预算聚合的。
 */

export interface SubtitleCue {
  index: number;
  start: string;
  end: string;
  text: string;
}

const TIME_RE =
  /(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}|\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}|\d{2}:\d{2}[,.]\d{1,3})/;

/** SRT 时间码统一成 VTT 风格（逗号 → 点），便于后续格式化。 */
function normalizeTime(t: string): string {
  return t.replace(',', '.');
}

export function parseSrt(input: string): SubtitleCue[] {
  const blocks = input.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;

    let cursor = 0;
    const firstNum = Number(lines[0]);
    let index: number;
    if (Number.isFinite(firstNum) && lines[0] !== '') {
      index = firstNum;
      cursor = 1;
    } else {
      index = cues.length + 1;
    }

    const timeLine = lines[cursor] ?? '';
    const m = TIME_RE.exec(timeLine);
    if (!m) continue;
    const text = lines.slice(cursor + 1).join('\n');
    if (!text) continue;

    cues.push({
      index,
      start: normalizeTime(m[1] as string),
      end: normalizeTime(m[2] as string),
      text,
    });
  }
  return cues;
}

export function parseVtt(input: string): SubtitleCue[] {
  // 去掉 BOM + WEBVTT 头
  const body = input
    .replace(/\r\n?/g, '\n')
    .replace(/^﻿?WEBVTT[^\n]*\n/, '');
  const blocks = body.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const trimmedBlock = block.trim();
    // 跳过 NOTE / STYLE / REGION 注释块
    if (!trimmedBlock) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(trimmedBlock)) continue;

    const lines = trimmedBlock.split('\n').map((l) => l.trim());
    const timeLineIndex = lines.findIndex((l) => TIME_RE.test(l));
    if (timeLineIndex < 0) continue;

    const m = TIME_RE.exec(lines[timeLineIndex] as string);
    if (!m) continue;
    // 时间行之前的非空行是 cue 标识符，之后的全部是正文
    const text = lines.slice(timeLineIndex + 1).join('\n');
    if (!text) continue;

    cues.push({
      index: cues.length + 1,
      start: normalizeTime(m[1] as string),
      end: normalizeTime(m[2] as string),
      text,
    });
  }
  return cues;
}

/** cue 列表 → segment 列表（保留时间码，供双语字幕导出回填）。 */
export function cuesToSegments(cues: SubtitleCue[]): DocumentSegment[] {
  return cues.map((cue, i) => ({
    id: `s${i}`,
    index: i,
    text: cue.text,
    kind: 'caption' as const,
    start: cue.start,
    end: cue.end,
  }));
}

export function parseSubtitleDocument(
  input: string,
  format: 'srt' | 'vtt',
  fileName = '',
): ParsedDocument {
  const cues = format === 'srt' ? parseSrt(input) : parseVtt(input);
  const segments = cuesToSegments(cues);
  const warnings: string[] = [];
  if (!segments.length) warnings.push('未解析到字幕条目，请确认是有效的 SRT/VTT 文件');

  return {
    format,
    title: fileName.replace(/\.[^.]+$/, '') || '字幕',
    segments,
    meta: {
      charCount: segments.reduce((n, s) => n + s.text.length, 0),
      segmentCount: segments.length,
      warnings,
    },
  };
}
