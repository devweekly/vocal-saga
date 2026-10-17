/**
 * 初译阶段的上下文增量契约。
 *
 * 模型只提出有原文证据的候选；本模块负责验证输入片段范围、原文引文和译文落点，
 * 并以保守、可重复的规则合并候选。这里绝不把模型输出提升为人工确认事实。
 */

export type ContextEvidence = { segmentId: string; sourceQuote: string };
export type ContextEntityCandidate = {
  localId: string;
  canonicalSource: string;
  aliases: string[];
  kind: string;
  targetProposal: string;
  evidence: ContextEvidence[];
  reason?: string;
};
export type ContextEntityMention = {
  segmentId: string;
  sourceQuote: string;
  entityRef: string;
  targetSurface: string;
};
export type ContextRelationshipCandidate = {
  subjectSource: string;
  predicate: string;
  objectSource: string;
  evidence: ContextEvidence[];
};
export type ValidatedTranslationContextDelta = {
  entityCandidates: ContextEntityCandidate[];
  entityMentions: ContextEntityMention[];
  relationshipDeltas: ContextRelationshipCandidate[];
  openQuestions: Array<{ question: string; evidence: ContextEvidence[] }>;
  conflicts: Array<{ topic: string; details: string; evidence: ContextEvidence[] }>;
};
export type ContextDeltaDiagnostics = {
  candidateCount: number;
  acceptedEntityCandidates: number;
  rejectedEntityCandidates: number;
  acceptedEntityMentions: number;
  rejectedEntityMentions: number;
  acceptedRelationships: number;
  rejectedRelationships: number;
  acceptedOpenQuestions: number;
  rejectedOpenQuestions: number;
  acceptedConflicts: number;
  rejectedConflicts: number;
};

export function emptyTranslationContextDelta(): ValidatedTranslationContextDelta {
  return { entityCandidates: [], entityMentions: [], relationshipDeltas: [], openQuestions: [], conflicts: [] };
}

function text(value: unknown, limit = 240): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

function normalized(value: unknown): string {
  return text(value, 2000).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function includesNormalized(haystack: unknown, needle: unknown): boolean {
  const source = normalized(haystack);
  const quote = normalized(needle);
  return !!source && !!quote && source.includes(quote);
}

function sourceEvidence(raw: unknown, sourceById: Map<string, string>, minimumLength = 8): ContextEvidence[] {
  if (!Array.isArray(raw)) return [];
  const output: ContextEvidence[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const segmentId = text(row.segment_id ?? row.segmentId, 160);
    const sourceQuote = text(row.quote ?? row.source_quote ?? row.sourceQuote, 240);
    const source = sourceById.get(segmentId);
    if (!source || sourceQuote.length < minimumLength || !includesNormalized(source, sourceQuote)) continue;
    const key = segmentId + '\u0000' + normalized(sourceQuote);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ segmentId, sourceQuote });
  }
  return output;
}

function hasName(source: string, name: string): boolean {
  const value = normalized(name);
  if (!value) return false;
  // Name candidates require explicit evidence. Avoid treating short Latin names as substrings
  // inside ordinary words while retaining natural CJK matching.
  if (/^[a-z0-9 .'-]+$/i.test(value)) {
    const paddedSource = ' ' + normalized(source).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    const paddedName = ' ' + value.replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    return paddedName.trim().length >= 3 && paddedSource.includes(paddedName);
  }
  return normalized(source).includes(value);
}

/** Validate context_delta independently from translations: invalid metadata never discards a valid translation. */
export function validateTranslationContextDelta(
  raw: unknown,
  segments: Array<{ id: string; text: string }>,
  translations: Map<string, string>,
  idPrefix = '',
  knownEntities: unknown[] = [],
): { delta: ValidatedTranslationContextDelta; diagnostics: ContextDeltaDiagnostics } {
  const delta = emptyTranslationContextDelta();
  const diagnostics: ContextDeltaDiagnostics = {
    candidateCount: 0,
    acceptedEntityCandidates: 0, rejectedEntityCandidates: 0,
    acceptedEntityMentions: 0, rejectedEntityMentions: 0,
    acceptedRelationships: 0, rejectedRelationships: 0,
    acceptedOpenQuestions: 0, rejectedOpenQuestions: 0,
    acceptedConflicts: 0, rejectedConflicts: 0,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { delta, diagnostics };
  const value = raw as Record<string, unknown>;
  const sourceById = new Map(segments.map((segment) => [segment.id, segment.text]));
  const candidatesRaw = Array.isArray(value.entity_candidates) ? value.entity_candidates.slice(0, 32) : [];
  diagnostics.candidateCount = candidatesRaw.length;
  const localIds = new Map<string, string>();
  const seenLocalIds = new Set<string>();
  for (const candidateRaw of candidatesRaw) {
    if (!candidateRaw || typeof candidateRaw !== 'object' || Array.isArray(candidateRaw)) {
      diagnostics.rejectedEntityCandidates++;
      continue;
    }
    const candidate = candidateRaw as Record<string, unknown>;
    const originalLocalId = text(candidate.local_id ?? candidate.localId, 64);
    const canonicalSource = text(candidate.canonical_source ?? candidate.canonicalSource, 120);
    const targetProposal = text(candidate.target_proposal ?? candidate.targetProposal, 120);
    const aliasesRaw = Array.isArray(candidate.aliases) ? candidate.aliases.slice(0, 12) : [];
    const kindValue = text(candidate.kind, 40).toLocaleLowerCase();
    const kind = ['character', 'person', 'character_epithet', 'nickname', 'place', 'object', 'title', 'organization', 'group', 'animal', 'role', 'other'].includes(kindValue)
      ? kindValue : 'other';
    const evidence = sourceEvidence(candidate.evidence, sourceById);
    const matchingEvidence = evidence.some((entry) => hasName(entry.sourceQuote, canonicalSource));
    if (!originalLocalId || seenLocalIds.has(originalLocalId) || !canonicalSource || !targetProposal || !evidence.length || !matchingEvidence) {
      diagnostics.rejectedEntityCandidates++;
      continue;
    }
    seenLocalIds.add(originalLocalId);
    const aliases = Array.from(new Set(aliasesRaw.map((alias) => text(alias, 80)).filter((alias) =>
      alias && normalized(alias) !== normalized(canonicalSource) &&
      segments.some((segment) => hasName(segment.text, alias)) &&
      evidence.some((entry) => hasName(entry.sourceQuote, alias)
    )))).slice(0, 8);
    const localId = (idPrefix + originalLocalId).slice(0, 80);
    localIds.set(originalLocalId, localId);
    delta.entityCandidates.push({
      localId, canonicalSource, aliases, kind, targetProposal, evidence,
      ...(text(candidate.reason, 180) ? { reason: text(candidate.reason, 180) } : {}),
    });
    diagnostics.acceptedEntityCandidates++;
  }

  const knownNames = new Set<string>();
  for (const entity of knownEntities.slice(0, 160)) {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)) continue;
    const row = entity as Record<string, unknown>;
    for (const name of [row.source, ...(Array.isArray(row.aliases) ? row.aliases : [])]) {
      if (text(name, 120)) knownNames.add(normalized(name));
    }
  }
  const validRefs = new Set(delta.entityCandidates.flatMap((candidate) =>
    [candidate.localId, candidate.canonicalSource, ...candidate.aliases].map(normalized)));
  for (const mentionRaw of (Array.isArray(value.entity_mentions) ? value.entity_mentions : []).slice(0, 128)) {
    if (!mentionRaw || typeof mentionRaw !== 'object' || Array.isArray(mentionRaw)) {
      diagnostics.rejectedEntityMentions++;
      continue;
    }
    const mention = mentionRaw as Record<string, unknown>;
    const segmentId = text(mention.segment_id ?? mention.segmentId, 160);
    const sourceQuote = text(mention.source_quote ?? mention.sourceQuote, 240);
    const source = sourceById.get(segmentId);
    const targetSurface = text(mention.target_surface ?? mention.targetSurface, 120);
    const rawRef = text(mention.entity_ref ?? mention.entityRef, 120);
    const entityRef = localIds.get(rawRef) || rawRef;
    const translated = translations.get(segmentId) || '';
    const knownRef = validRefs.has(normalized(entityRef)) || knownNames.has(normalized(rawRef));
    if (!source || !sourceQuote || !includesNormalized(source, sourceQuote) || !targetSurface ||
        !includesNormalized(translated, targetSurface) || !knownRef) {
      diagnostics.rejectedEntityMentions++;
      continue;
    }
    delta.entityMentions.push({ segmentId, sourceQuote, entityRef, targetSurface });
    diagnostics.acceptedEntityMentions++;
  }

  const relationshipRaw = Array.isArray(value.relationship_deltas) ? value.relationship_deltas.slice(0, 32) : [];
  for (const relationRaw of relationshipRaw) {
    if (!relationRaw || typeof relationRaw !== 'object' || Array.isArray(relationRaw)) {
      diagnostics.rejectedRelationships++;
      continue;
    }
    const relation = relationRaw as Record<string, unknown>;
    const subjectSource = text(relation.subject_source ?? relation.subjectSource, 120);
    const predicate = text(relation.predicate, 100);
    const objectSource = text(relation.object_source ?? relation.objectSource, 120);
    const evidence = sourceEvidence(relation.evidence, sourceById);
    const hasGroundedRelation = evidence.some((entry) =>
      hasName(sourceById.get(entry.segmentId) || '', subjectSource) &&
      hasName(sourceById.get(entry.segmentId) || '', objectSource));
    if (!subjectSource || !predicate || !objectSource || normalized(subjectSource) === normalized(objectSource) ||
        !evidence.length || !hasGroundedRelation) {
      diagnostics.rejectedRelationships++;
      continue;
    }
    delta.relationshipDeltas.push({ subjectSource, predicate, objectSource, evidence });
    diagnostics.acceptedRelationships++;
  }

  const questionsRaw = Array.isArray(value.open_questions) ? value.open_questions.slice(0, 20) : [];
  for (const questionRaw of questionsRaw) {
    if (!questionRaw || typeof questionRaw !== 'object' || Array.isArray(questionRaw)) {
      diagnostics.rejectedOpenQuestions++;
      continue;
    }
    const question = questionRaw as Record<string, unknown>;
    const cleanQuestion = text(question.question, 200);
    const evidence = sourceEvidence(question.evidence, sourceById);
    if (!cleanQuestion || !evidence.length) {
      diagnostics.rejectedOpenQuestions++;
      continue;
    }
    delta.openQuestions.push({ question: cleanQuestion, evidence });
    diagnostics.acceptedOpenQuestions++;
  }

  const conflictsRaw = Array.isArray(value.conflicts) ? value.conflicts.slice(0, 20) : [];
  for (const conflictRaw of conflictsRaw) {
    if (!conflictRaw || typeof conflictRaw !== 'object' || Array.isArray(conflictRaw)) {
      diagnostics.rejectedConflicts++;
      continue;
    }
    const conflict = conflictRaw as Record<string, unknown>;
    const topic = text(conflict.topic, 120);
    const details = text(conflict.details, 200);
    const evidence = sourceEvidence(conflict.evidence, sourceById);
    if (!topic || !details || !evidence.length) {
      diagnostics.rejectedConflicts++;
      continue;
    }
    delta.conflicts.push({ topic, details, evidence });
    diagnostics.acceptedConflicts++;
  }
  return { delta, diagnostics };
}

/** Combine retry responses for one source batch without letting one retry's IDs shadow another. */
export function combineTranslationContextDeltas(
  deltas: ValidatedTranslationContextDelta[],
): ValidatedTranslationContextDelta {
  const combined = emptyTranslationContextDelta();
  const entityKeyIndex = new Map<string, number>();
  for (const delta of deltas) {
    for (const candidate of delta.entityCandidates) {
      const key = normalized(candidate.canonicalSource) + '\u0000' + normalized(candidate.targetProposal);
      const index = entityKeyIndex.get(key);
      if (index === undefined) {
        entityKeyIndex.set(key, combined.entityCandidates.length);
        combined.entityCandidates.push({ ...candidate, aliases: [...candidate.aliases], evidence: [...candidate.evidence] });
      } else {
        const prior = combined.entityCandidates[index]!;
        prior.aliases = Array.from(new Set([...prior.aliases, ...candidate.aliases])).slice(0, 8);
        prior.evidence = [...prior.evidence, ...candidate.evidence].filter((item, i, all) =>
          all.findIndex((other) => other.segmentId === item.segmentId && normalized(other.sourceQuote) === normalized(item.sourceQuote)) === i).slice(0, 4);
      }
    }
    combined.entityMentions.push(...delta.entityMentions);
    combined.relationshipDeltas.push(...delta.relationshipDeltas);
    combined.openQuestions.push(...delta.openQuestions);
    combined.conflicts.push(...delta.conflicts);
  }
  combined.entityCandidates = combined.entityCandidates.slice(0, 32);
  combined.entityMentions = combined.entityMentions.filter((item, index, all) =>
    all.findIndex((other) => other.segmentId === item.segmentId && normalized(other.sourceQuote) === normalized(item.sourceQuote) &&
      normalized(other.entityRef) === normalized(item.entityRef) && normalized(other.targetSurface) === normalized(item.targetSurface)) === index).slice(0, 128);
  combined.relationshipDeltas = combined.relationshipDeltas.slice(0, 32);
  combined.openQuestions = combined.openQuestions.filter((item, index, all) =>
    all.findIndex((other) => normalized(other.question) === normalized(item.question)) === index).slice(0, 20);
  combined.conflicts = combined.conflicts.slice(0, 20);
  return combined;
}

function sameKind(a: unknown, b: unknown): boolean {
  const left = text(a, 40); const right = text(b, 40);
  return left === right || left === 'other' || right === 'other';
}

/** Build a temporary or persisted memory projection in source order; confirmed mappings are immutable. */
export function mergeTranslationContextDeltasIntoMemory(
  memoryInput: unknown,
  deltas: ValidatedTranslationContextDelta[],
): { memory: Record<string, any>; summary: Record<string, number>; changed: boolean } {
  let memory: Record<string, any>;
  try { memory = JSON.parse(JSON.stringify(memoryInput && typeof memoryInput === 'object' ? memoryInput : {})); }
  catch { memory = {}; }
  if (!Array.isArray(memory.entities)) memory.entities = [];
  if (!Array.isArray(memory.relationships)) memory.relationships = [];
  if (!Array.isArray(memory.openQuestions)) memory.openQuestions = [];
  const before = JSON.stringify(memory);
  const summary = { addedEntities: 0, mergedEntities: 0, entityTargetConflicts: 0, addedRelationships: 0, addedOpenQuestions: 0 };
  const normalizeName = (value: unknown) => normalized(value).replace(/[._'’\-]+/g, ' ').trim();
  const addQuestion = (value: string) => {
    const question = text(value, 200);
    if (!question || memory.openQuestions.some((item: unknown) => normalized(item) === normalized(question))) return;
    memory.openQuestions.push(question);
    memory.openQuestions = memory.openQuestions.slice(-40);
    summary.addedOpenQuestions++;
  };

  for (const delta of deltas) {
    for (const candidate of delta.entityCandidates) {
      const names = new Set([candidate.canonicalSource, ...candidate.aliases].map(normalizeName).filter(Boolean));
      const matching = memory.entities
        .map((entity: any, index: number) => ({ entity, index }))
        .filter(({ entity }: any) => sameKind(entity.kind, candidate.kind) &&
          [entity.source, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]
            .some((name: unknown) => names.has(normalizeName(name))));
      if (!matching.length) {
        memory.entities.push({
          source: candidate.canonicalSource,
          target: candidate.targetProposal,
          kind: candidate.kind,
          aliases: candidate.aliases.slice(0, 8),
          evidence: candidate.evidence[0]?.sourceQuote || '',
          reviewStatus: 'suggested',
        });
        memory.entities = memory.entities.slice(0, 120);
        summary.addedEntities++;
        continue;
      }
      const prior = matching[0]!.entity;
      if (normalizeName(prior.target) !== normalizeName(candidate.targetProposal)) {
        summary.entityTargetConflicts++;
        addQuestion('候选译名存在冲突：“' + candidate.canonicalSource + '”已有“' +
          text(prior.target, 80) + '”，新批次提出“' + candidate.targetProposal + '”；需人工核对原文证据。');
        continue;
      }
      const existingAliases = Array.isArray(prior.aliases) ? prior.aliases : [];
      const aliases = Array.from(new Set([...existingAliases, ...candidate.aliases, candidate.canonicalSource]
        .filter((name) => normalizeName(name) && normalizeName(name) !== normalizeName(prior.source))));
      prior.aliases = aliases.slice(0, 8);
      if (!prior.evidence && candidate.evidence[0]?.sourceQuote) prior.evidence = candidate.evidence[0].sourceQuote;
      summary.mergedEntities++;
    }
    for (const relation of delta.relationshipDeltas) {
      const key = [relation.subjectSource, relation.predicate, relation.objectSource].map(normalizeName).join('\u0000');
      const exists = memory.relationships.some((prior: any) =>
        [prior.subject, prior.predicate, prior.object].map(normalizeName).join('\u0000') === key);
      if (!exists) {
        memory.relationships.push({
          subject: relation.subjectSource, predicate: relation.predicate, object: relation.objectSource,
          evidence: relation.evidence[0]?.sourceQuote || '', reviewStatus: 'suggested',
        });
        memory.relationships = memory.relationships.slice(0, 160);
        summary.addedRelationships++;
      }
    }
    for (const question of delta.openQuestions) {
      addQuestion(question.question + (question.evidence[0]?.sourceQuote ? '（原文：“' + question.evidence[0].sourceQuote.slice(0, 80) + '”）' : ''));
    }
    for (const conflict of delta.conflicts) {
      addQuestion('上下文冲突待核对：' + conflict.topic + '；' + conflict.details +
        (conflict.evidence[0]?.sourceQuote ? '（原文：“' + conflict.evidence[0].sourceQuote.slice(0, 80) + '”）' : ''));
    }
  }
  return { memory, summary, changed: before !== JSON.stringify(memory) };
}
