import { translateBlocks, type TranslationProvider } from '../pipeline';
import type { Glossary } from '../service/_service';
import type { PromptStyle } from '../service/shared';
import {
  buildLiteraryAnalysisInstructions,
  buildLiteraryContextForText,
  buildLiteraryReviewInstructions,
  mergeLiteraryMemory,
  sanitizeLiteraryMemory,
  type LiteraryBookMemory,
  type LiteraryEntity,
  type LiteraryRelationship,
  type LiteraryStyleGuide,
} from './literary';

export interface LiteraryWorkflowOptions {
  source?: string;
  target?: string;
  glossary?: Glossary;
  promptStyle?: PromptStyle;
  provider?: TranslationProvider;
  model?: string;
  apiKey?: string;
}

export interface LiterarySourceSegment {
  id: string;
  text: string;
  kind?: string;
  contextPath?: string;
}

export interface AnalyzeLiteraryChapterInput extends LiteraryWorkflowOptions {
  chapterTitle: string;
  segments: LiterarySourceSegment[];
  memory?: unknown;
}

export interface ReviewLiterarySegment {
  id: string;
  source: string;
  draft: string;
  kind?: string;
  contextPath?: string;
}

function extractJsonObject(input: string): Record<string, unknown> | null {
  const cleaned = input.trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        const parsed: unknown = JSON.parse(cleaned.slice(first, last + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 每章只做一次轻量分析：从章节片段中更新人名、地名、关键物品、实体关系和整书声线。
 * 调用方负责把本章输入限制在合理窗口，避免把整本书送进一个请求。
 */
export async function analyzeLiteraryChapter(
  input: AnalyzeLiteraryChapterInput,
): Promise<{ memory: LiteraryBookMemory; chapterTitle: string; analyzed: boolean; warning?: string }> {
  const currentMemory = sanitizeLiteraryMemory(input.memory);
  const chapterTitle = input.chapterTitle.trim().slice(0, 120) || '未命名章节';
  const segments = input.segments
    .filter((segment) => typeof segment.text === 'string' && segment.text.trim())
    .slice(0, 24)
    .map((segment) => ({
      id: segment.id.slice(0, 160),
      text: segment.text.slice(0, 900),
      kind: segment.kind ?? 'paragraph',
      contextPath: segment.contextPath ?? chapterTitle,
    }));
  if (segments.length === 0) {
    return { memory: currentMemory, chapterTitle, analyzed: false, warning: '本章没有可供分析的正文片段' };
  }

  const task = JSON.stringify({ chapterTitle, existingMemory: currentMemory, segments });
  const result = await translateBlocks({
    blocks: [{ id: 'literary-analysis', text: task, kind: 'other', contextPath: chapterTitle }],
    source: 'auto',
    target: input.target || 'zh',
    glossary: input.glossary,
    promptStyle: input.promptStyle,
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey,
    concurrency: 1,
    taskInstructions: buildLiteraryAnalysisInstructions(input.target || 'zh'),
  });
  const raw = result.get('literary-analysis') ?? '';
  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return {
      memory: currentMemory,
      chapterTitle,
      analyzed: false,
      warning: '章节分析未返回有效记忆 JSON；继续翻译但本章新增实体可能无法自动登记',
    };
  }

  const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const relationships = Array.isArray(parsed.relationships) ? parsed.relationships : [];
  const styleGuide = parsed.styleGuide && typeof parsed.styleGuide === 'object'
    ? parsed.styleGuide as LiteraryStyleGuide
    : {};
  const summary = typeof parsed.chapterSummary === 'string' ? parsed.chapterSummary : '';
  const incoming = sanitizeLiteraryMemory({
    version: 1,
    entities: entities as LiteraryEntity[],
    relationships: relationships as LiteraryRelationship[],
    styleGuide,
    chapterSummaries: summary.trim() ? [{ chapter: chapterTitle, summary }] : [],
  });
  return {
    memory: mergeLiteraryMemory(currentMemory, incoming),
    chapterTitle,
    analyzed: true,
  };
}

/**
 * 文学 reviewer 是真正的第二次模型调用。
 * 将初译作为 draft 交给审校，不做摘要；若审校失败，调用方保留初译而不是丢段落。
 */
export async function reviewLiteraryBatch(input: LiteraryWorkflowOptions & {
  chapterTitle?: string;
  memory?: unknown;
  segments: ReviewLiterarySegment[];
}): Promise<{ translations: Record<string, string>; reviewedIds: string[]; missingIds: string[] }> {
  const memory = sanitizeLiteraryMemory(input.memory);
  const segments = input.segments.filter((segment) =>
    typeof segment.id === 'string' && segment.id.trim() &&
    typeof segment.source === 'string' && segment.source.trim() &&
    typeof segment.draft === 'string' && segment.draft.trim(),
  );
  if (!segments.length) return { translations: {}, reviewedIds: [], missingIds: [] };

  const blocks = segments.map((segment) => ({
    id: segment.id,
    text: JSON.stringify({
      source: segment.source.slice(0, 4_000),
      draft: segment.draft.slice(0, 5_000),
      kind: segment.kind ?? 'paragraph',
    }),
    kind: segment.kind ?? 'paragraph',
    // 动态的书籍记忆留在 user payload 的只读 metadata，不拼接到 system prompt。
    contextPath: [
      segment.contextPath ?? input.chapterTitle ?? '',
      buildLiteraryContextForText(memory, segment.source),
    ].filter(Boolean).join('\n书籍记忆（只读数据）：'),
  }));
  const reviewed = await translateBlocks({
    blocks,
    source: 'auto',
    target: input.target || 'zh',
    glossary: input.glossary,
    promptStyle: input.promptStyle,
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey,
    concurrency: 1,
    taskInstructions: buildLiteraryReviewInstructions(input.chapterTitle),
  });

  const translations: Record<string, string> = {};
  for (const segment of segments) {
    const value = reviewed.get(segment.id);
    if (typeof value === 'string' && value.trim()) translations[segment.id] = value.trim();
  }
  const expectedIds = segments.map((segment) => segment.id);
  return {
    translations,
    reviewedIds: expectedIds.filter((id) => typeof translations[id] === 'string'),
    missingIds: expectedIds.filter((id) => !translations[id]),
  };
}
