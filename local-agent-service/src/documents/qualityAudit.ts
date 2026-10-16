/**
 * Book-level deterministic quality audit and paired-run evaluation.
 *
 * Automated checks flag review targets; they do not assert literary correctness and never accept
 * or overwrite translations. Human blind review is recorded separately from deterministic metrics.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { scanBookSegments, type BookScanSegment } from './bookScan.ts';
import { getDocumentProjectStore } from './projectStore.ts';

function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function normalized(value: unknown): string {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizedPhrase(value: unknown): string {
  return normalized(value).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function containsName(source: string, name: string): boolean {
  const candidate = normalized(name);
  if (!candidate) return false;
  if (/^[a-z0-9 ._'’-]+$/i.test(candidate)) {
    const haystack = ' ' + normalized(source).replace(/[^a-z0-9]+/gi, ' ').trim() + ' ';
    const needle = candidate.replace(/[^a-z0-9]+/gi, ' ').trim();
    return needle.length >= 2 && haystack.includes(' ' + needle + ' ');
  }
  return normalized(source).includes(candidate);
}

function targetPresent(translation: string, target: string): boolean {
  const latinTarget = /^[a-z0-9 ._'’-]+$/i.test(target);
  if (latinTarget) {
    const haystack = ' ' + normalized(translation).replace(/[^a-z0-9]+/gi, ' ').trim() + ' ';
    const needle = target.replace(/[^a-z0-9]+/gi, ' ').trim();
    return !needle || haystack.includes(' ' + needle + ' ');
  }
  const needle = normalizedPhrase(target).replace(/\s+/g, '');
  if (!needle) return true;
  const haystack = normalizedPhrase(translation).replace(/\s+/g, '');
  return haystack.includes(needle);
}

function stableFindingId(type: string, ids: string[], detail: string): string {
  let hash = 0x811c9dc5;
  const input = type + ':' + ids.join(',') + ':' + detail;
  for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 0x01000193);
  return 'qf_' + (hash >>> 0).toString(16).padStart(8, '0');
}

function currentSource(projectId: string) {
  const store = getDocumentProjectStore();
  const context = store.getProjectContext(projectId);
  const rows = context.db.prepare(
    'SELECT segment_id AS id, ordinal, text, kind, context_path AS contextPath, source_hash AS sourceHash ' +
    'FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(context.currentSourceRevisionId) as any[];
  return {
    store,
    context,
    segments: rows.map((row) => ({
      id: String(row.id), ordinal: Number(row.ordinal), text: String(row.text), kind: String(row.kind || 'paragraph'),
      contextPath: String(row.contextPath || ''), sourceHash: String(row.sourceHash || ''),
    })),
  };
}

function acceptedTranslations(db: any, revisionId: string): Map<string, string> {
  const rows = db.prepare(
    'SELECT r.segment_id AS id, r.translation_text AS text, r.source_hash AS sourceHash ' +
    'FROM translation_results r JOIN source_segments s ON s.source_revision_id = r.source_revision_id ' +
    'AND s.segment_id = r.segment_id AND s.source_hash = r.source_hash ' +
    'WHERE r.source_revision_id = ? AND r.accepted = 1 ORDER BY r.rowid DESC'
  ).all(revisionId) as any[];
  const result = new Map<string, string>();
  for (const row of rows) if (!result.has(String(row.id))) result.set(String(row.id), String(row.text || ''));
  return result;
}

function overlayRunCandidates(db: any, revisionId: string, runId: string, translations: Map<string, string>): void {
  const run = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as any;
  if (!run) fail('找不到质量审计指定的翻译运行：' + runId, 404);
  if (run.source_revision_id !== revisionId) fail('质量审计的翻译运行不属于当前来源版本，请先对当前版本重新翻译。', 409);
  const rows = db.prepare(
    'SELECT rs.segment_id AS id, rs.source_hash AS sourceHash, r.translation_text AS text ' +
    'FROM run_segments rs LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id ' +
    'WHERE rs.run_id = ?'
  ).all(runId) as any[];
  for (const row of rows) {
    if (typeof row.text === 'string' && row.text.trim()) translations.set(String(row.id), String(row.text));
  }
}

function memoryWithGlossary(memoryInput: Record<string, any>, glossary: unknown): Record<string, any> {
  const memory = memoryInput && typeof memoryInput === 'object' ? memoryInput : {};
  const existing = Array.isArray(memory.entities) ? [...memory.entities] : [];
  const existingSources = new Set(existing.map((item: any) => normalized(item?.source)).filter(Boolean));
  const glossaryObject = glossary && typeof glossary === 'object' && !Array.isArray(glossary)
    ? glossary as Record<string, any> : {};
  const terms = Array.isArray(glossaryObject.document_terms) ? glossaryObject.document_terms : [];
  for (const term of terms) {
    if (!term || typeof term !== 'object' || Array.isArray(term)) continue;
    const source = String(term.source ?? term.source_term ?? term.term ?? term.original ?? term.en ?? term.from ?? '').trim();
    const target = String(term.target ?? term.target_term ?? term.translation ?? term.zh ?? term.to ?? '').trim();
    if (!source || !target) continue;
    if (['candidate', 'suggested', 'rejected'].includes(String(term.reviewStatus || term.status || '').toLowerCase())) continue;
    const key = normalized(source);
    if (existingSources.has(key)) continue;
    existingSources.add(key);
    existing.push({
      source,
      target,
      kind: String(term.kind || term.category || 'other'),
      aliases: Array.isArray(term.aliases) ? term.aliases.filter((value: unknown) => typeof value === 'string').slice(0, 12) : [],
      reviewStatus: 'confirmed',
      evidence: typeof term.evidence === 'string' ? term.evidence : '',
    });
  }
  return { ...memory, entities: existing };
}

function loadMemory(projectId: string, runId?: string): Record<string, any> {
  const store = getDocumentProjectStore();
  if (runId) {
    const context = store.getRunContext(projectId, runId);
    return memoryWithGlossary(context.memory, context.prompt?.config?.glossary);
  }
  const memory = store.getCurrentLiteraryMemory(projectId).memory;
  const { db } = store.getProjectContext(projectId);
  const row = db.prepare('SELECT config_json FROM prompt_revisions ORDER BY created_at DESC LIMIT 1').get() as { config_json?: string } | undefined;
  let glossary: unknown = null;
  try { glossary = row?.config_json ? JSON.parse(row.config_json).glossary : null; } catch { glossary = null; }
  return memoryWithGlossary(memory, glossary);
}

function currentReviewFindings(
  db: any,
  revisionId: string,
  requestedRunId?: string,
): { reviewRunId: string | null; findings: any[] } {
  let reviewRunId = requestedRunId || null;
  if (!reviewRunId) {
    const row = db.prepare(
      'SELECT tr.run_id FROM translation_runs tr ' +
      'WHERE tr.source_revision_id = ? AND tr.review_enabled = 1 ' +
      'AND EXISTS (SELECT 1 FROM review_findings rf WHERE rf.run_id = tr.run_id) ' +
      'ORDER BY tr.finished_at DESC, tr.created_at DESC LIMIT 1'
    ).get(revisionId) as any;
    reviewRunId = row?.run_id || null;
  }
  if (!reviewRunId) return { reviewRunId: null, findings: [] };
  const rows = db.prepare(
    'SELECT rf.finding_id, rf.segment_id, rf.category, rf.priority, rf.finding_json, rf.status, rf.created_at, ' +
    'rs.candidate_result_id, r.translation_text AS reviewed_translation ' +
    'FROM review_findings rf JOIN translation_runs tr ON tr.run_id = rf.run_id ' +
    'LEFT JOIN run_segments rs ON rs.run_id = rf.run_id AND rs.segment_id = rf.segment_id ' +
    'LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id ' +
    'WHERE rf.run_id = ? AND tr.source_revision_id = ? AND rf.category = \\'style\\' ' +
    'ORDER BY rf.finding_id DESC LIMIT 300'
  ).all(reviewRunId, revisionId) as any[];
  const findings = rows.flatMap((row) => {
    const reviewedTranslation = typeof row.reviewed_translation === 'string' ? row.reviewed_translation : null;
    // When auditing accepted text (no runId specified), suppress stale style findings from an
    // older candidate whose translation is no longer the accepted text for this source revision.
    if (!requestedRunId) {
      const accepted = db.prepare(
        'SELECT translation_text FROM translation_results WHERE source_revision_id = ? AND segment_id = ? ' +
        'AND accepted = 1 ORDER BY rowid DESC LIMIT 1'
      ).get(revisionId, String(row.segment_id)) as { translation_text?: string } | undefined;
      if (!accepted || accepted.translation_text !== reviewedTranslation) return [];
    }
    let finding: any = {};
    try { finding = JSON.parse(row.finding_json); } catch { finding = {}; }
    return [{
      findingId: Number(row.finding_id),
      segmentId: String(row.segment_id),
      category: String(row.category),
      priority: String(row.priority),
      status: String(row.status),
      dimension: typeof finding.dimension === 'string' ? finding.dimension : null,
      characterId: typeof finding.characterId === 'string' ? finding.characterId : null,
      sourceExcerpt: String(finding.sourceExcerpt || ''),
      draftExcerpt: String(finding.draftExcerpt || ''),
      evidenceSegmentIds: Array.isArray(finding.evidenceSegmentIds) ? finding.evidenceSegmentIds.filter((id: unknown) => typeof id === 'string').slice(0, 8) : [],
      reason: String(finding.reason || ''),
      suggestion: String(finding.suggestion || ''),
      proposedTranslation: typeof finding.proposedTranslation === 'string' ? finding.proposedTranslation : null,
      reviewedTranslation,
      createdAt: row.created_at,
    }];
  }).reverse();
  return { reviewRunId, findings };
}

function terminologyFindings(
  segments: Array<{ id: string; text: string; contextPath: string }>,
  translations: Map<string, string>,
  memory: Record<string, any>,
) {
  const entities = Array.isArray(memory.entities)
    ? memory.entities.filter((entity: any) => entity?.reviewStatus === 'confirmed' &&
        typeof entity.source === 'string' && typeof entity.target === 'string' && entity.source.trim() && entity.target.trim())
    : [];
  const findings: any[] = [];
  for (const segment of segments) {
    const translation = translations.get(segment.id) || '';
    if (!translation) continue;
    for (const entity of entities) {
      const aliases = [entity.source, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]
        .filter((value: unknown) => typeof value === 'string' && String(value).trim());
      const matchedSource = aliases.find((alias: string) => containsName(segment.text, alias));
      if (!matchedSource || targetPresent(translation, entity.target)) continue;
      findings.push({
        findingId: stableFindingId('terminology-drift', [segment.id], normalized(entity.source) + '>' + normalized(entity.target)),
        type: 'terminology-drift',
        category: 'terminology',
        severity: 'warning',
        confidence: 'heuristic',
        repairable: true,
        segmentIds: [segment.id],
        chapter: segment.contextPath || null,
        sourceExcerpt: segment.text.slice(0, 240),
        translationExcerpt: translation.slice(0, 320),
        entity: { source: entity.source, matchedAlias: matchedSource, target: entity.target },
        explanation: '原文包含已确认实体，但当前译文中未检测到规范译名；请结合语境人工判断是否属于省略、代词替代或真实译名漂移。',
      });
    }
  }
  return findings;
}

function repeatedPhraseKeysFromSegment(sourceText: string): Set<string> {
  const sentences = sourceText.match(/[^.!?\n]+[.!?]?/gu) || [];
  const quoted = Array.from(sourceText.matchAll(/[“"]([^”"]{8,})[”"]/gu), (match) => match[1] || '');
  return new Set([...sentences, ...quoted].map((sentence) => {
    const text = sentence.trim().replace(/^[“”"'‘’\s]+|[“”"'‘’\s]+$/g, '');
    return normalizedPhrase(text);
  }).filter(Boolean));
}

function repeatedExpressionFindings(
  segments: Array<{ id: string; text: string; contextPath: string }>,
  translations: Map<string, string>,
  scopedIds?: Set<string>,
) {
  const scanSegments: BookScanSegment[] = segments.map((segment, index) => ({
    id: segment.id,
    ordinal: index,
    text: segment.text,
    kind: 'paragraph',
    contextPath: segment.contextPath,
  }));
  const scan = scanBookSegments(scanSegments, { maxRepeatedPhraseGroups: 300 });
  const wantedPhrases = new Set(scan.repeatedPhrases.map((phrase) => phrase.normalized));
  const occurrencesByPhrase = new Map<string, string[]>();
  for (const segment of segments) {
    if (scopedIds && !scopedIds.has(segment.id)) continue;
    for (const key of repeatedPhraseKeysFromSegment(segment.text)) {
      if (!wantedPhrases.has(key)) continue;
      const ids = occurrencesByPhrase.get(key) || [];
      ids.push(segment.id);
      occurrencesByPhrase.set(key, ids);
    }
  }
  const findings: any[] = [];
  for (const phrase of scan.repeatedPhrases) {
    // M1 keeps a small ID sample for prompt planning; M3/M4 rebuild the full occurrence index so
    // a variant after the first 16 passages is still found, without rescanning the whole book per phrase.
    const exactIds = occurrencesByPhrase.get(phrase.normalized) || [];
    if (exactIds.length < 2) continue;
    const rows = exactIds.map((id) => ({ id, text: translations.get(id) || '' })).filter((item) => item.text.trim());
    if (rows.length < 2) continue;
    const variants = new Map<string, string[]>();
    for (const row of rows) {
      const key = normalizedPhrase(row.text);
      const ids = variants.get(key) || [];
      ids.push(row.id);
      variants.set(key, ids);
    }
    if (variants.size <= 1) continue;
    const maxListedIds = 500;
    findings.push({
      findingId: stableFindingId('repeated-expression-drift', exactIds.slice(0, 32), phrase.normalized),
      type: 'repeated-expression-drift',
      category: 'consistency',
      severity: 'warning',
      confidence: 'deterministic-source-match',
      repairable: exactIds.length <= 100,
      segmentIds: exactIds.slice(0, maxListedIds),
      occurrenceCount: exactIds.length,
      segmentIdsTruncated: exactIds.length > maxListedIds,
      sourceExcerpt: phrase.text,
      variants: Array.from(variants.entries()).map(([normalizedTranslation, ids]) => ({
        segmentIds: ids.slice(0, maxListedIds),
        occurrenceCount: ids.length,
        segmentIdsTruncated: ids.length > maxListedIds,
        normalizedTranslation,
        sampleTranslation: (rows.find((row) => row.id === ids[0])?.text || '').slice(0, 320),
      })),
      explanation: exactIds.length <= 100
        ? '相同原文表达在不同位置存在不同译法；可能是有意的语境差异，也可能是重复台词或固定表达漂移。'
        : '相同原文表达在大量位置存在译法差异。为避免一键扩大返工，报告只列出前 500 个位置；请从报告中选取具体 segmentIds 进行定点返工。',
    });
  }
  return findings;
}

function runMetrics(projectId: string, runId: string): any {
  const store = getDocumentProjectStore();
  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const context = store.getRunContext(projectId, runId);
  if (context.run.sourceRevisionId !== currentSourceRevisionId) fail('对照评测只支持当前同一来源版本上的运行。', 409);
  const sourceRows = db.prepare(
    'SELECT ss.segment_id AS id, ss.ordinal, ss.text, ss.kind, ss.context_path AS contextPath ' +
    'FROM run_segments rs JOIN source_segments ss ON ss.segment_id = rs.segment_id ' +
    'AND ss.source_revision_id = ? WHERE rs.run_id = ? ORDER BY ss.ordinal'
  ).all(currentSourceRevisionId, runId) as any[];
  if (!sourceRows.length) fail('运行没有可比较的片段。', 409);
  const resultRows = db.prepare(
    'SELECT rs.segment_id AS id, rs.status, r.translation_text AS text ' +
    'FROM run_segments rs LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id WHERE rs.run_id = ?'
  ).all(runId) as any[];
  const translationById = new Map<string, string>();
  const statusById = new Map<string, string>();
  for (const row of resultRows) {
    statusById.set(String(row.id), String(row.status));
    if (typeof row.text === 'string' && row.text.trim()) translationById.set(String(row.id), String(row.text));
  }
  const segments = sourceRows.map((row) => ({
    id: String(row.id), ordinal: Number(row.ordinal), text: String(row.text),
    kind: String(row.kind || 'paragraph'), contextPath: String(row.contextPath || ''),
  }));
  const normalizedSegments = segments.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath }));
  const entities = terminologyFindings(
    normalizedSegments,
    translationById,
    memoryWithGlossary(context.memory, context.prompt?.config?.glossary),
  ).filter((item) => item.category === 'terminology');
  const scopedIds = new Set(segments.map((item) => item.id));
  const repeated = repeatedExpressionFindings(normalizedSegments, translationById, scopedIds);
  const findings = db.prepare('SELECT category, finding_json FROM review_findings WHERE run_id = ?').all(runId) as any[];
  const styleFindings = findings.filter((row) => row.category === 'style').length;
  const voiceFindings = findings.filter((row) => {
    if (row.category !== 'style') return false;
    try { return JSON.parse(row.finding_json).dimension === 'character_voice'; } catch { return false; }
  }).length;
  const eventRows = db.prepare('SELECT event_type, payload_json FROM project_events WHERE run_id = ? ORDER BY event_id').all(runId) as any[];
  const events = eventRows.map((row) => ({ type: String(row.event_type), payload: (() => { try { return JSON.parse(row.payload_json); } catch { return {}; } })() }));
  const translationCalls = events.filter((event) => event.type === 'batch.prompt.ready').length;
  const reviewCalls = events.filter((event) => event.type === 'stage.started' && ['review', 'style-review'].includes(String(event.payload.stage))).length;
  const translationInputChars = events.filter((event) => event.type === 'batch.prompt.ready').reduce((sum, event) =>
    sum + Number(event.payload.userPromptChars || 0) + Number(event.payload.systemPromptChars || 0), 0);
  const reviewerInputChars = events.filter((event) => ['stage.completed', 'stage.warning'].includes(event.type) && ['review', 'style-review'].includes(String(event.payload.stage)))
    .reduce((sum, event) => sum + Number(event.payload.promptChars || 0) + Number(event.payload.systemPromptChars || 0), 0);
  const durationMs = events.filter((event) =>
    event.type === 'batch.model.response' || event.type === 'model.call.failed' ||
    ['stage.completed', 'stage.warning'].includes(event.type) && ['review', 'style-review'].includes(String(event.payload.stage))
  ).reduce((sum, event) => sum + Number(event.payload.durationMs || 0), 0);
  const missing = segments.filter((segment) => !translationById.get(segment.id)?.trim()).length;
  const coverage = segments.length ? Math.round(((segments.length - missing) / segments.length) * 1000) / 10 : 100;
  const ratePer100 = (count: number) => segments.length ? Math.round(count / segments.length * 1000) / 10 : 0;
  return {
    runId,
    sourceRevisionId: currentSourceRevisionId,
    promptRevisionId: context.run.promptRevisionId,
    memoryRevisionId: context.run.literaryMemoryRevisionId,
    sourceLang: context.run.sourceLang,
    targetLang: context.run.targetLang,
    provider: context.run.provider,
    model: context.run.model,
    translationMode: context.run.translationMode,
    reviewEnabled: context.run.reviewEnabled,
    status: context.run.status,
    segmentIds: segments.map((item) => item.id),
    metrics: {
      segmentCount: segments.length,
      translatedSegmentCount: segments.length - missing,
      missingTranslationCount: missing,
      missingTranslationRatePer100Segments: ratePer100(missing),
      coveragePercent: coverage,
      terminologyDriftCount: entities.length,
      terminologyDriftRatePer100Segments: ratePer100(entities.length),
      repeatedExpressionDriftGroups: repeated.length,
      repeatedExpressionDriftRatePer100Segments: ratePer100(repeated.length),
      styleFindingCount: styleFindings,
      styleFindingRatePer100Segments: ratePer100(styleFindings),
      characterVoiceFindingCount: voiceFindings,
      characterVoiceFindingRatePer100Segments: ratePer100(voiceFindings),
      translationRequestCount: translationCalls,
      reviewerRequestCount: reviewCalls,
      totalPipelineRequestCount: translationCalls + reviewCalls,
      translationPromptChars: translationInputChars,
      reviewerPromptCharsKnown: reviewerInputChars,
      totalPromptCharsKnown: translationInputChars + reviewerInputChars,
      modelDurationMsKnown: durationMs,
      tokenAndBillingCostsAvailable: false,
    },
    findings: [...entities, ...repeated],
  };
}

export function runProjectQualityAudit(projectId: string, runId?: string): Record<string, any> {
  const { store, context, segments } = currentSource(projectId);
  if (!segments.length) fail('当前来源版本没有可审计的片段。', 409);
  const active = context.db.prepare(
    "SELECT run_id FROM translation_runs WHERE status IN ('queued','running','paused','partial') LIMIT 1"
  ).get() as { run_id?: string } | undefined;
  if (active?.run_id && (!runId || runId === active.run_id)) {
    fail('当前翻译运行仍在执行或暂停中，请等待完成后审计；若需检查候选结果，请提供已结束的 runId。', 409);
  }
  if (runId) {
    const requestedRun = context.db.prepare('SELECT status FROM translation_runs WHERE run_id = ?').get(runId) as { status?: string } | undefined;
    if (!requestedRun) fail('找不到质量审计指定的翻译运行：' + runId, 404);
    if (!['completed', 'awaiting_acceptance'].includes(String(requestedRun.status))) {
      fail('只有已完成或等待采纳的运行可以作为审计候选来源。', 409);
    }
  }
  const translations = acceptedTranslations(context.db, context.currentSourceRevisionId);
  if (runId) overlayRunCandidates(context.db, context.currentSourceRevisionId, runId, translations);
  const memory = loadMemory(projectId, runId);
  const missing = segments.filter((segment) => !translations.get(segment.id)?.trim()).map((segment) => ({
    findingId: stableFindingId('missing-translation', [segment.id], context.currentSourceRevisionId),
    type: 'missing-translation',
    category: 'coverage',
    severity: 'must-fix',
    repairable: true,
    segmentIds: [segment.id],
    chapter: segment.contextPath || null,
    sourceExcerpt: segment.text.slice(0, 240),
    explanation: '该来源片段没有当前可用的已采纳译文或本次运行候选译文。',
  }));
  const termFindings = terminologyFindings(segments, translations, memory);
  const repeatedFindings = repeatedExpressionFindings(segments, translations);
  const review = currentReviewFindings(context.db, context.currentSourceRevisionId, runId);
  const presentIds = new Set(segments.map((segment) => segment.id));
  const reviewFindings = review.findings.filter((finding) => presentIds.has(finding.segmentId)).map((finding) => ({
    findingId: 'review_' + finding.findingId,
    type: finding.category === 'accuracy'
      ? 'accuracy-review'
      : finding.category === 'terminology'
        ? 'reviewer-terminology-review'
        : finding.dimension === 'character_voice' ? 'character-voice-review' : 'style-review',
    category: finding.category,
    severity: finding.priority === 'must_fix' ? 'must-fix' : 'review',
    repairable: true,
    segmentIds: [finding.segmentId],
    reviewRunId: review.reviewRunId,
    status: finding.status,
    dimension: finding.dimension,
    characterId: finding.characterId,
    sourceExcerpt: finding.sourceExcerpt,
    draftExcerpt: finding.draftExcerpt || finding.reviewedTranslation,
    evidenceSegmentIds: finding.evidenceSegmentIds,
    reason: finding.reason,
    suggestion: finding.suggestion,
    proposedTranslation: finding.proposedTranslation,
  }));
  const findings = [...missing, ...termFindings, ...repeatedFindings, ...reviewFindings];
  const auditId = randomUUID();
  const translatedCount = segments.length - missing.length;
  const ratePer100 = (count: number) => segments.length ? Math.round(count / segments.length * 1000) / 10 : 0;
  const report = {
    auditId,
    projectId,
    sourceRevisionId: context.currentSourceRevisionId,
    runId: runId || null,
    reviewRunId: review.reviewRunId,
    createdAt: new Date().toISOString(),
    metrics: {
      sourceSegmentCount: segments.length,
      translatedSegmentCount: translatedCount,
      missingTranslationCount: missing.length,
      missingTranslationRatePer100Segments: ratePer100(missing.length),
      coveragePercent: segments.length ? Math.round(translatedCount / segments.length * 1000) / 10 : 100,
      terminologyDriftCount: termFindings.length,
      terminologyDriftRatePer100Segments: ratePer100(termFindings.length),
      repeatedExpressionDriftGroups: repeatedFindings.length,
      repeatedExpressionDriftRatePer100Segments: ratePer100(repeatedFindings.length),
      accuracyReviewFindingCount: reviewFindings.filter((item) => item.category === 'accuracy').length,
      reviewerTerminologyFindingCount: reviewFindings.filter((item) => item.category === 'terminology').length,
      styleReviewFindingCount: reviewFindings.filter((item) => item.category === 'style').length,
      styleFindingRatePer100Segments: ratePer100(reviewFindings.filter((item) => item.category === 'style').length),
      characterVoiceFindingCount: reviewFindings.filter((item) => item.type === 'character-voice-review').length,
      characterVoiceFindingRatePer100Segments: ratePer100(reviewFindings.filter((item) => item.type === 'character-voice-review').length),
      repairableFindingCount: findings.filter((item) => item.repairable).length,
    },
    interpretation: [
      '遗漏检查为确定性检查。',
      '术语漂移是基于已确认规范译名的启发式提示；未出现规范译名不一定代表错误。',
      '重复表达只对重复源文片段的译文差异提示复核，不自动统一。',
      '准确性/遗漏、术语、人物声线与文风提示来自已有 Reviewer 发现；若没有运行相应审校，报告不能证明该类问题不存在。',
      '所有修订都进入新的候选 Run，不自动覆盖已采纳或人工修改的译文。',
    ],
    findings,
  };
  store.saveQualityAudit(projectId, report);
  store.appendEvent(projectId, runId || null, 'quality-audit.completed', {
    auditId, sourceRevisionId: context.currentSourceRevisionId, metrics: report.metrics,
  });
  return report;
}

export function createQualityRepairRun(projectId: string, auditId: string, selectedFindingIds: string[], requestedSegmentIds: string[] = []): any {
  const store = getDocumentProjectStore();
  const report = store.getQualityAudit(projectId, auditId) as any;
  if (!report) fail('找不到质量审计报告：' + auditId, 404);
  const { currentSourceRevisionId } = store.getProjectContext(projectId);
  if (report.sourceRevisionId !== currentSourceRevisionId) fail('来源版本已变化，旧质量报告不能用于返工。', 409);
  const wantedFindings = new Set(selectedFindingIds);
  // Explicit segment IDs mean a genuinely narrow repair. They must not expand to every segment
  // in a repeated-expression group simply because that segment belongs to the same finding.
  const segments = new Set<string>(requestedSegmentIds.map(String).filter(Boolean));
  if (!requestedSegmentIds.length) {
    for (const finding of report.findings || []) {
      if (!wantedFindings.has(finding.findingId)) continue;
      if (!finding.repairable) {
        fail('该质量发现涉及较多片段，为避免扩大返工，请显式提供要修改的 segmentIds。');
      }
      for (const id of finding.segmentIds || []) segments.add(String(id));
    }
  }
  if (!segments.size) fail('没有选中可返工的质量发现；请提供报告中的 findingId 或 segmentId。');
  const currentIds = new Set((store.getProjectContext(projectId).db.prepare(
    'SELECT segment_id FROM source_segments WHERE source_revision_id = ?'
  ).all(currentSourceRevisionId) as any[]).map((row) => String(row.segment_id)));
  const selected = Array.from(segments).filter((id) => currentIds.has(id));
  if (!selected.length) fail('选定的返工片段不属于当前来源版本。', 409);
  const run = store.createRun(projectId, {
    scope: { type: 'ids', ids: selected },
    ...(report.runId ? { parentRunId: report.runId } : {}),
  });
  store.appendEvent(projectId, run.runId, 'quality-repair.planned', {
    auditId, parentRunId: report.runId || null, segmentIds: selected,
    humanAcceptanceRequired: true,
  });
  return { auditId, run, segmentIds: selected, humanAcceptanceRequired: true };
}

function runComparisonData(projectId: string, runId: string) {
  const store = getDocumentProjectStore();
  const metrics = runMetrics(projectId, runId);
  const context = store.getRunContext(projectId, runId);
  const { db } = store.getProjectContext(projectId);
  const translations = new Map<string, string>();
  const rows = db.prepare(
    'SELECT rs.segment_id AS id, r.translation_text AS text FROM run_segments rs ' +
    'LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id WHERE rs.run_id = ?'
  ).all(runId) as any[];
  for (const row of rows) if (typeof row.text === 'string' && row.text.trim()) translations.set(String(row.id), String(row.text));
  return { metrics, context, translations };
}

export function createProjectQualityEvaluation(projectId: string, beforeRunId: string, afterRunId: string): Record<string, any> {
  if (!beforeRunId || !afterRunId || beforeRunId === afterRunId) fail('必须提供两个不同的 beforeRunId 和 afterRunId。');
  const store = getDocumentProjectStore();
  const before = runComparisonData(projectId, beforeRunId);
  const after = runComparisonData(projectId, afterRunId);
  if (before.metrics.sourceRevisionId !== after.metrics.sourceRevisionId) fail('前后运行的来源版本不同，不能作有效对照。', 409);
  if (before.metrics.targetLang !== after.metrics.targetLang || before.context.run.sourceLang !== after.context.run.sourceLang) {
    fail('前后运行的源语言或目标语言不同，不能作有效对照。', 409);
  }
  if (before.metrics.translationMode !== after.metrics.translationMode) {
    fail('前后运行的翻译模式不同，不能作有效对照。', 409);
  }
  const comparableStatuses = new Set(['completed', 'awaiting_acceptance']);
  if (!comparableStatuses.has(before.metrics.status) || !comparableStatuses.has(after.metrics.status)) {
    fail('前后运行必须已完成翻译和审校并进入 completed 或 awaiting_acceptance；不能比较仍在运行、暂停或取消的结果。', 409);
  }
  const afterIdSet = new Set<string>(after.metrics.segmentIds);
  if (before.metrics.segmentIds.length !== after.metrics.segmentIds.length ||
      before.metrics.segmentIds.some((id: string) => !afterIdSet.has(id))) {
    fail('前后运行的片段范围不同；为了可比性，必须使用同一来源版本和相同片段集合。', 409);
  }
  const beforeIds = new Set(before.metrics.segmentIds);
  const segmentsRows = store.getProjectContext(projectId).db.prepare(
    'SELECT segment_id AS id, ordinal, text, context_path AS contextPath FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(before.metrics.sourceRevisionId) as any[];
  const sourceById = new Map(segmentsRows.map((row) => [String(row.id), row]));
  const candidateIds = before.metrics.segmentIds.filter((id: string) =>
    before.translations.get(id) !== after.translations.get(id));
  const prioritized = candidateIds;
  const maxBlindItems = 40;
  const maxSamples = Math.min(maxBlindItems, prioritized.length);
  const byChapter = new Map<string, string[]>();
  for (const id of prioritized) {
    const segment = sourceById.get(id);
    if (!segment) continue;
    const chapter = String(segment.contextPath || '');
    const list = byChapter.get(chapter) || [];
    list.push(id);
    byChapter.set(chapter, list);
  }
  const chapterEntries = Array.from(byChapter.entries());
  const selected = new Set<string>();
  // Reserve one sample per evenly spaced chapter first, then use evenly spaced remaining
  // changed segments. This prevents long novels from sampling only the first 40 chapters.
  const chapterSlots = Math.min(maxSamples, chapterEntries.length);
  for (let i = 0; i < chapterSlots; i++) {
    const chapterIndex = Math.floor(i * chapterEntries.length / chapterSlots);
    const representative = chapterEntries[chapterIndex]?.[1]?.[0];
    if (representative) selected.add(representative);
  }
  const remainingIds = prioritized.filter((id: string) => !selected.has(id));
  const additionalSlots = Math.min(maxSamples - selected.size, remainingIds.length);
  for (let i = 0; i < additionalSlots; i++) {
    const index = Math.floor(i * remainingIds.length / additionalSlots);
    selected.add(remainingIds[index]!);
  }
  const blindMapping: Record<string, { A: 'before' | 'after'; B: 'before' | 'after' }> = {};
  const blindPacket = Array.from(selected).map((id) => {
    const source = sourceById.get(id)!;
    const beforeText = before.translations.get(id) || '';
    const afterText = after.translations.get(id) || '';
    const swap = randomInt(2) === 1;
    const mapping = { A: swap ? 'after' as const : 'before' as const, B: swap ? 'before' as const : 'after' as const };
    blindMapping[id] = mapping;
    return {
      segmentId: id,
      chapter: String(source.contextPath || ''),
      source: String(source.text || ''),
      variantA: mapping.A === 'before' ? beforeText : afterText,
      variantB: mapping.B === 'before' ? beforeText : afterText,
    };
  });
  const metricKeys = [
    'missingTranslationCount', 'missingTranslationRatePer100Segments', 'coveragePercent', 'terminologyDriftCount',
    'terminologyDriftRatePer100Segments', 'repeatedExpressionDriftGroups', 'repeatedExpressionDriftRatePer100Segments',
    'styleFindingCount', 'styleFindingRatePer100Segments', 'characterVoiceFindingCount', 'characterVoiceFindingRatePer100Segments',
    'totalPipelineRequestCount', 'totalPromptCharsKnown', 'modelDurationMsKnown',
  ];
  const delta: Record<string, number> = {};
  for (const key of metricKeys) {
    const a = Number(before.metrics.metrics[key] || 0);
    const b = Number(after.metrics.metrics[key] || 0);
    delta[key] = Math.round((b - a) * 100) / 100;
  }
  const evaluationId = randomUUID();
  const report: any = {
    evaluationId,
    projectId,
    sourceRevisionId: before.metrics.sourceRevisionId,
    beforeRunId,
    afterRunId,
    createdAt: new Date().toISOString(),
    comparable: true,
    deterministic: {
      configuration: {
        before: {
          sourceLang: before.metrics.sourceLang, targetLang: before.metrics.targetLang,
          provider: before.metrics.provider, model: before.metrics.model,
          translationMode: before.metrics.translationMode, reviewEnabled: before.metrics.reviewEnabled,
          promptRevisionId: before.metrics.promptRevisionId, memoryRevisionId: before.metrics.memoryRevisionId,
          status: before.metrics.status,
        },
        after: {
          sourceLang: after.metrics.sourceLang, targetLang: after.metrics.targetLang,
          provider: after.metrics.provider, model: after.metrics.model,
          translationMode: after.metrics.translationMode, reviewEnabled: after.metrics.reviewEnabled,
          promptRevisionId: after.metrics.promptRevisionId, memoryRevisionId: after.metrics.memoryRevisionId,
          status: after.metrics.status,
        },
      },
      before: before.metrics.metrics,
      after: after.metrics.metrics,
      deltaAfterMinusBefore: delta,
      improvementSignals: {
        missingTranslationsDecreased: delta.missingTranslationCount < 0,
        terminologyWarningsDecreased: delta.terminologyDriftCount < 0,
        repeatedExpressionWarningsDecreased: delta.repeatedExpressionDriftGroups < 0,
        coverageIncreased: delta.coveragePercent > 0,
      },
      runDisclosure: null as null | { beforeRunId: string; afterRunId: string },
    },
    blindReview: {
      status: blindPacket.length ? 'pending' : 'not_applicable',
      sampleCount: blindPacket.length,
      instruction: blindPacket.length
        ? '请先对照原文盲评 A/B，不要查阅运行 ID；每个样本只比较给定维度，不预设修订版本一定更好。A/B 位置已按样本独立随机化。'
        : '前后运行的目标译文完全相同，没有可进行文本偏好盲评的样本；仅报告覆盖率、审校发现与可用成本指标。',
      packet: blindPacket,
      result: blindPacket.length ? null : { reason: 'no_translation_differences' },
    },
  };
  if (!blindPacket.length) report.deterministic.runDisclosure = { beforeRunId, afterRunId };
  store.saveQualityEvaluation(projectId, report, blindMapping, []);
  store.appendEvent(projectId, afterRunId, 'quality-evaluation.created', {
    evaluationId, beforeRunId, afterRunId, sampleCount: blindPacket.length,
    costMetrics: {
      beforePipelineRequests: before.metrics.metrics.totalPipelineRequestCount,
      afterPipelineRequests: after.metrics.metrics.totalPipelineRequestCount,
      beforeDurationMs: before.metrics.metrics.modelDurationMsKnown,
      afterDurationMs: after.metrics.metrics.modelDurationMsKnown,
    },
  });
  return {
    evaluationId,
    sourceRevisionId: report.sourceRevisionId,
    comparable: true,
    blindReview: report.blindReview,
    ...(blindPacket.length ? {
      instruction: '在完成盲评之前不返回 before/after 对照指标或 A/B 对应关系。',
    } : {
      deterministic: report.deterministic,
      beforeRunId,
      afterRunId,
    }),
  };
}

export function submitProjectQualityEvaluationReviews(
  projectId: string,
  evaluationId: string,
  reviewsInput: unknown,
): Record<string, any> {
  if (!Array.isArray(reviewsInput) || !reviewsInput.length || reviewsInput.length > 80) {
    fail('reviews 必须是 1-80 条人工盲评记录。');
  }
  const store = getDocumentProjectStore();
  const loaded = store.getQualityEvaluation(projectId, evaluationId) as any;
  if (!loaded) fail('找不到质量对照评测：' + evaluationId, 404);
  const report = loaded.report as any;
  if (report.blindReview?.status !== 'pending') fail('当前质量评测不处于待盲评状态。', 409);
  const allowed = new Set<string>((report.blindReview.packet || []).map((item: any) => String(item.segmentId)));
  const reviews: any[] = Array.isArray(loaded.blindReviews) ? [...loaded.blindReviews] : [];
  const existing = new Map(reviews.map((item) => [item.segmentId + ':' + item.dimension, item]));
  for (const raw of reviewsInput) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const segmentId = String((raw as any).segmentId || '');
    const dimension = ['overall', 'accuracy', 'terminology', 'voice', 'style'].includes((raw as any).dimension)
      ? String((raw as any).dimension) : 'overall';
    const preference = String((raw as any).preference || '');
    if (!allowed.has(segmentId)) fail('盲评包含不在评测样本中的片段：' + segmentId);
    if (!['A', 'B', 'tie', 'cannot_judge'].includes(preference)) fail('preference 必须为 A、B、tie 或 cannot_judge。');
    const item = {
      segmentId, dimension, preference,
      confidence: ['low', 'medium', 'high'].includes((raw as any).confidence) ? String((raw as any).confidence) : 'medium',
      comment: typeof (raw as any).comment === 'string' ? String((raw as any).comment).slice(0, 500) : '',
    };
    existing.set(segmentId + ':' + dimension, item);
  }
  reviews.splice(0, reviews.length, ...Array.from(existing.values()));
  const packetIds = (report.blindReview.packet || []).map((item: any) => String(item.segmentId));
  const overallBySegment = new Map(reviews.filter((item) => item.dimension === 'overall').map((item) => [item.segmentId, item.preference]));
  const complete = packetIds.every((id: string) => overallBySegment.has(id));
  if (complete) {
    const mapping = loaded.blindMapping;
    const summarizePreferences = (items: any[]) => {
      let beforeWins = 0, afterWins = 0, ties = 0, cannotJudge = 0;
      for (const item of items) {
        const preference = item.preference;
        if (preference === 'tie') ties++;
        else if (preference === 'cannot_judge') cannotJudge++;
        else if (mapping[item.segmentId]?.[preference] === 'before') beforeWins++;
        else if (mapping[item.segmentId]?.[preference] === 'after') afterWins++;
      }
      const decided = beforeWins + afterWins;
      return {
        beforeWins, afterWins, ties, cannotJudge,
        decidedPreferenceCount: decided,
        afterPreferred: afterWins > beforeWins,
        afterWinRateAmongDecided: decided ? Math.round(afterWins / decided * 1000) / 10 : null,
      };
    };
    const dimensions = ['overall', 'accuracy', 'terminology', 'voice', 'style'];
    const preferenceByDimension = Object.fromEntries(dimensions.map((dimension) => [
      dimension,
      summarizePreferences(reviews.filter((item) => item.dimension === dimension)),
    ]));
    report.blindReview = {
      ...report.blindReview,
      status: 'completed',
      result: {
        ...summarizePreferences(reviews.filter((item) => item.dimension === 'overall')),
        preferenceByDimension,
      },
    };
    report.blindReview.packet = [];
    report.deterministic.runDisclosure = { beforeRunId: report.beforeRunId, afterRunId: report.afterRunId };
  } else {
    report.blindReview = { ...report.blindReview, status: 'pending', completedOverallRatings: overallBySegment.size };
  }
  store.saveQualityEvaluation(projectId, report, loaded.blindMapping, reviews);
  return {
    evaluationId,
    blindReview: report.blindReview,
    ...(complete ? { deterministic: report.deterministic, beforeRunId: report.beforeRunId, afterRunId: report.afterRunId } : {}),
  };
}

export function getProjectQualityEvaluation(projectId: string, evaluationId: string): Record<string, any> {
  const loaded = getDocumentProjectStore().getQualityEvaluation(projectId, evaluationId) as any;
  if (!loaded) fail('找不到质量对照评测：' + evaluationId, 404);
  const report = loaded.report as any;
  const complete = ['completed', 'not_applicable'].includes(String(report.blindReview?.status));
  return {
    evaluationId,
    sourceRevisionId: report.sourceRevisionId,
    comparable: report.comparable,
    blindReview: report.blindReview,
    ...(complete ? {
      deterministic: report.deterministic,
      beforeRunId: report.beforeRunId,
      afterRunId: report.afterRunId,
    } : {}),
    createdAt: report.createdAt,
    submittedReviewCount: Array.isArray(loaded.blindReviews) ? loaded.blindReviews.length : 0,
  };
}
