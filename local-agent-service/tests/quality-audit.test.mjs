import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-quality-audit-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');

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

