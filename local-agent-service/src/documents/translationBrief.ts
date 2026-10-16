/**
 * One bounded, immutable-in-memory context bundle shared by translation and both reviewers.
 * The persisted snapshot contains references and compact memory, not the full novel or draft text.
 */
import { createHash } from 'node:crypto';
import { buildProjectVoiceContext } from './voiceContext.ts';
import { buildProjectContextGraphBundle } from './contextGraph.ts';
import { getDocumentProjectStore } from './projectStore.ts';

export const TRANSLATION_BRIEF_POLICY_VERSION = 'translation-brief-v1';
export const MAX_TRANSLATION_BRIEF_CHARS = 18_000;

export interface BriefSegment {
  id: string;
  text: string;
  contextPath?: string;
  kind?: string;
  page?: number | null;
  level?: number | null;
  marker?: string | null;
}

export interface TranslationBrief {
  version: 1;
  policyVersion: string;
  sourceRevisionId: string;
  promptRevisionId: string;
  memoryRevisionId: string | null;
  sourceSegmentIds: string[];
  chapterPath: string;
  precedingSegments: Array<{ id: string; text: string; contextPath: string }>;
  contextGraph: Record<string, any> | null;
  voiceContext: Record<string, any>;
  contextChars: number;
  contextHash: string;
}

function serializedContext(brief: Pick<TranslationBrief,
  'policyVersion' | 'sourceRevisionId' | 'promptRevisionId' | 'memoryRevisionId' |
  'sourceSegmentIds' | 'chapterPath' | 'precedingSegments' | 'contextGraph' | 'voiceContext'
>): string {
  return JSON.stringify({
    policyVersion: brief.policyVersion,
    sourceRevisionId: brief.sourceRevisionId,
    promptRevisionId: brief.promptRevisionId,
    memoryRevisionId: brief.memoryRevisionId,
    sourceSegmentIds: brief.sourceSegmentIds,
    chapterPath: brief.chapterPath,
    precedingSegments: brief.precedingSegments,
    contextGraph: brief.contextGraph,
    voiceContext: brief.voiceContext,
  });
}

function removeLowestPriorityContext(brief: TranslationBrief): boolean {
  const voice = brief.voiceContext as any;
  const graph = brief.contextGraph as any;
  if (Array.isArray(voice.recentExamples) && voice.recentExamples.length) {
    voice.recentExamples.pop();
    return true;
  }
  if (Array.isArray(voice.voiceAnchors) && voice.voiceAnchors.length) {
    voice.voiceAnchors.pop();
    return true;
  }
  if (Array.isArray(voice.relationshipVoiceRules) && voice.relationshipVoiceRules.length) {
    voice.relationshipVoiceRules.pop();
    return true;
  }
  if (graph && Array.isArray(graph.relationships) && graph.relationships.length) {
    graph.relationships.pop();
    return true;
  }
  if (Array.isArray(voice.relationships) && voice.relationships.length) {
    voice.relationships.pop();
    return true;
  }
  if (graph && Array.isArray(graph.entities) && graph.entities.length) {
    graph.entities.pop();
    return true;
  }
  if (Array.isArray(voice.entities) && voice.entities.length) {
    voice.entities.pop();
    return true;
  }
  if (graph && Array.isArray(graph.characters) && graph.characters.length > 1) {
    graph.characters.pop();
    return true;
  }
  if (Array.isArray(voice.characterVoices) && voice.characterVoices.length > 1) {
    voice.characterVoices.pop();
    return true;
  }
  if (graph && Array.isArray(graph.chapterSummaries) && graph.chapterSummaries.length > 1) {
    graph.chapterSummaries.shift();
    return true;
  }
  if (Array.isArray(voice.chapterSummaries) && voice.chapterSummaries.length > 1) {
    voice.chapterSummaries.shift();
    return true;
  }
  if (brief.precedingSegments.length > 2) {
    brief.precedingSegments.shift();
    return true;
  }
  if (brief.precedingSegments.some((item) => item.text.length > 400)) {
    for (const item of brief.precedingSegments) item.text = item.text.slice(-400);
    return true;
  }
  if (Array.isArray(graph?.styleGuide?.rules) && graph.styleGuide.rules.length) {
    graph.styleGuide.rules.pop();
    return true;
  }
  if (voice.styleGuide && typeof voice.styleGuide === 'object') {
    for (const key of ['avoid', 'diction', 'dialogue', 'rhythm', 'register', 'narrativeVoice']) {
      const value = voice.styleGuide[key];
      if (Array.isArray(value) && value.length) {
        value.pop();
        return true;
      }
      if (typeof value === 'string' && value.length > 120) {
        voice.styleGuide[key] = value.slice(0, 120);
        return true;
      }
    }
  }
  if (brief.precedingSegments.length) {
    brief.precedingSegments.shift();
    return true;
  }
  if (brief.contextGraph) {
    brief.contextGraph = null;
    return true;
  }
  if (Array.isArray(voice.characterVoices) && voice.characterVoices.length) {
    voice.characterVoices.pop();
    return true;
  }
  return false;
}

export function buildTranslationBrief(
  context: any,
  items: BriefSegment[],
  precedingSegments: BriefSegment[] = [],
): TranslationBrief {
  const projectId = String(context?.project?.projectId || '');
  if (!projectId) throw new Error('TranslationBrief 缺少 projectId');
  const sourceRevisionId = String(context?.run?.sourceRevisionId || '');
  const promptRevisionId = String(context?.run?.promptRevisionId || '');
  const memoryRevisionId = typeof context?.memoryRevisionId === 'string' ? context.memoryRevisionId : null;
  const chapterPaths = Array.from(new Set(items.map((item) => String(item.contextPath || '').trim()).filter(Boolean)));
  // Book batches should be chapter-scoped. If callers violate that invariant, omitting summaries is safer.
  const chapterPath = chapterPaths.length === 1 ? chapterPaths[0]! : '';
  const graph = context?.run?.translationMode === 'literary'
    ? buildProjectContextGraphBundle(
        projectId,
        items.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
        precedingSegments.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
      ) as Record<string, any> | null
    : null;
  const voiceContext = context?.run?.translationMode === 'literary'
    ? buildProjectVoiceContext(
        context.memory,
        items.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
        chapterPath || undefined,
        precedingSegments,
      ) as Record<string, any>
    : {};
  // Graph chapter order is derived from source segment order and therefore is the canonical
  // boundary. Do not use memory-only summaries when chapter matching could be ambiguous.
  voiceContext.chapterSummaries = graph && chapterPath ? graph.chapterSummaries : [];
  const brief: TranslationBrief = {
    version: 1,
    policyVersion: TRANSLATION_BRIEF_POLICY_VERSION,
    sourceRevisionId,
    promptRevisionId,
    memoryRevisionId,
    sourceSegmentIds: items.map((item) => item.id),
    chapterPath,
    precedingSegments: precedingSegments.slice(-4).map((item) => ({
      id: item.id,
      text: String(item.text || '').slice(-900),
      contextPath: String(item.contextPath || '').slice(0, 160),
    })),
    contextGraph: graph,
    voiceContext,
    contextChars: 0,
    contextHash: '',
  };
  let serialized = serializedContext(brief);
  while (serialized.length > MAX_TRANSLATION_BRIEF_CHARS && removeLowestPriorityContext(brief)) {
    serialized = serializedContext(brief);
  }
  if (serialized.length > MAX_TRANSLATION_BRIEF_CHARS) {
    // Last-resort safe fallback: keep the batch IDs and a minimal source-near context only.
    brief.contextGraph = null;
    brief.voiceContext = {
      version: 1,
      policyVersion: TRANSLATION_BRIEF_POLICY_VERSION,
      chapterSummaries: [],
      entities: [],
      relationships: [],
      characterVoices: [],
      relationshipVoiceRules: [],
      voiceAnchors: [],
      constraints: [
        '原文优先；不得泄漏后续章节事实。',
        '不得覆盖原文或把未确认候选当成事实。',
      ],
    };
    brief.precedingSegments = brief.precedingSegments.slice(-2).map((item) => ({
      ...item, text: item.text.slice(-300),
    }));
    serialized = serializedContext(brief);
  }
  brief.contextChars = serialized.length;
  brief.contextHash = createHash('sha256').update(serialized, 'utf8').digest('hex');
  return brief;
}

export function summarizeTranslationBrief(brief: TranslationBrief): Record<string, unknown> {
  const graph = brief.contextGraph as any;
  const voice = brief.voiceContext as any;
  const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
  return {
    policyVersion: brief.policyVersion,
    contextHash: brief.contextHash,
    contextChars: brief.contextChars,
    sourceRevisionId: brief.sourceRevisionId,
    promptRevisionId: brief.promptRevisionId,
    memoryRevisionId: brief.memoryRevisionId,
    sourceSegmentCount: brief.sourceSegmentIds.length,
    chapterPath: brief.chapterPath || null,
    precedingSegmentCount: brief.precedingSegments.length,
    knowledgeBoundaryOrdinal: graph?.knowledgeBoundaryOrdinal ?? null,
    graphCharacters: count(graph?.characters),
    graphEntities: count(graph?.entities),
    graphRelationships: count(graph?.relationships),
    graphChapterSummaries: count(graph?.chapterSummaries),
    voiceEntities: count(voice?.entities),
    voiceRelationships: count(voice?.relationships),
    characterVoices: count(voice?.characterVoices),
    relationshipVoiceRules: count(voice?.relationshipVoiceRules),
    voiceAnchors: count(voice?.voiceAnchors),
  };
}
