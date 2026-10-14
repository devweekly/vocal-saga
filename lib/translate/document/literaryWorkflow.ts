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

export type LiteraryReviewCategory = 'accuracy' | 'terminology' | 'style';
export type LiteraryReviewPriority = 'must_fix' | 'optional';
export interface LiteraryReviewFinding {
  id: string;
  category: LiteraryReviewCategory;
  priority: LiteraryReviewPriority;
  sourceExcerpt: string;
  draftExcerpt: string;
  reason: string;
  suggestion: string;
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
    glossary: undefined,
    promptStyle: input.promptStyle,
    translationMode: 'literary',
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
  // Model output is never evidence of human approval. Force every new entity/relation to suggested;
  // mergeLiteraryMemory will preserve prior entries (including user-confirmed ones) unchanged.
  const incoming = sanitizeLiteraryMemory({
    version: 1,
    entities: entities.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({ ...(item as Record<string, unknown>), reviewStatus: 'suggested' })),
    relationships: relationships.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({ ...(item as Record<string, unknown>), reviewStatus: 'suggested' })),
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
}): Promise<{ translations: Record<string, string>; reviewedIds: string[]; missingIds: string[]; findings: LiteraryReviewFinding[] }> {
  const memory = sanitizeLiteraryMemory(input.memory);
  const segments = input.segments.filter((segment) =>
    typeof segment.id === 'string' && segment.id.trim() &&
    typeof segment.source === 'string' && segment.source.trim() &&
    typeof segment.draft === 'string' && segment.draft.trim(),
  );
  if (!segments.length) return { translations: {}, reviewedIds: [], missingIds: [], findings: [] };

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
    glossary: undefined,
    promptStyle: input.promptStyle,
    translationMode: 'literary',
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey,
    concurrency: 1,
    taskInstructions: buildLiteraryReviewInstructions(input.chapterTitle),
  });

  const translations: Record<string, string> = {};
  const findings: LiteraryReviewFinding[] = [];
  for (const segment of segments) {
    const value = reviewed.get(segment.id);
    if (typeof value !== 'string' || !value.trim()) continue;
    const parsed = extractJsonObject(value);
    if (!parsed || typeof parsed.finalTranslation !== 'string' || !parsed.finalTranslation.trim()) {
      // Fail closed: malformed reviewer output must never rewrite a valid first draft.
      continue;
    }
    const segmentFindings: LiteraryReviewFinding[] = [];
    if (Array.isArray(parsed.findings)) {
      for (const raw of parsed.findings.slice(0, 12)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        const category = item.category;
        // 准确性与已确认实体译名问题属于必须修复；文学风格问题允许作为受控修订理由。
        if (category !== 'accuracy' && category !== 'terminology' && category !== 'style') continue;
        const priority: LiteraryReviewPriority = category === 'style' ? 'optional' : 'must_fix';
        const finding: LiteraryReviewFinding = {
          id: segment.id,
          category,
          priority,
          sourceExcerpt: typeof item.sourceExcerpt === 'string' ? item.sourceExcerpt.slice(0, 240) : '',
          draftExcerpt: typeof item.draftExcerpt === 'string' ? item.draftExcerpt.slice(0, 240) : '',
          reason: typeof item.reason === 'string' ? item.reason.slice(0, 400) : '',
          suggestion: typeof item.suggestion === 'string' ? item.suggestion.slice(0, 400) : '',
        };
        if (finding.reason || finding.suggestion) segmentFindings.push(finding);
      }
    }
    findings.push(...segmentFindings);
    const hasActionableFinding = segmentFindings.length > 0;
    // 有明确事实错误或具体文风问题时采纳受控修订版；无问题时保留初译，避免无意义重写。
    translations[segment.id] = hasActionableFinding
      ? parsed.finalTranslation.trim().slice(0, 5_000)
      : segment.draft.trim().slice(0, 5_000);
  }
  const expectedIds = segments.map((segment) => segment.id);
  const reviewedIds = expectedIds.filter((id) => typeof translations[id] === 'string');
  return {
    translations,
    reviewedIds,
    missingIds: expectedIds.filter((id) => !reviewedIds.includes(id)),
    findings: findings.slice(0, 240),
  };
}
