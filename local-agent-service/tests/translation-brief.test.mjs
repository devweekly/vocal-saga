import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-translation-brief-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');

const { getDocumentProjectStore } = await import('../src/documents/projectStore.ts');
const { buildTranslationBrief, MAX_TRANSLATION_BRIEF_CHARS } = await import('../src/documents/translationBrief.ts');
const { buildBatches } = await import('../src/documents/translationAgent.ts');

test('TranslationBrief is revision-pinned, bounded and hashes the source selection', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Brief Test',
    format: 'txt',
    sourceFileName: 'brief-test.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'c1-1', text: 'Mara Voss entered the archive.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'c1-2', text: 'Keep the western lamp burning.', kind: 'dialogue', contextPath: 'Chapter 1' },
      { id: 'c2-1', text: 'Iven returned at midnight.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  const run = store.createRun(project.projectId, {
    scope: { type: 'ids', ids: ['c1-1', 'c1-2'] },
  });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 });
  const first = buildTranslationBrief(context, source.slice(0, 1), []);
  const second = buildTranslationBrief(context, source.slice(1, 2), [
    { id: source[0].id, text: source[0].text, contextPath: source[0].contextPath },
  ]);

  assert.equal(first.sourceRevisionId, run.sourceRevisionId);
  assert.equal(first.promptRevisionId, run.promptRevisionId);
  assert.equal(first.memoryRevisionId, run.literaryMemoryRevisionId);
  assert.deepEqual(first.sourceSegmentIds, ['c1-1']);
  assert.equal(first.chapterPath, 'Chapter 1');
  assert.equal(first.policyVersion, 'translation-brief-v1');
  assert.ok(first.contextChars <= MAX_TRANSLATION_BRIEF_CHARS);
  assert.match(first.contextHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.contextHash, second.contextHash, 'context identity changes when source IDs and preceding context change');

  store.saveTranslationBriefSnapshot(project.projectId, run.runId, 1, first);
  const snapshots = store.listTranslationBriefSnapshots(project.projectId, run.runId, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].contextHash, first.contextHash);
  assert.deepEqual(snapshots[0].sourceSegmentIds, ['c1-1']);
  assert.equal(snapshots[0].brief.policyVersion, 'translation-brief-v1');
});

test('literary batch planner never crosses a chapter boundary', () => {
  const items = [
    { id: 'a1', text: 'Mara entered.', contextPath: 'Chapter 1' },
    { id: 'a2', text: 'She looked at the lamp.', contextPath: 'Chapter 1' },
    { id: 'b1', text: 'Iven arrived.', contextPath: 'Chapter 2' },
  ];
  const ordinary = buildBatches(items, false);
  const literary = buildBatches(items, true);
  assert.equal(ordinary.length, 1);
  assert.deepEqual(literary.map((batch) => Array.from(new Set(batch.map((item) => item.contextPath)))), [
    ['Chapter 1'],
    ['Chapter 2'],
  ]);
});


test('future-supported glossary, character profile, anchor, examples and style text are excluded from an early TranslationBrief', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Temporal Knowledge Boundary Test',
    format: 'txt',
    sourceFileName: 'temporal-boundary.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'early-1', text: 'Mara Voss entered the archive and touched the old key.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'future-1', text: 'Mara Voss was the secret Queen of Ash, keeper of the hidden passage.', kind: 'paragraph', contextPath: 'Chapter 8' },
    ],
  });
  store.saveManualEdit(project.projectId, 'future-1', '玛拉·沃斯其实是灰烬女王，也是密道的守护者。');
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: 'Mara Voss',
      target: '灰烬女王',
      aliases: ['Queen of Ash'],
      kind: 'character',
      reviewStatus: 'confirmed',
      evidence: 'Mara Voss was the secret Queen of Ash, keeper of the hidden passage.',
    }],
    relationships: [{
      subject: 'Mara Voss',
      predicate: 'guards',
      object: 'hidden passage',
      reviewStatus: 'confirmed',
      evidence: 'Mara Voss was the secret Queen of Ash, keeper of the hidden passage.',
    }],
    styleGuide: {
      narrativeVoice: 'The narrator gradually reveals that Mara is the Queen of Ash.',
      register: 'Literary',
      rhythm: 'Measured',
      dialogue: 'Restrained',
      diction: 'Gothic',
      avoid: [],
    },
    chapterSummaries: [{ chapter: 'Chapter 8', summary: 'Mara is the Queen of Ash.' }],
    recentExamples: [{ source: 'Mara Voss was the secret Queen of Ash.', target: '玛拉·沃斯其实是灰烬女王。', chapter: 'Chapter 8' }],
    characterVoices: [{
      characterId: 'mara-voss',
      canonicalSourceName: 'Mara Voss',
      targetName: '玛拉·沃斯',
      aliases: ['Queen of Ash'],
      status: 'confirmed',
      confidence: 0.95,
      voiceCore: { register: 'Cold and commanding', syntaxRhythm: [], lexicalPreferences: ['kneel'], discourseHabits: [], stanceModality: [], humorIrony: '', disfluency: '', avoid: [] },
      evidence: [{
        segmentId: 'future-1',
        sourceQuote: 'Mara Voss was the secret Queen of Ash',
        observation: 'Uses royal imperatives',
        dimension: 'register',
        confidence: 0.95,
      }],
      contrastRules: [],
      openQuestions: [],
    }],
    relationshipVoiceRules: [],
    voiceAnchors: [{
      anchorId: 'future-anchor',
      speakerId: 'mara-voss',
      source: 'keeper of the hidden passage',
      target: '密道守护者',
      chapter: 'Chapter 8',
      segmentId: 'future-1',
      attributionEvidence: 'Mara Voss was the secret Queen of Ash',
      attributionConfidence: 0.95,
      status: 'approved',
    }],
    openQuestions: [],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['early-1'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'early-1');
  const brief = buildTranslationBrief(context, [source], []);
  const serialized = JSON.stringify(brief);

  assert.ok(!serialized.includes('Queen of Ash'));
  assert.ok(!serialized.includes('hidden passage'));
  assert.ok(!serialized.includes('灰烬女王'));
  assert.ok(!serialized.includes('密道守护者'));
  assert.ok(!serialized.includes('gradually reveals'));
  assert.deepEqual(brief.voiceContext.entities, []);
  assert.deepEqual(brief.voiceContext.characterVoices, []);
  assert.deepEqual(brief.voiceContext.voiceAnchors, []);
  assert.deepEqual(brief.voiceContext.chapterSummaries, []);
});

test('later identity never enters an earlier brief', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Temporal Boundary',
    format: 'txt',
    sourceFileName: 'temporal.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh', glossary: { document_terms: [
      { source: 'Mara Voss', target: '玛拉·沃斯', aliases: ['Mara'] },
      { source: 'Queen Ash', target: '灰后', aliases: ['Liora Vale'], description: 'Later identity reveal' },
    ] } },
    segments: [
      { id: 'early-a', text: 'Mara Voss is a careful archivist.', contextPath: 'Chapter 1' },
      { id: 'early-b', text: 'Mara Voss said, Keep the western lamp burning.', contextPath: 'Chapter 1' },
      { id: 'late-a', text: 'Mara Voss was secretly Queen Ash.', contextPath: 'Chapter 2' },
    ],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['early-b'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  context.memory = {
    entities: [
      { source: 'Mara Voss', target: '玛拉·沃斯', aliases: ['Mara'], reviewStatus: 'confirmed', evidence: 'Mara Voss is a careful archivist.' },
      { source: 'Queen Ash', target: '灰后', aliases: [], reviewStatus: 'confirmed', evidence: 'Mara Voss was secretly Queen Ash.' },
    ],
    relationships: [],
    styleGuide: { narrativeVoice: 'Mara Voss is secretly Queen Ash.' },
    chapterSummaries: [{ chapter: 'Chapter 2', summary: 'Mara Voss is secretly Queen Ash.' }],
    recentExamples: [{ source: 'Mara Voss was secretly Queen Ash.', target: '玛拉其实是灰后。' }],
    characterVoices: [],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  };
  const brief = buildTranslationBrief(context,
    [{ id: 'early-b', text: 'Mara Voss said, Keep the western lamp burning.', contextPath: 'Chapter 1' }],
    [{ id: 'early-a', text: 'Mara Voss is a careful archivist.', contextPath: 'Chapter 1' }]);
  const injected = JSON.stringify({ graph: brief.contextGraph, voice: brief.voiceContext });
  assert.ok(injected.includes('Mara Voss'));
  assert.ok(!injected.includes('Queen Ash'));
  assert.ok(!injected.includes('灰后'));
  assert.deepEqual(brief.glossary.document_terms.map((term) => term.source), ['Mara Voss']);
  assert.ok(!JSON.stringify(brief.glossary).includes('Queen Ash'));
  assert.ok(!JSON.stringify(brief.glossary).includes('Later identity reveal'));
  assert.deepEqual(brief.voiceContext.chapterSummaries, []);
  assert.deepEqual(brief.voiceContext.recentExamples, []);
  assert.ok(brief.contextChars <= MAX_TRANSLATION_BRIEF_CHARS);
});
