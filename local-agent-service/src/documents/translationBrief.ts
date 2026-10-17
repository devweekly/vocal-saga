/**
 * One bounded, immutable-in-memory context bundle shared by translation and both reviewers.
 * The persisted snapshot contains references and compact memory, not the full novel or draft text.
 */
import { createHash } from 'node:crypto';
import { buildProjectVoiceContext } from './voiceContext.ts';
import { buildProjectContextGraphBundle } from './contextGraph.ts';
import { getDocumentProjectStore, normalizeDocumentTranslationStrategy } from './projectStore.ts';

export const TRANSLATION_BRIEF_POLICY_VERSION = 'translation-brief-v4-temporal-glossary-boundary';
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
  /** Count of source-ordered context deltas merged for this run-local wave snapshot. */
  contextDeltaCount: number;
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

const firstSourceOccurrenceCache = new Map<string, number>();

function firstMatchingSourceOrdinal(
  db: any,
  revisionId: string,
  termInput: unknown,
  kind: 'name' | 'quote',
): number {
  const term = String(termInput || '').trim();
  const normalizedTerm = normalizedSourceText(term);
  if (!normalizedTerm || (kind === 'quote' && normalizedTerm.length < 8)) return Number.POSITIVE_INFINITY;
  const cacheKey = revisionId + '\u0000' + kind + '\u0000' + normalizedTerm;
  const cached = firstSourceOccurrenceCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const rows = db.prepare(
    'SELECT ordinal, text FROM source_segments WHERE source_revision_id = ? ' +
      'AND instr(lower(text), lower(?)) > 0 ORDER BY ordinal'
  ).all(revisionId, term) as Array<{ ordinal: number; text: string }>;
  const match = rows.find((row) => kind === 'quote'
    ? sourceQuoteMatches(row.text, term)
    : sourceNameMatches(row.text, term));
  const ordinal = match ? Number(match.ordinal) : Number.POSITIVE_INFINITY;
  firstSourceOccurrenceCache.set(cacheKey, ordinal);
  while (firstSourceOccurrenceCache.size > 5000) {
    const oldest = firstSourceOccurrenceCache.keys().next().value;
    if (oldest) firstSourceOccurrenceCache.delete(oldest);
    else break;
  }
  return ordinal;
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
    version: 2, entities: [], relationships: [], styleGuide: {}, styleGuideStatus: 'candidate',
    chapterSummaries: [], recentExamples: [], characterVoices: [],
    relationshipVoiceRules: [], voiceAnchors: [], openQuestions: [],
  };
  const sourceRevisionExists = !!revisionId && !!projectContext.db.prepare(
    'SELECT 1 FROM source_revisions WHERE revision_id = ?'
  ).get(revisionId);
  if (!projectId || !sourceRevisionExists || !items.length) return empty;

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
  for (const entity of Array.isArray(rawMemory.entities) ? rawMemory.entities : []) {
    for (const evidence of Array.isArray(entity?.evidenceRefs) ? entity.evidenceRefs : []) {
      if (typeof evidence?.segmentId === 'string') referencedIds.add(evidence.segmentId);
    }
  }
  for (const relation of Array.isArray(rawMemory.relationships) ? rawMemory.relationships : []) {
    for (const evidence of Array.isArray(relation?.evidenceRefs) ? relation.evidenceRefs : []) {
      if (typeof evidence?.segmentId === 'string') referencedIds.add(evidence.segmentId);
    }
  }
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
  const appearedBefore = (nameInput: unknown): boolean =>
    firstMatchingSourceOrdinal(projectContext.db, revisionId, nameInput, 'name') < firstOrdinal;
  const appearsAsEarlierEvidence = (quoteInput: unknown): boolean =>
    firstMatchingSourceOrdinal(projectContext.db, revisionId, quoteInput, 'quote') < firstOrdinal;

  rawMemory.entities = (Array.isArray(rawMemory.entities) ? rawMemory.entities : []).flatMap((entity: any) => {
    const aliases = Array.isArray(entity?.aliases) ? entity.aliases : [];
    const evidenceRefs = Array.isArray(entity.evidenceRefs) ? entity.evidenceRefs : [];
    // A later-only alias can contaminate the canonical target itself. Do not just remove that
    // alias while keeping a target inferred from the future identity reveal.
    if (aliases.some((alias: unknown) =>
      !appearedBefore(alias) && !items.some((item) => sourceNameMatches(item.text, alias)))) return [];
    // A complete, explicitly confirmed source→target mapping is user-authored authority.
    // It may activate on the first visible mention without model-generated evidence, but must
    // never leak into a batch where neither the source nor an alias is visible.
    const explicitCanonicalMapping = entity?.reviewStatus === 'confirmed' &&
      evidenceRefs.length === 0 && !String(entity?.evidence || '').trim();
    const visibleInCurrentBatch = items.some((item) =>
      sourceNameMatches(item.text, entity?.source) ||
      aliases.some((alias: unknown) => sourceNameMatches(item.text, alias)));
    if (!entity || (!appearedBefore(entity.source) &&
        !(explicitCanonicalMapping && visibleInCurrentBatch))) return [];
    const priorEvidenceRefs = evidenceRefs.filter((ref: any) => {
      if (!ref || !isPrior(ref.segmentId)) return false;
      const source = sourceById.get(ref.segmentId);
      return !!source && sourceQuoteMatches(source.text, ref.sourceQuote) &&
        sourceNameMatches(ref.sourceQuote, entity.source);
    });
    // Dynamic candidates retain their exact source segment. A later observation cannot become
    // visible merely because the same character title happened to occur in an earlier chapter.
    // Legacy/user-authored mappings keep the older quote-based validation when no refs exist.
    const evidenceVisible = explicitCanonicalMapping || (evidenceRefs.length
      ? priorEvidenceRefs.length > 0
      : sourceNameMatches(entity.evidence, entity.source) && appearsAsEarlierEvidence(entity.evidence));
    if (!evidenceVisible) return [];
    const visibleAliases = aliases.filter((alias: unknown) =>
      appearedBefore(alias) || items.some((item) => sourceNameMatches(item.text, alias)));
    return [{
      ...entity,
      aliases: visibleAliases,
      ...(evidenceRefs.length ? { evidenceRefs: priorEvidenceRefs } : {}),
    }];
  });
  rawMemory.relationships = (Array.isArray(rawMemory.relationships) ? rawMemory.relationships : []).flatMap((relation: any) => {
    if (!relation || !appearedBefore(relation.subject) || !appearedBefore(relation.object)) return [];
    const evidenceRefs = Array.isArray(relation.evidenceRefs) ? relation.evidenceRefs : [];
    const priorEvidenceRefs = evidenceRefs.filter((ref: any) => {
      if (!ref || !isPrior(ref.segmentId)) return false;
      const source = sourceById.get(ref.segmentId);
      return !!source && sourceQuoteMatches(source.text, ref.sourceQuote) &&
        sourceNameMatches(ref.sourceQuote, relation.subject) && sourceNameMatches(ref.sourceQuote, relation.object);
    });
    const evidenceVisible = evidenceRefs.length
      ? priorEvidenceRefs.length > 0
      : sourceNameMatches(relation.evidence, relation.subject) &&
        sourceNameMatches(relation.evidence, relation.object) &&
        appearsAsEarlierEvidence(relation.evidence);
    if (!evidenceVisible) return [];
    return [{ ...relation, ...(evidenceRefs.length ? { evidenceRefs: priorEvidenceRefs } : {}) }];
  });

  rawMemory.characterVoices = (Array.isArray(rawMemory.characterVoices) ? rawMemory.characterVoices : []).flatMap((profile: any) => {
    const rawEvidence = Array.isArray(profile.evidence) ? profile.evidence : [];
    // VoiceCore is a summary of its evidence set. If any cited example is from this or a later
    // batch, filtering only that example would still leak a profile synthesized from future voice.
    if (!rawEvidence.length || rawEvidence.some((item: any) => {
      if (!item || !isPrior(item.segmentId)) return true;
      const source = sourceById.get(item.segmentId);
      return !source || !sourceQuoteMatches(source.text, item.sourceQuote);
    })) return [];
    if (!appearedBefore(profile.canonicalSourceName)) return [];
    const aliases = Array.isArray(profile.aliases) ? profile.aliases : [];
    if (aliases.some((alias: unknown) => !appearedBefore(alias))) return [];
    const contrastRules = (Array.isArray(profile.contrastRules) ? profile.contrastRules : []).filter((rule: any) => {
      const ids = Array.isArray(rule.evidenceSegmentIds) ? rule.evidenceSegmentIds : [];
      return ids.length > 0 && ids.every(isPrior) && rawMemory.characterVoices.some((other: any) =>
        other.characterId === rule.otherCharacterId && appearedBefore(other.canonicalSourceName) &&
        (Array.isArray(other.aliases) ? other.aliases : []).every((alias: unknown) => appearedBefore(alias)));
    }).map((rule: any) => ({ ...rule, evidenceSegmentIds: rule.evidenceSegmentIds.filter(isPrior) }));
    return [{ ...profile, aliases, evidence: rawEvidence, contrastRules }];
  });
  const visibleCharacterIds = new Set(rawMemory.characterVoices.map((profile: any) => profile.characterId));
  rawMemory.relationshipVoiceRules = (Array.isArray(rawMemory.relationshipVoiceRules) ? rawMemory.relationshipVoiceRules : [])
    .filter((rule: any) => {
      const evidenceIds = Array.isArray(rule.evidenceSegmentIds) ? rule.evidenceSegmentIds : [];
      return evidenceIds.length > 0 && evidenceIds.every(isPrior) &&
        visibleCharacterIds.has(rule.speakerId) && visibleCharacterIds.has(rule.addresseeId);
    })
    .map((rule: any) => ({
      ...rule,
      addressTerms: (Array.isArray(rule.addressTerms) ? rule.addressTerms : [])
        .filter((term: unknown) => appearedBefore(term)),
      // Scene-dependent register changes often summarize a later arc without segment-level quotes.
      sceneDependentShift: '',
    }));
  rawMemory.voiceAnchors = (Array.isArray(rawMemory.voiceAnchors) ? rawMemory.voiceAnchors : []).filter((voiceAnchor: any) => {
    const source = sourceById.get(String(voiceAnchor?.segmentId || ''));
    return !!source && source.ordinal < firstOrdinal &&
      visibleCharacterIds.has(voiceAnchor.speakerId) && sourceQuoteMatches(source.text, voiceAnchor.source) &&
      sourceNameMatches(source.text, voiceAnchor.source);
  });

  // These book-level strings lack source-positioned citations. Do not let whole-book analysis
  // leak a future plot fact through a field labelled "style", "example", or "summary".
  // Free-form whole-book summaries/examples may reveal future plot. A style guide is safe only
  // after the user explicitly confirms it in the workspace; model suggestions stay out of prompts.
  rawMemory.styleGuide = rawMemory.styleGuideStatus === 'confirmed' ? rawMemory.styleGuide : {};
  rawMemory.styleGuideStatus = rawMemory.styleGuideStatus === 'confirmed' ? 'confirmed' : 'candidate';
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
  const { db } = getDocumentProjectStore().getProjectContext(projectId);
  const sourceRevisionExists = !!projectId && !!db.prepare(
    'SELECT 1 FROM source_revisions WHERE revision_id = ?'
  ).get(revisionId);
  if (!sourceRevisionExists) return empty;
  const rows = db.prepare(
    'SELECT ordinal FROM source_segments WHERE source_revision_id = ? AND segment_id IN (' +
      items.map(() => '?').join(',') + ')'
  ).all(revisionId, ...items.map((item) => item.id)) as Array<{ ordinal: number }>;
  const ordinals = rows.map((row) => Number(row.ordinal)).filter(Number.isFinite);
  if (!ordinals.length) return empty;
  const firstOrdinal = Math.min(...ordinals);

  const appearedEarlier = (value: unknown): boolean =>
    firstMatchingSourceOrdinal(db, revisionId, value, 'name') < firstOrdinal;
  const visibleInBatch = (value: unknown): boolean =>
    items.some((item) => sourceNameMatches(item.text, value));

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
      // A static glossary entry is useful on its first actual occurrence. Only entries whose
      // source name is absent from both the preceding book text and this batch are withheld.
      if (!appearedEarlier(source) && !visibleInBatch(source)) return [];
      if (typeof term === 'string') return [term];
      if (!term || typeof term !== 'object' || Array.isArray(term)) return [];
      const aliasKeys = ['aliases', 'source_aliases', 'sourceAliases'];
      // If any alias is first revealed at/after this batch, the canonical target may itself
      // have been chosen from that reveal. Do not merely remove the alias and retain the target.
      if (aliasKeys.some((key) => Array.isArray(term[key]) &&
          (term[key] as unknown[]).some((alias) => !appearedEarlier(alias) && !visibleInBatch(alias)))) return [];
      const selected: Record<string, unknown> = {};
      for (const key of allowedKeys) {
        const value = term[key];
        if (value !== undefined && (typeof value !== 'object' || value === null)) selected[key] = value;
      }
      for (const key of aliasKeys) {
        if (Array.isArray(term[key])) selected[key] = [...term[key]];
      }
      return [selected];
    }),
  };
}

function serializedContext(brief: Pick<TranslationBrief,
  'policyVersion' | 'sourceRevisionId' | 'promptRevisionId' | 'memoryRevisionId' |
  'sourceSegmentIds' | 'chapterPath' | 'glossary' | 'precedingSegments' | 'contextGraph' | 'voiceContext' | 'contextDeltaCount'
>): string {
  return JSON.stringify({
    policyVersion: brief.policyVersion,
    sourceRevisionId: brief.sourceRevisionId,
    promptRevisionId: brief.promptRevisionId,
    memoryRevisionId: brief.memoryRevisionId,
    contextDeltaCount: brief.contextDeltaCount,
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
    for (const key of ['rules', 'avoid', 'diction', 'dialogue', 'rhythm', 'register', 'narrativeVoice']) {
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
    const graph = brief.contextGraph as any;
    const nameMappings = Array.isArray(graph.nameMappings) ? graph.nameMappings : [];
    if (nameMappings.length) {
      // Once lower-priority graph details have been exhausted, preserve canonical names as the
      // final useful part of the graph. A subsequent call must stop pruning rather than silently
      // discard these mappings; buildTranslationBrief will use its explicit 413 guard if the
      // protected name table itself cannot fit the configured budget.
      const compactGraph = {
        ...(graph.policyVersion ? { policyVersion: graph.policyVersion } : {}),
        knowledgeBoundaryOrdinal: graph.knowledgeBoundaryOrdinal ?? null,
        currentChapter: graph.currentChapter || '',
        nameMappings: nameMappings.slice(0, 16),
        constraints: ['nameMappings contains only names visible in the current or preceding source.'],
      };
      if (JSON.stringify(graph) !== JSON.stringify(compactGraph)) {
        brief.contextGraph = compactGraph;
        return true;
      }
      return false;
    }
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
  const strategy = normalizeDocumentTranslationStrategy(context?.prompt?.config?.translationStrategy);
  const visiblePrecedingSegments = strategy.precedingContextSegments > 0
    ? precedingSegments.slice(-strategy.precedingContextSegments)
    : [];
  const maxBriefChars = Math.min(MAX_TRANSLATION_BRIEF_CHARS, strategy.contextBudgetChars);
  const glossary = filterGlossaryForBatch(context, items);
  const temporalMemory = context?.run?.translationMode === 'literary'
    ? buildTemporallyVisibleMemory(context, items, visiblePrecedingSegments)
    : {};
  const chapterPaths = Array.from(new Set(items.map((item) => String(item.contextPath || '').trim()).filter(Boolean)));
  // Book batches should be chapter-scoped. If callers violate that invariant, omitting summaries is safer.
  const chapterPath = chapterPaths.length === 1 ? chapterPaths[0]! : '';
  let graph = context?.run?.translationMode === 'literary'
    ? buildProjectContextGraphBundle(
        projectId,
        items.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
        visiblePrecedingSegments.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
        sourceRevisionId,
        String(context?.run?.targetLang || 'zh'),
      ) as Record<string, any> | null
    : null;
  if (context?.run?.translationMode === 'literary' && !graph) {
    // A book with no eligible Context Graph nodes can still have an explicit user glossary or
    // source-evidenced LiteraryMemory. The previous null result skipped that entire merge path,
    // so confirmed names silently disappeared from the actual translation request.
    graph = {
      policyVersion: 'context-graph-v5-language-pinned',
      knowledgeBoundaryOrdinal: null,
      currentChapter: chapterPath,
      chapterSummaries: [],
      characters: [],
      entities: [],
      relationships: [],
      nameMappings: [],
      styleGuide: { narrativeStyle: '', rules: [] },
      constraints: ['Only source-visible explicit mappings and evidence-backed memory may be added to this empty graph.'],
    };
  }
  if (graph && Array.isArray(graph.nameMappings)) {
    const sourceText = [...visiblePrecedingSegments, ...items].map((item) => item.text).join('\n');
    const priorSourceText = visiblePrecedingSegments.map((item) => item.text).join('\n');
    const projectContext = getDocumentProjectStore().getProjectContext(projectId);
    const batchRows = projectContext.db.prepare(
      'SELECT ordinal FROM source_segments WHERE source_revision_id = ? AND segment_id IN (' +
        items.map(() => '?').join(',') + ')'
    ).all(sourceRevisionId, ...items.map((item) => item.id)) as Array<{ ordinal: number }>;
    const ordinals = batchRows.map((row) => Number(row.ordinal)).filter(Number.isFinite);
    const firstOrdinal = ordinals.length ? Math.min(...ordinals) : Number.POSITIVE_INFINITY;
    const sourceVisible = (name: unknown) =>
      firstMatchingSourceOrdinal(projectContext.db, sourceRevisionId, name, 'name') < firstOrdinal ||
      sourceNameMatches(sourceText, name);
    const memoryEntities = Array.isArray(context?.memory?.entities) ? context.memory.entities : [];
    const sourceRowCache = new Map<string, { ordinal: number; text: string } | null>();
    const sourceRowFor = (segmentId: unknown) => {
      const id = typeof segmentId === 'string' ? segmentId : '';
      if (!id) return null;
      if (sourceRowCache.has(id)) return sourceRowCache.get(id) || null;
      const row = projectContext.db.prepare(
        'SELECT ordinal, text FROM source_segments WHERE source_revision_id = ? AND segment_id = ?'
      ).get(sourceRevisionId, id) as { ordinal?: number; text?: string } | undefined;
      const value = row && Number.isFinite(Number(row.ordinal))
        ? { ordinal: Number(row.ordinal), text: String(row.text || '') } : null;
      sourceRowCache.set(id, value);
      return value;
    };
    for (const entity of memoryEntities) {
      const source = String(entity?.source || '').trim();
      const target = String(entity?.target || '').trim();
      const evidence = String(entity?.evidence || '').trim();
      const rawAliases = Array.isArray(entity.aliases) ? entity.aliases : [];
      if (!source || !target || (!sourceVisible(source) && !rawAliases.some((alias: unknown) => sourceVisible(alias)))) continue;
      const aliasesVisibleAtBoundary = rawAliases.every((alias: unknown) =>
        firstMatchingSourceOrdinal(projectContext.db, sourceRevisionId, alias, 'name') < firstOrdinal ||
        sourceNameMatches(sourceText, alias));
      // A later-only alias can contaminate the canonical target itself, so do not keep the target
      // while merely dropping that alias. Require the whole identity mapping to be temporally safe.
      if (!aliasesVisibleAtBoundary) continue;
      const visibleEvidenceRefs = (Array.isArray(entity.evidenceRefs) ? entity.evidenceRefs : []).filter((ref: any) => {
        const row = sourceRowFor(ref?.segmentId);
        return !!row && row.ordinal < firstOrdinal &&
          sourceQuoteMatches(row.text, ref?.sourceQuote) &&
          sourceNameMatches(ref.sourceQuote, source);
      });
      // New dynamic memory has segment-specific provenance. Do not fall back to searching the
      // same quotation elsewhere in the book, because duplicate prose can predate the observation.
      // Legacy/user-authored mappings without evidenceRefs retain the source-quote fallback.
      const explicitCanonicalMapping = entity.reviewStatus === 'confirmed' &&
        (!Array.isArray(entity.evidenceRefs) || entity.evidenceRefs.length === 0) && !evidence;
      const evidenceVisible = explicitCanonicalMapping ||
        (Array.isArray(entity.evidenceRefs) && entity.evidenceRefs.length
          ? visibleEvidenceRefs.length > 0
          : !!evidence && (
              firstMatchingSourceOrdinal(projectContext.db, sourceRevisionId, evidence, 'quote') < firstOrdinal ||
              normalizedSourceText(sourceText).includes(normalizedSourceText(evidence))));
      if (!evidenceVisible) continue;
      // The alias must be visible by the start of this batch or in its actual source text;
      // an alias first revealed in a later chapter still cannot activate the mapping.
      const aliases = rawAliases.filter((alias: unknown) =>
        firstMatchingSourceOrdinal(projectContext.db, sourceRevisionId, alias, 'name') < firstOrdinal ||
        sourceNameMatches(sourceText, alias));
      const incoming = {
        source, target, aliases,
        kind: String(entity.kind || 'other'),
        evidenceBacked: true,
        sourceStatus: entity.reviewStatus === 'confirmed' ? 'confirmed-memory' : 'auto',
      };
      const names = new Set([source, ...aliases].map((name) => normalizedSourceText(name)));
      const index = graph.nameMappings.findIndex((mapping: any) =>
        [mapping.source, ...(Array.isArray(mapping.aliases) ? mapping.aliases : [])]
          .some((name: unknown) => names.has(normalizedSourceText(name))));
      if (entity.reviewStatus === 'confirmed') {
        if (index >= 0) graph.nameMappings[index] = { ...graph.nameMappings[index], ...incoming };
        else graph.nameMappings.unshift(incoming);
      } else if (index < 0) {
        graph.nameMappings.push(incoming);
      } else {
        // A source-ordered dynamic candidate outranks an unconfirmed whole-book proposal.
        // Keep an already confirmed Context Graph mapping, but avoid injecting two competing targets.
        const existing = graph.nameMappings[index];
        if (!['confirmed', 'confirmed-memory'].includes(String(existing?.sourceStatus || ''))) {
          graph.nameMappings[index] = { ...existing, ...incoming };
        }
      }
    }
    graph.nameMappings = graph.nameMappings.slice(0, 16);
  }
  const voiceContext = context?.run?.translationMode === 'literary'
    ? buildProjectVoiceContext(
        temporalMemory,
        items.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
        chapterPath || undefined,
        visiblePrecedingSegments,
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
    contextDeltaCount: Math.max(0, Number(context?.contextDeltaCount || 0)),
    sourceSegmentIds: items.map((item) => item.id),
    chapterPath,
    glossary,
    precedingSegments: visiblePrecedingSegments.map((item) => ({
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
  while (serialized.length > maxBriefChars && removeLowestPriorityContext(brief)) {
    serialized = serializedContext(brief);
  }
  if (serialized.length > maxBriefChars) {
    // Last-resort safe fallback: keep the batch IDs, only current/previous-source canonical
    // name mappings, and minimal source-near context. Dropping the whole graph here used to
    // silently disable deterministic glossary enforcement for large books.
    const graph = brief.contextGraph as any;
    const canonicalNameMappings = Array.isArray(graph?.nameMappings) ? graph.nameMappings : [];
    brief.contextGraph = canonicalNameMappings.length ? {
      policyVersion: graph?.policyVersion,
      knowledgeBoundaryOrdinal: graph?.knowledgeBoundaryOrdinal ?? null,
      currentChapter: graph?.currentChapter || '',
      nameMappings: canonicalNameMappings.slice(0, 16),
      constraints: ['nameMappings contains only evidence-backed names visible in the current or preceding source.'],
    } : null;
    brief.glossary = { document_terms: [] };
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
  if (serialized.length > maxBriefChars) {
    throw Object.assign(new Error('TranslationBrief 超过当前上下文预算（' + maxBriefChars + ' 字符），已拒绝发送不受限上下文。'), { status: 413 });
  }
  brief.contextChars = serialized.length;
  brief.contextHash = createHash('sha256').update(serialized, 'utf8').digest('hex');
  return brief;
}

export function summarizeTranslationBrief(brief: TranslationBrief): Record<string, unknown> {
  const graph = brief.contextGraph as any;
  const voice = brief.voiceContext as any;
  const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
  const graphCharacterCount = count(graph?.characters);
  const graphEntityCount = count(graph?.entities);
  const graphRelationshipCount = count(graph?.relationships);
  const voiceCharacterCount = count(voice?.characterVoices);
  const nameMappingCount = count(graph?.nameMappings);
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
    graphCharacters: graphCharacterCount,
    graphEntities: graphEntityCount,
    graphRelationships: graphRelationshipCount,
    graphChapterSummaries: count(graph?.chapterSummaries),
    glossaryTerms: count((brief.glossary as any)?.document_terms),
    voiceEntities: count(voice?.entities),
    voiceRelationships: count(voice?.relationships),
    characterVoices: voiceCharacterCount,
    relationshipVoiceRules: count(voice?.relationshipVoiceRules),
    voiceAnchors: count(voice?.voiceAnchors),
    // Compatibility fields consumed by the Agent Trajectory UI. Keep them aligned with the
    // detailed fields above so the UI doesn't silently display zero for populated context.
    entityCount: graphCharacterCount + graphEntityCount,
    relationshipCount: graphRelationshipCount,
    characterVoiceCount: voiceCharacterCount,
    nameMappingCount,
  };
}
