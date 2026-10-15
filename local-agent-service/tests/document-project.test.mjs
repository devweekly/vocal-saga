import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocumentProjectStore } from '../src/documents/projectStore.ts';

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vocal-doc-project-'));
  try {
    const store = new DocumentProjectStore(root);
    await run(store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const segments = [
  { id: 'ch1-p1', text: 'The door was open.', kind: 'paragraph', contextPath: 'Chapter 1' },
  { id: 'ch1-p2', text: 'Nobody came inside.', kind: 'paragraph', contextPath: 'Chapter 1' },
];

test('document projects persist each source segment, Prompt revision and run independently', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Example Book',
      format: 'epub',
      sourceFileName: 'example.epub',
      segments,
      prompt: { systemPrompt: 'Translate faithfully.', sourceLang: 'en', targetLang: 'zh', provider: 'workbuddy', model: 'auto' },
    });
    assert.equal(project.title, 'Example Book');
    assert.equal(project.segmentCount, 2);
    assert.equal(store.listProjects().length, 1);

    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    assert.equal(run.status, 'queued');
    assert.equal(run.counts.total, 2);
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '门开着。');
    store.saveCandidate(project.projectId, run.runId, 'ch1-p2', '没有人进来。');
    const awaiting = store.finishRun(project.projectId, run.runId);
    assert.equal(awaiting.status, 'awaiting_acceptance');
    assert.equal(awaiting.counts.candidate, 2);

    // Candidate translations are durable but are not the current accepted translation.
    const beforeAccept = store.getSegments(project.projectId, { limit: 20, runId: run.runId });
    assert.equal(beforeAccept[0].acceptedTranslation, null);
    assert.equal(beforeAccept[0].candidateTranslation, '门开着。');

    const accepted = store.acceptCandidates(project.projectId, run.runId);
    assert.equal(accepted.status, 'completed');
    const current = store.getSegments(project.projectId, { limit: 20 });
    assert.equal(current[0].acceptedTranslation, '门开着。');
    assert.equal(current[1].acceptedTranslation, '没有人进来。');

    // Identical inputs should plan no stale work after accepting the run.
    const noWork = store.createRun(project.projectId, { scope: { type: 'stale' } });
    assert.equal(noWork.counts.total, 0);
    assert.equal(noWork.status, 'completed');
  });
});

test('source revisions retain prior runs and report translations stale when their source changes', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Revision Test', format: 'pdf', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '门开着。');
    store.saveCandidate(project.projectId, run.runId, 'ch1-p2', '没有人进来。');
    store.finishRun(project.projectId, run.runId);
    store.acceptCandidates(project.projectId, run.runId);

    const revised = [
      { ...segments[0], text: 'The old door was open.' },
      segments[1],
    ];
    const nextProject = store.createSourceRevision(project.projectId, {
      title: project.title, format: 'pdf', segments: revised,
    });
    assert.notEqual(nextProject.currentSourceRevisionId, project.currentSourceRevisionId);
    const verification = store.verifyProject(project.projectId);
    assert.deepEqual(verification.staleSourceIds, ['ch1-p1']);
    const runList = store.listRuns(project.projectId);
    assert.equal(runList.length, 1, 'source import must not delete older run history');
  });
});

test('manual correction becomes an accepted version but remains traceable', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Manual Edit', format: 'epub', segments });
    const edit = store.saveManualEdit(project.projectId, 'ch1-p1', '门敞开着。');
    assert.equal(edit.origin, 'manual');
    assert.equal(edit.accepted, true);
    const current = store.getSegments(project.projectId, { limit: 10 });
    assert.equal(current[0].acceptedTranslation, '门敞开着。');
    assert.equal(store.getEvents(project.projectId).some((event) => event.type === 'translation.manually-edited'), true);
  });
});

test('stores each original source file in its document revision directory', async () => {
  await withStore(async (store) => {
    const project = store.createProject({
      title: 'Original File',
      format: 'epub',
      sourceFileName: 'original.epub',
      segments,
    });
    const bytes = Buffer.from('PK fake EPUB source bytes');
    const saved = await store.storeSourceFile(project.projectId, 'original.epub', bytes);
    assert.equal(saved.saved, true);
    assert.equal(saved.size, bytes.byteLength);
    assert.equal(saved.sourceRevisionId, project.currentSourceRevisionId);
    assert.equal(store.getProject(project.projectId)?.sourceFileSaved, true);
    const actual = await readFile(path.join(store.rootDir, project.projectId, 'sources', project.currentSourceRevisionId + '.epub'));
    assert.deepEqual(actual, bytes);

    await assert.rejects(
      store.storeSourceFile(project.projectId, 'original.epub', Buffer.from('different bytes')),
      /此来源版本已有不同的原始文件/,
    );
  });
});

test('manual acceptance is newer than an older candidate and is not auto-staled by Prompt changes', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Manual Priority', format: 'epub', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '模型候选。');
    store.finishRun(project.projectId, run.runId);
    store.saveManualEdit(project.projectId, 'ch1-p1', '用户修订。');
    store.acceptCandidates(project.projectId, run.runId, ['ch1-p1']);

    const current = store.getSegments(project.projectId, { limit: 10 });
    assert.equal(current.find((item) => item.id === 'ch1-p1')?.acceptedTranslation, '用户修订。', 'a post-run manual edit must outrank the older Agent candidate');

    // A correction made after that explicit acceptance is newest and must survive Prompt changes.
    store.saveManualEdit(project.projectId, 'ch1-p1', '再次人工修订。');
    const nextPrompt = {
      systemPrompt: 'Changed prompt; use short natural Chinese.',
      sourceLang: 'en',
      targetLang: 'zh',
      provider: 'workbuddy',
      model: 'auto',
    };
    const noAutomaticOverwrite = store.createRun(project.projectId, { prompt: nextPrompt, scope: { type: 'stale' } });
    assert.equal(noAutomaticOverwrite.counts.total, 1, 'only the segment not yet accepted should remain stale');
    assert.equal(store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'ch1-p1')?.acceptedTranslation, '再次人工修订。');
  });
});


test('imports existing reader translations into workspace without overwriting accepted results', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Reader Shared State',
      format: 'epub',
      sourceFileName: 'reader.epub',
      segments,
      prompt: { systemPrompt: 'Shared prompt v1', sourceLang: 'en', targetLang: 'zh', provider: 'workbuddy', model: 'auto' },
    });
    const imported = store.importAcceptedTranslations(project.projectId, [
      { id: 'ch1-p1', text: '阅读页早先的译文。' },
      { id: 'ch1-p2', text: '另一段译文。' },
      { id: 'unknown', text: '不应导入。' },
    ]);
    assert.deepEqual(imported, { imported: 2, skipped: 1 });
    assert.equal(store.getSegments(project.projectId, { limit: 10 })[0].acceptedTranslation, '阅读页早先的译文。');

    const duplicate = store.importAcceptedTranslations(project.projectId, [
      { id: 'ch1-p1', text: '旧浏览器缓存不应覆盖 Agent 的当前版本。' },
    ]);
    assert.deepEqual(duplicate, { imported: 0, skipped: 1 });
    assert.equal(store.getSegments(project.projectId, { limit: 10 })[0].acceptedTranslation, '阅读页早先的译文。');

    const noWork = store.createRun(project.projectId, { scope: { type: 'stale' } });
    assert.equal(noWork.counts.total, 0, 'imported text should be seeded against the current Prompt fingerprint');
  });
});


test('literary memory has immutable revisions and each run keeps its original snapshot', async () => {
  await withStore((store) => {
    const memoryA = {
      version: 2, entities: [], relationships: [], styleGuide: { narrativeVoice: '克制' },
      chapterSummaries: [], recentExamples: [],
      characterVoices: [{
        characterId: 'char-alice', canonicalSourceName: 'Alice', targetName: '艾丽丝', aliases: [],
        status: 'confirmed', confidence: 0.9, voiceCore: { syntaxRhythm: ['短反问'] },
        contrastRules: [], evidence: [{ segmentId: 'ch1-p1', sourceQuote: 'Really?', dimension: 'syntax_rhythm', observation: '短反问', confidence: 0.9 }],
        openQuestions: [],
      }],
      relationshipVoiceRules: [], voiceAnchors: [],
    };
    const project = store.createProject({
      title: 'Voice Versions', format: 'epub', segments,
      prompt: { systemPrompt: 'same prompt', userPromptTemplate: '{{CONTENT}}', sourceLang: 'en', targetLang: 'zh', provider: 'workbuddy', model: 'auto', translationMode: 'literary', literaryMemory: memoryA },
    });
    const first = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    const firstContext = store.getRunContext(project.projectId, first.runId);
    assert.equal(firstContext.memory.characterVoices[0].voiceCore.syntaxRhythm[0], '短反问');
    assert.ok(firstContext.memoryRevisionId);

    store.setRunStatus(project.projectId, first.runId, 'paused');
    const memoryB = structuredClone(memoryA);
    memoryB.characterVoices[0].voiceCore.syntaxRhythm = ['先给结论，再用完整句解释'];
    const secondMemory = store.saveLiteraryMemory(project.projectId, memoryB);
    const second = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p2'] } });
    const secondContext = store.getRunContext(project.projectId, second.runId);

    assert.notEqual(secondMemory.memoryRevisionId, firstContext.memoryRevisionId);
    assert.equal(secondContext.memory.characterVoices[0].voiceCore.syntaxRhythm[0], '先给结论，再用完整句解释');
    assert.equal(firstContext.memory.characterVoices[0].voiceCore.syntaxRhythm[0], '短反问', 'earlier run must retain its immutable memory snapshot');
    assert.equal(second.promptRevisionId, first.promptRevisionId, 'memory updates must not create prompt revisions');
    assert.notEqual(second.literaryMemoryRevisionId, first.literaryMemoryRevisionId);
    assert.equal(store.listLiteraryMemoryRevisions(project.projectId).length, 2);
  });
});

test('one workspace cannot run two translation jobs concurrently', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Single Run', format: 'epub', segments });
    const first = store.createRun(project.projectId, { scope: { type: 'all' } });
    assert.equal(first.status, 'queued');
    assert.throws(
      () => store.createRun(project.projectId, { scope: { type: 'all' } }),
      /已有运行中的翻译任务/,
      'reader and Agent tabs must share one in-flight run lock',
    );
    store.setRunStatus(project.projectId, first.runId, 'paused');
    const next = store.createRun(project.projectId, { scope: { type: 'all' } });
    assert.equal(next.status, 'queued', 'a paused run can be explicitly replaced with a new run');
  });
});


test('literary memory confirms only current-source evidence and accepted translation anchors', async () => {
  await withStore((store) => {
    const source = [
      { id: 'ch1-p1', text: 'Alice asked Bob, “Really?”', kind: 'dialogue', contextPath: 'Chapter 1' },
      { id: 'ch1-p2', text: 'Bob said no.', kind: 'dialogue', contextPath: 'Chapter 1' },
    ];
    const project = store.createProject({ title: 'Voice Evidence', format: 'epub', segments: source,
      prompt: { translationMode: 'literary', literaryReview: true, sourceLang: 'en', targetLang: 'zh', provider: 'workbuddy', model: 'auto' } });
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '艾丽丝问鲍勃：“真的？”');
    store.saveCandidate(project.projectId, run.runId, 'ch1-p2', '鲍勃说不。');
    store.finishRun(project.projectId, run.runId);
    store.acceptCandidates(project.projectId, run.runId);

    const memory = {
      version: 2, entities: [], relationships: [], styleGuide: { narrativeVoice: '克制' },
      chapterSummaries: [], recentExamples: [],
      characterVoices: [
        {
          characterId: 'char-alice', canonicalSourceName: 'Alice', aliases: [], status: 'confirmed', confidence: 0.9,
          voiceCore: { syntaxRhythm: ['用简短反问'] }, contrastRules: [],
          evidence: [{ segmentId: 'ch1-p1', sourceQuote: 'Alice asked Bob', dimension: 'discourse', observation: '对白有明确的提问标记', confidence: 0.9 }],
          openQuestions: [],
        },
        {
          characterId: 'char-bob', canonicalSourceName: 'Bob', aliases: [], status: 'confirmed', confidence: 0.8,
          voiceCore: { register: '简短回答' }, contrastRules: [],
          evidence: [{ segmentId: 'ch1-p2', sourceQuote: 'This quote is not in this paragraph', dimension: 'register', observation: 'invalid source quote', confidence: 0.8 }],
          openQuestions: [],
        },
      ],
      relationshipVoiceRules: [{
        speakerId: 'char-alice', addresseeId: 'char-bob', status: 'confirmed',
        baselineRegister: '直接但平静', addressTerms: ['Bob'], evidenceSegmentIds: ['ch1-p1', 'missing-id'],
      }],
      voiceAnchors: [
        {
          anchorId: 'anchor-valid', speakerId: 'char-alice', addresseeId: 'char-bob', source: 'Really?',
          target: '真的？', chapter: 'Chapter 1', segmentId: 'ch1-p1', status: 'approved', approvedBy: 'user',
          attributionEvidence: 'Alice asked Bob', attributionConfidence: 0.95, tags: ['short-question'],
        },
        {
          anchorId: 'anchor-wrong-target', speakerId: 'char-alice', source: 'Really?',
          target: '我爱你。', chapter: 'Chapter 1', segmentId: 'ch1-p1', status: 'approved', approvedBy: 'user',
          attributionEvidence: 'Alice asked Bob', attributionConfidence: 0.95, tags: [],
        },
      ],
    };
    store.saveLiteraryMemory(project.projectId, memory);
    const saved = store.getCurrentLiteraryMemory(project.projectId).memory;
    assert.equal(saved.characterVoices.find((item) => item.characterId === 'char-alice').status, 'confirmed');
    assert.equal(saved.characterVoices.find((item) => item.characterId === 'char-bob').status, 'candidate',
      'a quote that is not in the current source must not uphold a confirmed profile');
    assert.equal(saved.relationshipVoiceRules[0].status, 'candidate',
      'relationship voice rules cannot be confirmed while one party is only a candidate');
    assert.deepEqual(saved.relationshipVoiceRules[0].evidenceSegmentIds, ['ch1-p1']);
    assert.equal(saved.voiceAnchors.find((item) => item.anchorId === 'anchor-valid').status, 'approved');
    assert.equal(saved.voiceAnchors.find((item) => item.anchorId === 'anchor-wrong-target').status, 'candidate',
      'an anchor target must exist in the accepted translation for the referenced segment');
  });
});

test('literary Agent retrieves only bounded source context before the current segment', async () => {
  await withStore((store) => {
    const source = Array.from({ length: 8 }, (_, index) => ({
      id: 'p' + index, text: 'Source segment ' + index, kind: 'paragraph', contextPath: 'Chapter A',
    }));
    const project = store.createProject({ title: 'Previous Context', format: 'epub', segments: source });
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    const preceding = store.getPrecedingSegments(project.projectId, run.runId, 'p7', 4);
    assert.deepEqual(preceding.map((item) => item.id), ['p3', 'p4', 'p5', 'p6']);
    assert.ok(preceding.every((item) => item.text.length <= 900));
    assert.ok(preceding.every((item) => item.contextPath === 'Chapter A'));
  });
});

