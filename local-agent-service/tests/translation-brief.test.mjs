import test from 'node:test';
import { ensureTestContextGraph } from './helpers/literary-context-graph.mjs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-translation-brief-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');

const { getDocumentProjectStore } = await import('../src/documents/projectStore.ts');
const { buildTranslationBrief, summarizeTranslationBrief, MAX_TRANSLATION_BRIEF_CHARS } = await import('../src/documents/translationBrief.ts');
const { buildBatches, buildUserPrompt } = await import('../src/documents/translationAgent.ts');

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
  ensureTestContextGraph(store, project);
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
  assert.equal(first.policyVersion, 'translation-brief-v3-auto-canonical-names');
  assert.ok(first.contextChars <= MAX_TRANSLATION_BRIEF_CHARS);
  assert.match(first.contextHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.contextHash, second.contextHash, 'context identity changes when source IDs and preceding context change');

  store.saveTranslationBriefSnapshot(project.projectId, run.runId, 1, first);
  const snapshots = store.listTranslationBriefSnapshots(project.projectId, run.runId, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].contextHash, first.contextHash);
  assert.deepEqual(snapshots[0].sourceSegmentIds, ['c1-1']);
  assert.equal(snapshots[0].brief.policyVersion, 'translation-brief-v3-auto-canonical-names');

  const configuredContext = {
    ...context,
    prompt: {
      ...context.prompt,
      config: {
        ...context.prompt.config,
        translationStrategy: { precedingContextSegments: 1, contextBudgetChars: 8000 },
      },
    },
  };
  const configuredBrief = buildTranslationBrief(
    configuredContext,
    source.slice(2, 3),
    source.slice(0, 2).map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
  );
  assert.equal(configuredBrief.precedingSegments.length, 1);
  assert.equal(configuredBrief.precedingSegments[0]?.id, source[1]?.id,
    'context count setting should retain only the closest earlier segment');
  assert.ok(configuredBrief.contextChars <= 8000);
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
  ensureTestContextGraph(store, project);
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
      // Canonical spelling is known early, but this target was derived from a later alias.
      { source: 'Mara Voss', target: '灰后', aliases: ['Queen Ash'], description: 'Target contaminated by a later identity reveal' },
      { source: 'Queen Ash', target: '灰后', aliases: ['Liora Vale'], description: 'Later identity reveal' },
    ] } },
    segments: [
      { id: 'early-a', text: 'Mara Voss is a careful archivist.', contextPath: 'Chapter 1' },
      { id: 'early-b', text: 'Mara Voss said, Keep the western lamp burning.', contextPath: 'Chapter 1' },
      { id: 'late-a', text: 'Mara Voss was secretly Queen Ash.', contextPath: 'Chapter 2' },
    ],
  });
  ensureTestContextGraph(store, project);
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['early-b'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  context.memory = {
    entities: [
      { source: 'Mara Voss', target: '玛拉·沃斯', aliases: ['Mara'], reviewStatus: 'confirmed', evidence: 'Mara Voss is a careful archivist.' },
      // Adversarial case: the canonical source and quote are early, but a later alias may
      // have contaminated the canonical target. Fail closed on the whole entity.
      { source: 'Mara Voss', target: '灰后', aliases: ['Queen Ash'], reviewStatus: 'confirmed', evidence: 'Mara Voss is a careful archivist.' },
      { source: 'Queen Ash', target: '灰后', aliases: [], reviewStatus: 'confirmed', evidence: 'Mara Voss was secretly Queen Ash.' },
    ],
    relationships: [],
    styleGuide: { narrativeVoice: 'Mara Voss is secretly Queen Ash.' },
    chapterSummaries: [{ chapter: 'Chapter 2', summary: 'Mara Voss is secretly Queen Ash.' }],
    recentExamples: [{ source: 'Mara Voss was secretly Queen Ash.', target: '玛拉其实是灰后。' }],
    characterVoices: [
      {
        characterId: 'mara-early', canonicalSourceName: 'Mara Voss', targetName: '玛拉·沃斯',
        aliases: ['Mara'], status: 'confirmed',
        voiceCore: { register: 'measured', syntaxRhythm: ['short declarations'] },
        contrastRules: [],
        evidence: [{
          segmentId: 'early-a', sourceQuote: 'Mara Voss is a careful archivist.',
          observation: 'measured register', dimension: 'register', confidence: 0.9,
        }],
      },
      {
        characterId: 'mara-mixed', canonicalSourceName: 'Mara Voss', targetName: '玛拉·沃斯',
        aliases: ['Mara'], status: 'confirmed',
        voiceCore: { register: 'imperious after her revelation' },
        contrastRules: [],
        evidence: [
          {
            segmentId: 'early-a', sourceQuote: 'Mara Voss is a careful archivist.',
            observation: 'measured register', dimension: 'register', confidence: 0.9,
          },
          {
            segmentId: 'late-a', sourceQuote: 'Mara Voss was secretly Queen Ash.',
            observation: 'imperious register', dimension: 'register', confidence: 0.99,
          },
        ],
      },
    ],
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
  assert.ok(!JSON.stringify(brief.voiceContext).includes('Queen Ash'));
  assert.deepEqual(brief.glossary.document_terms.map((term) => term.source), ['Mara Voss']);
  assert.ok(!JSON.stringify(brief.glossary).includes('Queen Ash'));
  assert.ok(!JSON.stringify(brief.glossary).includes('Later identity reveal'));
  assert.deepEqual(brief.voiceContext.chapterSummaries, []);
  assert.deepEqual(brief.voiceContext.recentExamples, []);
  assert.deepEqual(brief.voiceContext.characterVoices.map((profile) => profile.characterId), ['mara-early'],
    'a profile that combines early and future evidence must not be partially filtered and injected');
  assert.ok(brief.contextChars <= MAX_TRANSLATION_BRIEF_CHARS);
});

test('both reviewer focuses consume the same bounded TranslationBrief glossary and prior context', async () => {
  const { buildLiteraryReviewPrompt } = await import('../src/literary.ts');
  const translationBrief = {
    policyVersion: 'translation-brief-v2-dynamic-context',
    contextHash: 'brief-hash-123',
    contextChars: 900,
    sourceRevisionId: 'source-revision-1',
    promptRevisionId: 'prompt-revision-1',
    memoryRevisionId: 'memory-revision-1',
    chapterPath: 'Chapter 2',
    glossary: { document_terms: [{ source: 'Mara Voss', target: '玛拉·沃斯' }] },
    precedingSegments: [{ id: 'prior-1', text: 'Mara Voss entered the archive.', contextPath: 'Chapter 1' }],
    contextGraph: {
      policyVersion: 'context-graph-v2-temporal',
      knowledgeBoundaryOrdinal: 12,
      characters: [{ name: 'Mara Voss', voice: ['measured'] }],
      entities: [],
      relationships: [],
      chapterSummaries: [{ chapter: 'Chapter 1', summary: 'Mara entered the archive.' }],
    },
    voiceContext: {
      policyVersion: 'character-voice-v3',
      characterVoices: [{ canonicalSourceName: 'Mara Voss', voiceCore: { register: 'measured' } }],
      relationshipVoiceRules: [],
      voiceAnchors: [],
      chapterSummaries: [{ chapter: 'Chapter 1', summary: 'Mara entered the archive.' }],
      entities: [],
      relationships: [],
    },
  };
  const body = {
    target: 'zh',
    chapterTitle: 'Chapter 2',
    glossary: { document_terms: [{ source: 'Queen Ash', target: '灰后' }] },
    translationBrief,
  };
  const segments = [{ id: 'current-1', source: 'Mara Voss opened the ledger.', draft: '玛拉打开了账本。', kind: 'paragraph' }];
  const precedingSegments = translationBrief.precedingSegments;
  const translatorPrompt = buildUserPrompt('', [{
    id: 'current-1', text: 'Mara Voss opened the ledger.', kind: 'paragraph', contextPath: 'Chapter 2',
  }], {
    project: { title: 'Temporal Test', format: 'txt' },
    run: { sourceLang: 'en', targetLang: 'zh', translationMode: 'literary' },
    prompt: { config: { glossary: { document_terms: [{ source: 'Queen Ash', target: '灰后' }] } } },
    memory: {},
  }, [], translationBrief.contextGraph, translationBrief);
  assert.ok(translatorPrompt.includes('玛拉·沃斯'));
  assert.ok(!translatorPrompt.includes('Queen Ash'));
  assert.ok(!translatorPrompt.includes('灰后'));

  for (const reviewFocus of ['accuracy', 'style']) {
    const built = buildLiteraryReviewPrompt({
      body, segments, reviewFocus, translationBrief, precedingSegments,
      voiceContext: translationBrief.voiceContext, contextGraph: translationBrief.contextGraph,
    });
    assert.ok(built.prompt.includes('brief-hash-123'));
    assert.ok(built.prompt.includes('玛拉·沃斯'));
    assert.ok(built.prompt.includes('prior-1'));
    assert.ok(built.prompt.includes('knowledgeBoundaryOrdinal') && built.prompt.includes('12'));
    assert.ok(!built.prompt.includes('Queen Ash'));
    assert.ok(!built.prompt.includes('灰后'));
    assert.equal(built.contextChars > 0, true);
    assert.ok(built.systemPrompt.length > 0);
  }
});


test('TranslationBrief diagnostic summary exposes the count fields expected by the Agent Trajectory UI', () => {
  const summary = summarizeTranslationBrief({
    version: 1,
    policyVersion: 'translation-brief-v2-dynamic-context',
    sourceRevisionId: 'source-r1',
    promptRevisionId: 'prompt-r1',
    memoryRevisionId: null,
    sourceSegmentIds: ['s1'],
    chapterPath: 'Chapter 1',
    glossary: { document_terms: [] },
    precedingSegments: [],
    contextGraph: {
      characters: [{ id: 'c1' }],
      entities: [{ id: 'e1' }, { id: 'e2' }],
      relationships: [{ id: 'r1' }],
      nameMappings: [{ source: 'Grey', target: '格雷' }],
    },
    voiceContext: {
      entities: [],
      relationships: [],
      characterVoices: [{ characterId: 'grey' }],
      relationshipVoiceRules: [],
      voiceAnchors: [],
    },
    contextChars: 100,
    contextHash: 'test-hash',
  });

  assert.equal(summary.entityCount, 3);
  assert.equal(summary.relationshipCount, 1);
  assert.equal(summary.characterVoiceCount, 1);
  assert.equal(summary.nameMappingCount, 1);
  assert.equal(summary.graphEntities, 2);
  assert.equal(summary.graphCharacters, 1);
});


test('dynamic entity evidence is hidden before its cited source segment and visible after it', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Ordinal Evidence Test',
    format: 'txt',
    sourceFileName: 'ordinal-evidence.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'king-early', text: 'The King watched Max from the doorway.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'king-evidence', text: 'The King revealed his identity to Max.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'king-later', text: 'The King addressed Max again.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  ensureTestContextGraph(store, project);
  store.saveLiteraryMemory(project.projectId, {
    version: 2,
    entities: [{
      source: 'The King',
      target: '大王',
      kind: 'character_epithet',
      aliases: ['King'],
      evidence: 'The King revealed his identity to Max.',
      evidenceRefs: [{
        segmentId: 'king-evidence',
        sourceQuote: 'The King revealed his identity to Max.',
      }],
      reviewStatus: 'suggested',
    }],
    relationships: [],
    styleGuide: {},
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  });

  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['king-early', 'king-later'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const early = { id: 'king-early', text: 'The King watched Max from the doorway.', contextPath: 'Chapter 1' };
  const later = { id: 'king-later', text: 'The King addressed Max again.', contextPath: 'Chapter 2' };
  const earlyBrief = buildTranslationBrief(context, [early], []);
  const laterBrief = buildTranslationBrief(context, [later], []);

  assert.equal(earlyBrief.voiceContext.entities.some((entity) => entity.source === 'The King'), false,
    'a mapping inferred from Chapter 2 must not leak into an earlier Chapter 1 segment');
  assert.equal(laterBrief.voiceContext.entities.some((entity) => entity.source === 'The King' && entity.target === '大王'), true,
    'the same evidence may be used after the cited source segment');
});


test('source-ordered dynamic memory replaces conflicting unconfirmed Context Graph name proposals', async () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Dynamic Memory Beats Graph Candidate',
    format: 'txt',
    sourceFileName: 'dynamic-memory-graph-conflict.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'king-early', text: 'The King watched Max from the doorway.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'king-evidence', text: 'The King revealed his identity to Max.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'king-later', text: 'The King addressed Max again.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  ensureTestContextGraph(store, project);
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  const source = store.getSegments(project.projectId, { limit: 10 });
  // Calling the production bundle ensures the graph schema exists before inserting a test candidate.
  const { buildProjectContextGraphBundle } = await import('../src/documents/contextGraph.ts');
  buildProjectContextGraphBundle(project.projectId, [
    { id: 'king-later', text: 'The King addressed Max again.', contextPath: 'Chapter 2' },
  ], [], currentSourceRevisionId, 'zh');
  db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'graph-king', currentSourceRevisionId, 'character', 'The King', 'the king',
    JSON.stringify({ suggestedTranslation: '大王', aliases: [], targetLang: 'zh' }),
    'candidate', new Date().toISOString(), new Date().toISOString(),
  );
  db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) ' +
    'VALUES (?, ?, NULL, ?, ?, ?, ?)'
  ).run(
    currentSourceRevisionId, 'graph-king', 'king-early',
    'The King watched Max from the doorway.', 'name', new Date().toISOString(),
  );
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: 'The King', target: '国王', kind: 'character_epithet', aliases: ['King'],
      evidence: 'The King revealed his identity to Max.',
      evidenceRefs: [{
        segmentId: 'king-evidence',
        sourceQuote: 'The King revealed his identity to Max.',
      }],
      reviewStatus: 'suggested',
    }],
    relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
    characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['king-later'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const later = source.find((item) => item.id === 'king-later');
  const brief = buildTranslationBrief(context, [later], []);

  const mappings = (brief.contextGraph?.nameMappings || []).filter((mapping) => mapping.source === 'The King');
  assert.equal(mappings.length, 1,
    'there must be only one canonical mapping for the explicitly linked entity');
  assert.equal(mappings[0]?.target, '国王',
    'source-ordered dynamic memory should replace an unconfirmed, conflicting book-wide candidate');
});
