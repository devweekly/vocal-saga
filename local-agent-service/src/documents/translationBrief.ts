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
  glossary: unknown;
  precedingSegments: Array<{ id: string; text: string; contextPath: string }>;
  contextGraph: Record<string, any> | null;
  voiceContext: Record<string, any>;
  contextChars: number;
  contextHash: string;
}

function normalizedSourceText(value: unknown): string {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function sourceQuoteMatches(source: unknown, quote: unknown): boolean {
  const sourceText = normalizedSourceText(source);
  const quoteText = normalizedSourceText(quote);
  return quoteText.length >= 8 && sourceText.includes(quoteText);
}

function sourceNameMatches(source: unknown, nameInput: unknown): boolean {
  const sourceText = normalizedSourceText(source);
  const name = normalizedSourceText(nameInput);
  if (!sourceText || !name || name.length < 2) return false;
  if (/^[a-z0-9 ._'’-]+$/i.test(name)) {
    const haystack = ' ' + sourceText.replace(/[^a-z0-9]+/gi, ' ').trim() + ' ';
    const needle = name.replace(/[^a-z0-9]+/gi, ' ').trim();
    return needle.length >= 2 && haystack.includes(' ' + needle + ' ');
  }
  return sourceText.includes(name);
}

/**
 * Literary memory is a book-level snapshot, but not all its claims are available at every point
 * in the source. Only evidence whose source ordinal precedes this batch may survive retrieval.
 * Unscoped free-text summaries/examples are removed because they have no trustworthy temporal
 * provenance and could contain late plot revelations.
 */
function buildTemporallyVisibleMemory(
  context: any,
  items: BriefSegment[],
  precedingSegments: BriefSegment[],
): Record<string, any> {
  const projectId = String(context?.project?.projectId || '');
  const revisionId = String(context?.run?.sourceRevisionId || '');
  const store = getDocumentProjectStore();
  const projectContext = store.getProjectContext(projectId);
  const empty = {
    version: 2, entities: [], relationships: [], styleGuide: {},
    chapterSummaries: [], recentExamples: [], characterVoices: [],
    relationshipVoiceRules: [], voiceAnchors: [], openQuestions: [],
  };
  if (!projectId || projectContext.currentSourceRevisionId !== revisionId || !items.length) return empty;

  const rows = projectContext.db.prepare(
    'SELECT segment_id, ordinal, text, context_path FROM source_segments ' +
    'WHERE source_revision_id = ? AND segment_id IN (' + items.map(() => '?').join(',') + ') ' +
    'ORDER BY ordinal'
  ).all(revisionId, ...items.map((item) => item.id)) as any[];
  const itemOrdinals = rows.map((row) => Number(row.ordinal)).filter(Number.isFinite);
  if (!itemOrdinals.length) return empty;
  const firstOrdinal = Math.min(...itemOrdinals);

  const rawMemory = context?.memory && typeof context.memory === 'object'
    ? JSON.parse(JSON.stringify(context.memory)) as Record<string, any>
    : empty;
  const referencedIds = new Set<string>();
  for (const profile of Array.isArray(rawMemory.characterVoices) ? rawMemory.characterVoices : []) {
    for (const evidence of Array.isArray(profile.evidence) ? profile.evidence : []) {
      if (typeof evidence?.segmentId === 'string') referencedIds.add(evidence.segmentId);
    }
    for (const rule of Array.isArray(profile.contrastRules) ? profile.contrastRules : []) {
      for (const id of Array.isArray(rule?.evidenceSegmentIds) ? rule.evidenceSegmentIds : []) {
        if (typeof id === 'string') referencedIds.add(id);
      }
    }
  }
  for (const rule of Array.isArray(rawMemory.relationshipVoiceRules) ? rawMemory.relationshipVoiceRules : []) {
    for (const id of Array.isArray(rule?.evidenceSegmentIds) ? rule.evidenceSegmentIds : []) {
      if (typeof id === 'string') referencedIds.add(id);
    }
  }
  for (const anchor of Array.isArray(rawMemory.voiceAnchors) ? rawMemory.voiceAnchors : []) {
    if (typeof anchor?.segmentId === 'string') referencedIds.add(anchor.segmentId);
  }
  for (const segment of precedingSegments) referencedIds.add(segment.id);

  const ids = Array.from(referencedIds);
  const sourceById = new Map<string, { ordinal: number; text: string; contextPath: string }>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const refRows = projectContext.db.prepare(
      'SELECT segment_id, ordinal, text, context_path FROM source_segments ' +
      'WHERE source_revision_id = ? AND segment_id IN (' + chunk.map(() => '?').join(',') + ')'
    ).all(revisionId, ...chunk) as any[];
    for (const row of refRows) sourceById.set(String(row.segment_id), {
      ordinal: Number(row.ordinal), text: String(row.text || ''), contextPath: String(row.context_path || ''),
    });
  }
  for (const row of rows) sourceById.set(String(row.segment_id), {
    ordinal: Number(row.ordinal), text: String(row.text || ''), contextPath: String(row.context_path || ''),
  });
  const isPrior = (id: unknown) => {
    const source = typeof id === 'string' ? sourceById.get(id) : undefined;
    return !!source && Number.isFinite(source.ordinal) && source.ordinal < firstOrdinal;
  };
  const nameCache = new Map<string, boolean>();
  const appearedBefore = (nameInput: unknown): boolean => {
    const name = String(nameInput || '').trim();
    const key = normalizedSourceText(name);
    if (!key) return false;
    const cached = nameCache.get(key);
    if (cached !== undefined) return cached;
    // SQL narrows the scan; JS enforces whole-name matching for Latin names.
    const candidates = projectContext.db.prepare(
      'SELECT text FROM source_segments WHERE source_revision_id = ? AND ordinal < ? ' +
      'AND instr(lower(text), lower(?)) > 0 ORDER BY ordinal LIMIT 100'
    ).all(revisionId, firstOrdinal, name) as Array<{ text: string }>;
    const matched = candidates.some((row) => sourceNameMatches(row.text, name));
    nameCache.set(key, matched);
    return matched;
  };
  const appearsAsEarlierEvidence = (quoteInput: unknown): boolean => {
    const quote = String(quoteInput || '').trim();
    if (normalizedSourceText(quote).length < 8) return false;
    const candidates = projectContext.db.prepare(
      'SELECT text FROM source_segments WHERE source_revision_id = ? AND ordinal < ? ' +
      'AND instr(lower(text), lower(?)) > 0 ORDER BY ordinal LIMIT 100'
    ).all(revisionId, firstOrdinal, quote) as Array<{ text: string }>;
    return candidates.some((row) => sourceQuoteMatches(row.text, quote));
  };

  rawMemory.entities = (Array.isArray(rawMemory.entities) ? rawMemory.entities : []).flatMap((entity: any) => {
    if (!entity || !appearedBefore(entity.source) || !appearsAsEarlierEvidence(entity.evidence)) return [];
    return [{
      ...entity,
      aliases: (Array.isArray(entity.aliases) ? entity.aliases : []).filter((alias: unknown) => appearedBefore(alias)),
    }];
  });
  rawMemory.relationships = (Array.isArray(rawMemory.relationships) ? rawMemory.relationships : []).filter((relation: any) =>
    relation && appearedBefore(relation.subject) && appearedBefore(relation.object) &&
    appearsAsEarlierEvidence(relation.evidence));

  rawMemory.characterVoices = (Array.isArray(rawMemory.characterVoices) ? rawMemory.characterVoices : []).flatMap((profile: any) => {
    const evidence = (Array.isArray(profile.evidence) ? profile.evidence : []).filter((item: any) => {
      if (!item || !isPrior(item.segmentId)) return false;
      const source = sourceById.get(item.segmentId);
      return !!source && sourceQuoteMatches(source.text, item.sourceQuote);
    });
    if (!evidence.length || !appearedBefore(profile.canonicalSourceName)) return [];
    const aliases = (Array.isArray(profile.aliases) ? profile.aliases : [])
      .filter((alias: unknown) => appearedBefore(alias));
    const contrastRules = (Array.isArray(profile.contrastRules) ? profile.contrastRules : []).filter((rule: any) => {
      const ids = Array.isArray(rule.evidenceSegmentIds) ? rule.evidenceSegmentIds : [];
      return ids.length > 0 && ids.every(isPrior) && rawMemory.characterVoices.some((other: any) =>
        other.characterId === rule.otherCharacterId && appearedBefore(other.canonicalSourceName));
    }).map((rule: any) => ({ ...rule, evidenceSegmentIds: rule.evidenceSegmentIds.filter(isPrior) }));
    return [{ ...profile, aliases, evidence, contrastRules }];
  });
  const visibleCharacterIds = new Set(rawMemory.characterVoices.map((profile: any) => profile.characterId));
  rawMemory.relationshipVoiceRules = (Array.isArray(rawMemory.relationshipVoiceRules) ? rawMemory.relationshipVoiceRules : []).filter((rule: any) => {
    const evidenceIds = Array.isArray(rule.evidenceSegmentIds) ? rule.evidenceSegmentIds : [];
    return evidenceIds.length > 0 && evidenceIds.every(isPrior) &&
      visibleCharacterIds.has(rule.speakerId) && visibleCharacterIds.has(rule.addresseeId);
  });
  rawMemory.voiceAnchors = (Array.isArray(rawMemory.voiceAnchors) ? rawMemory.voiceAnchors : []).filter((voiceAnchor: any) => {
    const source = sourceById.get(String(voiceAnchor?.segmentId || ''));
    return !!source && source.ordinal < firstOrdinal &&
      visibleCharacterIds.has(voiceAnchor.speakerId) && sourceQuoteMatches(source.text, voiceAnchor.source);
  });

  // These book-level strings lack source-positioned citations. Do not let whole-book analysis
  // leak a future plot fact through a field labelled "style", "example", or "summary".
  rawMemory.styleGuide = {};
  rawMemory.chapterSummaries = [];
  rawMemory.recentExamples = [];
  rawMemory.openQuestions = [];
  return rawMemory;
}

function filterGlossaryForBatch(context: any, items: BriefSegment[]): unknown {
  const configured = context?.prompt?.config?.glossary ?? context?.prompt?.glossary ?? null;
  if (context?.run?.translationMode !== 'literary') return configured;
  const empty = { document_terms: [] as unknown[] };
  if (!configured || typeof configured !== 'object' || Array.isArray(configured) || !items.length) return empty;

  const projectId = String(context?.project?.projectId || '');
  const revisionId = String(context?.run?.sourceRevisionId || '');
  const { db, currentSourceRevisionId } = getDocumentProjectStore().getProjectContext(projectId);
  if (!projectId || currentSourceRevisionId !== revisionId) return empty;
  const rows = db.prepare(
    'SELECT ordinal FROM source_segments WHERE source_revision_id = ? AND segment_id IN (' +
      items.map(() => '?').join(',') + ')'
  ).all(revisionId, ...items.map((item) => item.id)) as Array<{ ordinal: number }>;
  const ordinals = rows.map((row) => Number(row.ordinal)).filter(Number.isFinite);
  if (!ordinals.length) return empty;
  const firstOrdinal = Math.min(...ordinals);

  const normalize = (value: unknown) =>
    String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const appearedEarlier = (value: unknown): boolean => {
    const term = String(value || '').trim();
    const key = normalize(term);
    if (key.length < 2) return false;
    const candidates = db.prepare(
      'SELECT text FROM source_segments WHERE source_revision_id = ? AND ordinal < ? ' +
        'AND instr(lower(text), lower(?)) > 0 ORDER BY ordinal LIMIT 100'
    ).all(revisionId, firstOrdinal, term) as Array<{ text: string }>;
    if (/^[a-z0-9 ._'’-]+$/i.test(term)) {
      const needle = key.replace(/[^a-z0-9]+/gi, ' ').trim();
      return needle.length >= 2 && candidates.some((row) => {
        const haystack = ' ' + normalize(row.text).replace(/[^a-z0-9]+/gi, ' ').trim() + ' ';
        return haystack.includes(' ' + needle + ' ');
      });
    }
    return candidates.some((row) => normalize(row.text).includes(key));
  };

  const allowedKeys = [
    'source', 'source_term', 'term', 'original', 'en', 'from',
    'target', 'target_term', 'translation', 'zh', 'to',
    'kind', 'category', 'caseSensitive', 'case_sensitive',
  ];
  const sourceOf = (item: any) => item && typeof item === 'object'
    ? item.source ?? item.source_term ?? item.term ?? item.original ?? item.en ?? item.from
    : item;
  const terms = Array.isArray((configured as any).document_terms) ? (configured as any).document_terms : [];
  return {
    document_terms: terms.flatMap((term: any) => {
      const source = sourceOf(term);
      if (!appearedEarlier(source)) return [];
      if (typeof term === 'string') return [term];
      if (!term || typeof term !== 'object' || Array.isArray(term)) return [];
      const selected: Record<string, unknown> = {};
      for (const key of allowedKeys) {
        const value = term[key];
        if (value !== undefined && (typeof value !== 'object' || value === null)) selected[key] = value;
      }
      for (const key of ['aliases', 'source_aliases', 'sourceAliases']) {
        if (Array.isArray(term[key])) {
          const aliases = term[key].filter((alias: unknown) => appearedEarlier(alias));
          if (key === 'aliases' || aliases.length) selected[key] = aliases;
        }
      }
      return [selected];
    }),
  };
}

function serializedContext(brief: Pick<TranslationBrief,
  'policyVersion' | 'sourceRevisionId' | 'promptRevisionId' | 'memoryRevisionId' |
  'sourceSegmentIds' | 'chapterPath' | 'glossary' | 'precedingSegments' | 'contextGraph' | 'voiceContext'
>): string {
  return JSON.stringify({
    policyVersion: brief.policyVersion,
    sourceRevisionId: brief.sourceRevisionId,
    promptRevisionId: brief.promptRevisionId,
    memoryRevisionId: brief.memoryRevisionId,
    sourceSegmentIds: brief.sourceSegmentIds,
    chapterPath: brief.chapterPath,
    glossary: brief.glossary,
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
  const glossary = brief.glossary as any;
  if (glossary && Array.isArray(glossary.document_terms) && glossary.document_terms.length) {
    glossary.document_terms.pop();
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
  const temporalMemory = context?.run?.translationMode === 'literary'
    ? buildTemporallyVisibleMemory(context, items, precedingSegments)
    : {};
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
        temporalMemory,
        items.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
        chapterPath || undefined,
        precedingSegments,
      ) as Record<string, any>
    : {};
  // Context Graph style notes are book-wide and have no ordinal-bearing evidence links.
  // Keep only per-batch, evidence-bounded characters/entities/relationships and chapter prefix summaries.
  if (graph) {
    graph.styleGuide = { narrativeStyle: '', rules: [] };
    graph.policyVersion = 'context-graph-v2-temporal';
  }
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
