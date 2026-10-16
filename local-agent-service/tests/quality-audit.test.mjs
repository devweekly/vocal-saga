import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-quality-audit-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');
const realNovelFixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/alice-adventures-real-novel.json', import.meta.url)), 'utf8',
));

const { getDocumentProjectStore } = await import('../src/documents/projectStore.ts');
const {
  runProjectQualityAudit,
  createQualityRepairRun,
  createProjectQualityEvaluation,
  submitProjectQualityEvaluationReviews,
  getProjectQualityEvaluation,
} = await import('../src/documents/qualityAudit.ts');

test('book audit finds missing translations, confirmed-name drift and repeated-line variation; repair remains a candidate run', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Quality Audit Test',
    format: 'txt',
    sourceFileName: 'quality-audit.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh', glossary: { document_terms: [
      { source: 'Captain Vale', target: '维尔船长' },
    ] } },
    segments: [
      { id: 'name-1', text: 'Mara Voss entered the archive before dawn.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'name-2', text: 'Captain Vale entered the archive before dawn.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'repeat-1', text: 'Keep the western lamp burning.', kind: 'dialogue', contextPath: 'Chapter 1' },
      { id: 'repeat-2', text: 'Keep the western lamp burning.', kind: 'dialogue', contextPath: 'Chapter 3' },
      { id: 'missing-1', text: 'The ledger remained beneath the floor.', kind: 'paragraph', contextPath: 'Chapter 4' },
    ],
  });
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: 'Mara Voss',
      target: '玛拉·沃斯',
      aliases: ['Mara'],
      kind: 'character',
      reviewStatus: 'confirmed',
      description: 'Main character',
    }],
    relationships: [],
    styleGuide: {},
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  });
  store.saveManualEdit(project.projectId, 'name-1', '玛丽·沃斯在黎明前进入档案室。');
  store.saveManualEdit(project.projectId, 'name-2', '维尔在黎明前进入档案室。');
  store.saveManualEdit(project.projectId, 'repeat-1', '让西侧的灯一直亮着。');
  store.saveManualEdit(project.projectId, 'repeat-2', '西边的灯不要熄灭。');

  const report = runProjectQualityAudit(project.projectId);
  assert.equal(report.metrics.missingTranslationCount, 1);
  assert.ok(report.findings.some((item) => item.type === 'missing-translation' && item.segmentIds.includes('missing-1')));
  assert.ok(report.findings.some((item) => item.type === 'terminology-drift' && item.segmentIds.includes('name-1')));
  assert.ok(report.findings.some((item) => item.type === 'terminology-drift' && item.segmentIds.includes('name-2')),
    'book audit must include prompt glossary terms even when literary memory has no duplicate entry');
  assert.ok(report.findings.some((item) => item.type === 'repeated-expression-drift' &&
    item.segmentIds.includes('repeat-1') && item.segmentIds.includes('repeat-2')));

  const missingFinding = report.findings.find((item) => item.type === 'missing-translation');
  const termFinding = report.findings.find((item) => item.type === 'terminology-drift');
  const repair = createQualityRepairRun(project.projectId, report.auditId, [missingFinding.findingId, termFinding.findingId]);
  assert.deepEqual(new Set(repair.segmentIds), new Set(['missing-1', 'name-1']));
  assert.equal(repair.humanAcceptanceRequired, true);
  assert.equal(repair.run.scope.type, 'ids');
  assert.equal(repair.run.parentRunId, null);
  assert.equal(store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'name-1').acceptedTranslation,
    '玛丽·沃斯在黎明前进入档案室。', 'planning a repair must never overwrite an accepted manual translation');
  assert.equal(store.getRun(project.projectId, repair.run.runId).status, 'queued');

  store.saveCandidate(project.projectId, repair.run.runId, 'name-1', '模型候选：玛拉·沃斯在黎明前走进档案室。');
  store.saveCandidate(project.projectId, repair.run.runId, 'missing-1', '账本仍然藏在地板下面。');
  store.saveManualEdit(project.projectId, 'name-1', '人工再次确认：玛丽·沃斯在黎明前进入档案室。');
  store.finishRun(project.projectId, repair.run.runId);
  store.acceptCandidates(project.projectId, repair.run.runId);
  const afterRepairAcceptance = store.getSegments(project.projectId, { limit: 10 });
  assert.equal(afterRepairAcceptance.find((item) => item.id === 'name-1').acceptedTranslation,
    '人工再次确认：玛丽·沃斯在黎明前进入档案室。',
    'an acceptance operation must not overwrite a newer manual edit with a repair candidate');
  assert.equal(afterRepairAcceptance.find((item) => item.id === 'missing-1').acceptedTranslation,
    '账本仍然藏在地板下面。');
});

test('book consistency audit catches a changed repeated dialogue after the first 16 occurrences', () => {
  const store = getDocumentProjectStore();
  const segments = Array.from({ length: 20 }, (_, index) => ({
    id: 'dialogue-' + String(index + 1).padStart(2, '0'),
    text: 'Speaker ' + (index + 1) + ' whispered: “Keep the western lamp burning.”',
    kind: 'dialogue',
    contextPath: 'Chapter ' + (Math.floor(index / 4) + 1),
  }));
  const project = store.createProject({
    title: 'Late Repeated Dialogue Test',
    format: 'txt',
    sourceFileName: 'late-repeat.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments,
  });
  segments.forEach((segment, index) => {
    store.saveManualEdit(project.projectId, segment.id,
      index === 19 ? '别让西边的灯熄灭。' : '让西边的灯一直亮着。');
  });

  const report = runProjectQualityAudit(project.projectId);
  const finding = report.findings.find((item) =>
    item.type === 'repeated-expression-drift' && item.occurrenceCount === 20);
  assert.ok(finding);
  assert.ok(finding.segmentIds.includes('dialogue-20'));
  assert.equal(finding.segmentIdsTruncated, false);

  const repair = createQualityRepairRun(project.projectId, report.auditId, [], ['dialogue-20']);
  assert.deepEqual(repair.segmentIds, ['dialogue-20'], 'explicit segment repair must not expand to all repeated occurrences');
});

test('book audit detects numeric drift and records malformed model outputs without changing accepted translations', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Numeric and Output Validation Audit Test',
    format: 'txt',
    sourceFileName: 'numeric-output-audit.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'numeric-1', text: 'The vault opens in 7 minutes and requires 2 keys.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'plain-1', text: 'The door is heavy.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });

  store.saveManualEdit(project.projectId, 'numeric-1', '人工确认：保险库将在 7 分钟后开启，需要 2 把钥匙。');
  const run = store.createRun(project.projectId, { scope: { type: 'all' } });
  store.saveCandidate(project.projectId, run.runId, 'numeric-1', '保险库将在 8 分钟后开启，需要 2 把钥匙。');
  store.saveCandidate(project.projectId, run.runId, 'plain-1', '这扇门很沉。');
  store.appendEvent(project.projectId, run.runId, 'batch.output.validation', {
    stage: 'translate',
    batchIndex: 0,
    requestId: 'test-output-shape',
    duplicateSegmentIds: ['numeric-1'],
    duplicateCount: 1,
    unexpectedOutputIds: ['not-in-input'],
    unexpectedCount: 1,
    malformedRowCount: 1,
  });
  store.finishRun(project.projectId, run.runId);

  const report = runProjectQualityAudit(project.projectId, run.runId);
  const numeric = report.findings.find((item) => item.type === 'numeric-token-mismatch');
  assert.ok(numeric);
  assert.deepEqual(numeric.segmentIds, ['numeric-1']);
  assert.deepEqual(numeric.sourceNumbers, ['7', '2']);
  assert.deepEqual(numeric.translatedNumbers, ['8', '2']);
  assert.equal(numeric.repairable, true);

  const duplicate = report.findings.find((item) => item.type === 'duplicate-output-id');
  assert.ok(duplicate);
  assert.deepEqual(duplicate.segmentIds, ['numeric-1']);
  assert.equal(duplicate.duplicateCount, 1);

  const unexpected = report.findings.find((item) => item.type === 'unexpected-output-id');
  assert.ok(unexpected);
  assert.deepEqual(unexpected.unexpectedOutputIds, ['not-in-input']);
  assert.equal(unexpected.repairable, false);

  const malformed = report.findings.find((item) => item.type === 'malformed-output-row');
  assert.ok(malformed);
  assert.equal(malformed.malformedRowCount, 1);
  assert.equal(report.metrics.numericTokenMismatchCount, 1);

  const afterAudit = store.getSegments(project.projectId, { limit: 10 });
  assert.equal(afterAudit.find((item) => item.id === 'numeric-1').acceptedTranslation,
    '人工确认：保险库将在 7 分钟后开启，需要 2 把钥匙。',
    'audit findings must not overwrite an accepted manual translation');
});

test('numeric audit compares written-out English and Chinese quantities without treating articles as numbers', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Written Quantity Audit Test',
    format: 'txt',
    sourceFileName: 'written-quantity-audit.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'ten-correct', text: 'She was now only ten inches high.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'ten-wrong', text: 'She was now only ten inches high.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'article-a', text: 'A White Rabbit ran close by.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'one-side', text: 'One side will make you grow taller.', kind: 'paragraph', contextPath: 'Chapter 5' },
      { id: 'twenty-four-hours', text: 'The earth takes twenty-four hours to turn around.', kind: 'paragraph', contextPath: 'Chapter 6' },
      { id: 'digit-mismatch', text: 'The door is 4 inches high.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'unit-mismatch', text: 'The table is three inches high.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  store.saveManualEdit(project.projectId, 'ten-correct', '她如今只有十英寸高。');
  store.saveManualEdit(project.projectId, 'ten-wrong', '她如今只有九英寸高。');
  store.saveManualEdit(project.projectId, 'article-a', '一只白兔从她身边跑过。');
  store.saveManualEdit(project.projectId, 'one-side', '一边会让你长高。');
  store.saveManualEdit(project.projectId, 'twenty-four-hours', '地球转一圈需要二十四小时。');
  store.saveManualEdit(project.projectId, 'digit-mismatch', '这扇门有五英寸高。');
  store.saveManualEdit(project.projectId, 'unit-mismatch', '这张桌子有三英尺高。');

  const report = runProjectQualityAudit(project.projectId);
  const numeric = report.findings.filter((item) => item.type === 'numeric-token-mismatch');
  assert.deepEqual(new Set(numeric.flatMap((item) => item.segmentIds)),
    new Set(['ten-wrong', 'digit-mismatch', 'unit-mismatch']));
  assert.ok(numeric.some((item) => item.segmentIds.includes('ten-wrong') &&
    item.sourceNumbers[0] === '10' && item.translatedNumbers[0] === '9'));
  assert.ok(numeric.some((item) => item.segmentIds.includes('digit-mismatch') &&
    item.sourceNumbers[0] === '4' && item.translatedNumbers[0] === '5'));
  assert.ok(numeric.some((item) => item.segmentIds.includes('unit-mismatch') &&
    item.sourceNumbers[0] === '3' && item.translatedNumbers[0] === '3' &&
    item.sourceUnits[0] === 'length:inch' && item.translatedUnits[0] === 'length:foot'),
    'equal number tokens must still warn when the translated measurement unit changes');
  assert.ok(!numeric.some((item) => item.segmentIds.includes('article-a')),
    'Chinese classifier 一只 should not be misread as an explicit number for English article a');
  assert.ok(!numeric.some((item) => item.segmentIds.includes('one-side')),
    'the explicitly numeric phrase one side should match 一边');
  assert.ok(!numeric.some((item) => item.segmentIds.includes('twenty-four-hours')),
    'written-out twenty-four must match 二十四');
});

test('M4 paired-run evaluation uses the real-novel corpus and withholds A/B mapping until blind ratings', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: realNovelFixture.title,
    format: 'txt',
    sourceFileName: 'alice-adventures-real-novel.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: realNovelFixture.segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      kind: segment.kind,
      contextPath: segment.contextPath,
    })),
  });

  const createRunWithTranslations = (values) => {
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    values.forEach((item) => store.saveCandidate(project.projectId, run.runId, item.id, item.translated_text));
    store.finishRun(project.projectId, run.runId);
    return store.getRun(project.projectId, run.runId);
  };
  // The M0 control deliberately contains one missing item. The M4 API requires two completed
  // comparable runs, so use a non-empty wrong candidate for that one segment in this workflow test.
  const completeBefore = realNovelFixture.baselineTranslations.map((item) =>
    item.translated_text.trim() ? item : { ...item, translated_text: '我说不清。' });
  const before = createRunWithTranslations(completeBefore);
  const after = createRunWithTranslations(realNovelFixture.improvedExampleTranslations);
  assert.equal(before.sourceRevisionId, after.sourceRevisionId);
  assert.equal(before.status, 'awaiting_acceptance');
  assert.equal(after.status, 'awaiting_acceptance');

  const created = createProjectQualityEvaluation(project.projectId, before.runId, after.runId);
  assert.equal(created.comparable, true);
  assert.equal(created.blindReview.status, 'pending');
  assert.ok(created.blindReview.sampleCount > 0);
  assert.equal(created.beforeRunId, undefined);
  assert.equal(created.afterRunId, undefined);
  assert.equal(created.deterministic, undefined);
  assert.ok(created.blindReview.packet.every((item) => typeof item.source === 'string' &&
    typeof item.variantA === 'string' && typeof item.variantB === 'string'));

  const ratings = created.blindReview.packet.map((item) => ({
    segmentId: item.segmentId,
    dimension: 'overall',
    preference: 'A',
    confidence: 'medium',
  }));
  const submitted = submitProjectQualityEvaluationReviews(project.projectId, created.evaluationId, ratings);
  assert.equal(submitted.blindReview.status, 'completed');
  assert.equal(submitted.blindReview.result.beforeWins + submitted.blindReview.result.afterWins,
    ratings.length);
  const persisted = getProjectQualityEvaluation(project.projectId, created.evaluationId);
  assert.equal(persisted.blindReview.status, 'completed');
  assert.equal(persisted.beforeRunId, before.runId);
  assert.equal(persisted.afterRunId, after.runId);
  assert.equal(persisted.deterministic.before.segmentCount, realNovelFixture.segments.length);
});

test('paired-run evaluation withholds A/B mapping until every sampled segment has an overall blind rating', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Quality Evaluation Test',
    format: 'txt',
    sourceFileName: 'quality-eval.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'eval-1', text: 'Mara Voss entered the archive.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'eval-2', text: 'Iven closed the heavy door.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'eval-3', text: 'Keep the western lamp burning.', kind: 'dialogue', contextPath: 'Chapter 2' },
    ],
  });
  const createRunWithTranslations = (values) => {
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    values.forEach(([id, translation]) => store.saveCandidate(project.projectId, run.runId, id, translation));
    store.finishRun(project.projectId, run.runId);
    return store.getRun(project.projectId, run.runId);
  };
  const before = createRunWithTranslations([
    ['eval-1', '玛丽·沃斯进入了档案室。'],
    ['eval-2', '伊文关上了沉重的门。'],
    ['eval-3', '让西边的灯一直亮着。'],
  ]);
  const after = createRunWithTranslations([
    ['eval-1', '玛拉·沃斯走进档案室。'],
    ['eval-2', '伊文关上那扇沉重的门。'],
    ['eval-3', '让西侧的灯一直亮着。'],
  ]);
  assert.equal(before.status, 'awaiting_acceptance');
  assert.equal(after.status, 'awaiting_acceptance');

  const created = createProjectQualityEvaluation(project.projectId, before.runId, after.runId);
  assert.equal(created.comparable, true);
  assert.equal(created.blindReview.status, 'pending');
  assert.ok(created.blindReview.packet.length > 0);
  assert.equal(created.beforeRunId, undefined);
  assert.equal(created.afterRunId, undefined);

  const ratings = created.blindReview.packet.map((item) => ({
    segmentId: item.segmentId,
    dimension: 'overall',
    preference: 'A',
    confidence: 'medium',
  }));
  const submitted = submitProjectQualityEvaluationReviews(project.projectId, created.evaluationId, ratings);
  assert.equal(submitted.blindReview.status, 'completed');
  assert.equal(submitted.blindReview.result.beforeWins + submitted.blindReview.result.afterWins,
    ratings.length);
  assert.ok(submitted.deterministic);
  assert.equal(submitted.deterministic.before.totalPipelineRequestCount, 0);
  assert.equal(submitted.deterministic.after.totalPipelineRequestCount, 0);
  assert.equal(submitted.deterministic.after.tokenAndBillingCostsAvailable, false);

  const persisted = getProjectQualityEvaluation(project.projectId, created.evaluationId);
  assert.equal(persisted.blindReview.status, 'completed');
  assert.equal(persisted.beforeRunId, before.runId);
  assert.equal(persisted.afterRunId, after.runId);

  const identical = createRunWithTranslations([
    ['eval-1', '玛丽·沃斯进入了档案室。'],
    ['eval-2', '伊文关上了沉重的门。'],
    ['eval-3', '让西边的灯一直亮着。'],
  ]);
  const noTextDelta = createProjectQualityEvaluation(project.projectId, before.runId, identical.runId);
  assert.equal(noTextDelta.blindReview.status, 'not_applicable');
  assert.equal(noTextDelta.blindReview.sampleCount, 0);
  assert.ok(noTextDelta.deterministic, 'metrics are disclosed when no differing translation can be blindly compared');
  assert.throws(
    () => submitProjectQualityEvaluationReviews(project.projectId, noTextDelta.evaluationId, [
      { segmentId: 'eval-1', dimension: 'overall', preference: 'A' },
    ]),
    /不处于待盲评状态/,
  );
});

