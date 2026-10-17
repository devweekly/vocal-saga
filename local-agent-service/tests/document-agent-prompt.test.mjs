import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBatches, buildCanonicalTermProtections, buildStandaloneReviewContextGraph, buildUserPrompt, maskCanonicalTermText, protectCanonicalReviewSegments, restoreCanonicalTermMarkers } from '../src/documents/translationAgent.ts';
import { normalizeDocumentTranslationStrategy } from '../src/documents/projectStore.ts';
import { buildProjectVoiceContext } from '../src/documents/voiceContext.ts';
import { isLiteraryReviewFindingGrounded } from '../src/literary.ts';

test('literary Project Agent separates preceding context from translatable segments', () => {
  const memory = {
    version: 2,
    entities: [],
    relationships: [],
    styleGuide: { narrativeVoice: '克制的第三人称' },
    chapterSummaries: [
      { chapter: 'Chapter 1', summary: 'Alice arrives at the estate.' },
      { chapter: 'Chapter 2', summary: 'Bob conceals an important letter.' },
      { chapter: 'Chapter 3', summary: 'Alice and Bob agree to speak honestly.' },
      { chapter: 'Chapter 4', summary: 'Alice confronts Bob about the letter.' },
      { chapter: 'Chapter 5', summary: 'A later event that should not leak into Chapter 4.' },
    ],
    recentExamples: [],
    characterVoices: [
      {
        characterId: 'char-alice', canonicalSourceName: 'Alice', targetName: '艾丽丝',
        aliases: [], status: 'confirmed', confidence: 0.95,
        voiceCore: { syntaxRhythm: ['短反问'] }, contrastRules: [],
        evidence: [{
          segmentId: 'ch1-p1', sourceQuote: 'Alice asked Bob',
          dimension: 'discourse', observation: '有明确的说话归属标记', confidence: 0.95,
        }],
        openQuestions: [],
      },
      {
        characterId: 'char-bob', canonicalSourceName: 'Bob', targetName: '鲍勃',
        aliases: [], status: 'confirmed', confidence: 0.8,
        voiceCore: { register: '简短回答' }, contrastRules: [],
        evidence: [{
          segmentId: 'ch1-p2', sourceQuote: 'Bob answered',
          dimension: 'register', observation: '简短回应', confidence: 0.8,
        }],
        openQuestions: [],
      },
    ],
    relationshipVoiceRules: [],
    voiceAnchors: [{
      anchorId: 'alice-cross-chapter', speakerId: 'char-alice', addresseeId: 'char-bob',
      source: 'You never listen to me.', target: '你从来不听我说话。',
      chapter: 'Chapter 1', segmentId: 'ch1-p1', status: 'approved', approvedBy: 'user',
      attributionEvidence: 'Alice asked Bob', attributionConfidence: 0.95, tags: ['reproach'],
    }],
    openQuestions: [],
  };
  const context = {
    project: { title: 'Example Novel', format: 'epub' },
    run: { sourceLang: 'en', targetLang: 'zh', translationMode: 'literary' },
    prompt: { config: { glossary: null }, userPromptTemplate: '' },
    memory,
  };
  const preceding = [{ id: 'previous-1', text: 'Alice asked Bob, “Will you listen?”', contextPath: 'Chapter 4' }];
  const translatable = [{ id: 'current-1', text: 'He looked away.', contextPath: 'Chapter 4' }];
  const prompt = buildUserPrompt('', translatable, context, preceding);
  const payloadStart = prompt.indexOf('{');
  const payload = JSON.parse(prompt.slice(payloadStart));

  assert.deepEqual(payload.segments.map((segment) => segment.id), ['current-1']);
  assert.deepEqual(payload.precedingSegments.map((segment) => segment.id), ['previous-1']);
  assert.equal(payload.voiceContext.scene.segmentIds.includes('previous-1'), false,
    'preceding source provides disambiguation only and must not become a translation output ID');
  assert.deepEqual(payload.voiceContext.characterVoices.map((profile) => profile.characterId), ['char-alice', 'char-bob']);
  assert.deepEqual(payload.voiceContext.voiceAnchors.map((anchor) => anchor.anchorId), ['alice-cross-chapter']);
  assert.deepEqual(
    payload.voiceContext.chapterSummaries.map((item) => item.chapter),
    ['Chapter 2', 'Chapter 3', 'Chapter 4'],
    'literary translation receives the current and preceding chapter summaries, but not future chapters',
  );
  assert.equal(payload.voiceContext.policyVersion, 'character-voice-v3');
});


test('literary context matches Latin character names as words, not accidental substrings', () => {
  const profile = (characterId, canonicalSourceName, targetName) => ({
    characterId, canonicalSourceName, targetName, aliases: [], status: 'confirmed', confidence: 0.9,
    voiceCore: { register: 'measured' }, contrastRules: [],
    evidence: [{
      segmentId: 'evidence-1', sourceQuote: canonicalSourceName + ' spoke',
      dimension: 'register', observation: 'observable speech pattern', confidence: 0.9,
    }],
    openQuestions: [],
  });
  const memory = {
    entities: [
      { source: 'Ann', target: '安', kind: 'person', aliases: [] },
      { source: 'Alice', target: '艾丽丝', kind: 'person', aliases: ['A.'] },
    ],
    relationships: [
      { subject: 'Ann', predicate: 'trusts', object: 'Unknown', reviewStatus: 'confirmed' },
    ],
    styleGuide: {},
    chapterSummaries: [
      { chapter: 'Chapter 10', summary: 'A later event.' },
      { chapter: 'Chapter 11', summary: 'Another later event.' },
    ],
    recentExamples: [],
    characterVoices: [
      profile('char-ann', 'Ann', '安'),
      profile('char-alice', 'Alice', '艾丽丝'),
    ],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  };
  const context = buildProjectVoiceContext(
    memory,
    [{ id: 'current', text: 'The annual report says Alice left. Annabelle stayed.' }],
    'Unmapped Chapter',
  );

  assert.deepEqual(context.chapterSummaries, [],
    'do not inject unscoped summaries that could describe unrelated or later chapters');
  assert.deepEqual(context.characterVoices.map((item) => item.characterId), ['char-alice']);
  assert.deepEqual(context.entities.map((item) => item.source), ['Alice']);
  assert.deepEqual(context.relationships, [],
    'relationship memory should not be injected just because an unrelated name is a substring');
});

test('single-letter aliases do not inject a character profile into unrelated prose', () => {
  const context = buildProjectVoiceContext({
    entities: [],
    relationships: [],
    styleGuide: {},
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [{
      characterId: 'char-alice', canonicalSourceName: 'Alice', targetName: '艾丽丝',
      aliases: ['A.'], status: 'confirmed', confidence: 0.9,
      voiceCore: { register: 'measured' }, contrastRules: [],
      evidence: [{
        segmentId: 'evidence-1', sourceQuote: 'Alice spoke.',
        dimension: 'register', observation: 'measured speech', confidence: 0.9,
      }],
      openQuestions: [],
    }],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  }, [{ id: 'current', text: 'A dog barked near the gate.' }], 'Chapter 1');

  assert.deepEqual(context.characterVoices, [],
    'the article "A" must not be treated as a reliable mention of the alias "A."');
});

test('document batch sessions isolate runs, roles, and batch indices while remaining stable across retries', async () => {
  const { buildDocumentBatchSessionScope } = await import('../src/documents/translationAgent.ts');
  const base = {
    projectId: 'project-a',
    runId: 'run-a',
    promptRevisionId: 'prompt-7',
    role: 'translation',
    translationMode: 'literary',
    batchIndex: 1,
  };
  const firstAttempt = buildDocumentBatchSessionScope(base);
  const retryAttempt = buildDocumentBatchSessionScope(base);
  assert.equal(firstAttempt, retryAttempt, 'a retry of the same batch should reuse its own session');
  assert.notEqual(
    firstAttempt,
    buildDocumentBatchSessionScope({ ...base, batchIndex: 2 }),
    'different batches must not serialize behind one shared session',
  );
  assert.notEqual(
    firstAttempt,
    buildDocumentBatchSessionScope({ ...base, runId: 'run-b' }),
    'different runs must not share implicit conversation history',
  );
  assert.notEqual(
    firstAttempt,
    buildDocumentBatchSessionScope({ ...base, role: 'review', memoryRevisionId: 'memory-3' }),
    'translation and review must use separate session scopes',
  );
});

test('document Agent budgets use six sessions while reserving reviewer capacity for literary runs', async () => {
  const { resolveDocumentRunConcurrencyBudget } = await import('../src/documents/translationAgent.ts');

  assert.deepEqual(resolveDocumentRunConcurrencyBudget(6, true, 6, 2), {
    poolSize: 6, translationConcurrency: 4, reviewConcurrency: 2, detachReviews: true,
  });
  assert.deepEqual(resolveDocumentRunConcurrencyBudget(6, false, 6, 2), {
    poolSize: 6, translationConcurrency: 6, reviewConcurrency: 0, detachReviews: false,
  });
  assert.deepEqual(resolveDocumentRunConcurrencyBudget(4, true, 4, 2), {
    poolSize: 4, translationConcurrency: 2, reviewConcurrency: 2, detachReviews: true,
  });
  assert.deepEqual(resolveDocumentRunConcurrencyBudget(4, false, 4, 2), {
    poolSize: 4, translationConcurrency: 4, reviewConcurrency: 0, detachReviews: false,
  });
  assert.deepEqual(resolveDocumentRunConcurrencyBudget(2, true, 4, 2), {
    poolSize: 2, translationConcurrency: 1, reviewConcurrency: 1, detachReviews: true,
  });
  assert.deepEqual(resolveDocumentRunConcurrencyBudget(1, true, 4, 2), {
    poolSize: 1, translationConcurrency: 1, reviewConcurrency: 1, detachReviews: false,
  });
});

test('document batch scheduler enforces the configured concurrency ceiling', async () => {
  const { runWithConcurrency } = await import('../src/documents/translationAgent.ts');
  let active = 0;
  let maxActive = 0;
  const finished = [];
  await runWithConcurrency(Array.from({ length: 12 }, (_, index) => index), 3, async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5 + (item % 3)));
    finished.push(item);
    active--;
  });
  assert.equal(maxActive, 3);
  assert.equal(finished.length, 12);
  assert.deepEqual([...finished].sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index));
});

test('document batch scheduler stops allocating pending batches after pause or cancellation', async () => {
  const { runWithConcurrency } = await import('../src/documents/translationAgent.ts');
  let stopped = false;
  const started = [];
  await runWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
    started.push(item);
    if (item === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      stopped = true;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }, () => stopped);
  assert.deepEqual(started.sort((a, b) => a - b), [0, 1]);
});

test('detached reviewer limiter never exceeds its own concurrency budget', async () => {
  const { createConcurrencyLimiter } = await import('../src/documents/translationAgent.ts');
  const limit = createConcurrencyLimiter(2);
  let active = 0;
  let maxActive = 0;
  await Promise.all(Array.from({ length: 7 }, (_, index) => limit(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5 + (index % 2)));
    active--;
  })));
  assert.equal(maxActive, 2);
});
test('document batch scheduler stops adding queued work after a fatal worker error', async () => {
  const { runWithConcurrency } = await import('../src/documents/translationAgent.ts');
  const started = [];
  await assert.rejects(runWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
    started.push(item);
    if (item === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      throw new Error('simulated persistence failure');
    }
    await new Promise((resolve) => setTimeout(resolve, 12));
  }), /simulated persistence failure/);
  assert.deepEqual(started.sort((a, b) => a - b), [0, 1],
    'already-running work may settle, but new queued batches should not start');
});


test('literary translation batches are slightly larger but remain bounded by segment and source-character limits', () => {
  const manyShortSegments = Array.from({ length: 33 }, (_, index) => ({
    id: 'short-' + index,
    text: 'A short sentence.',
    contextPath: 'Chapter 1',
  }));
  assert.deepEqual(buildBatches(manyShortSegments, true).map((batch) => batch.length), [16, 16, 1]);

  const longSegments = Array.from({ length: 5 }, (_, index) => ({
    id: 'long-' + index,
    text: 'x'.repeat(4_100),
    contextPath: 'Chapter 1',
  }));
  assert.deepEqual(buildBatches(longSegments, true).map((batch) => batch.length), [1, 1, 1, 1, 1],
    'two 4,100-character segments must not exceed the 8,000-character aggregate budget');

  const chapterBoundaries = buildBatches([
    { id: 'a', text: 'First chapter.', contextPath: 'Chapter 1' },
    { id: 'b', text: 'Second chapter.', contextPath: 'Chapter 2' },
  ], true);
  assert.deepEqual(chapterBoundaries.map((batch) => batch.map((item) => item.id)), [['a'], ['b']],
    'literary batches must never cross chapter boundaries');
});

test('document translation strategy is configurable but server-side bounds cannot be bypassed', () => {
  const strategy = normalizeDocumentTranslationStrategy({
    maxBatchSegments: 20,
    maxBatchSourceChars: 10000,
    translationConcurrency: 5,
    reviewConcurrency: 3,
    precedingContextSegments: 6,
    contextBudgetChars: 12000,
    maxModelAttempts: 1,
  });
  assert.deepEqual(strategy, {
    maxBatchSegments: 20,
    maxBatchSourceChars: 10000,
    translationConcurrency: 5,
    reviewConcurrency: 3,
    precedingContextSegments: 6,
    contextBudgetChars: 12000,
    maxModelAttempts: 1,
  });

  const bounded = normalizeDocumentTranslationStrategy({
    maxBatchSegments: 999,
    maxBatchSourceChars: 99999,
    translationConcurrency: 0,
    reviewConcurrency: 999,
    precedingContextSegments: -1,
    contextBudgetChars: 99999,
    maxModelAttempts: 9,
  });
  assert.equal(bounded.maxBatchSegments, 24);
  assert.equal(bounded.maxBatchSourceChars, 12000);
  assert.equal(bounded.translationConcurrency, 1);
  assert.equal(bounded.reviewConcurrency, 4);
  assert.equal(bounded.precedingContextSegments, 0);
  assert.equal(bounded.contextBudgetChars, 18000);
  assert.equal(bounded.maxModelAttempts, 2);
});

test('batch planner honors per-run chunk sizing preferences', () => {
  const segments = Array.from({ length: 17 }, (_, index) => ({
    id: 'configured-' + index,
    text: 'Short source segment.',
    contextPath: 'Chapter 1',
  }));
  assert.deepEqual(
    buildBatches(segments, true, { maxBatchSegments: 8, maxBatchSourceChars: 8000 }).map((batch) => batch.length),
    [8, 8, 1],
  );
});


test('evidence-backed automatic name mappings protect and restore canonical terms deterministically', () => {
  const items = [
    { id: 'p1', text: 'Timsen had been taken up by the King.' },
    { id: 'p2', text: 'But Timsen would not allow the King to see through him.' },
  ];
  const graph = {
    nameMappings: [{
      source: 'the King',
      target: '国王',
      aliases: ['King'],
      sourceStatus: 'auto',
    }],
  };
  const protections = buildCanonicalTermProtections(items, graph);
  assert.ok(protections.length >= 1);
  const masked = maskCanonicalTermText(items[0].text, protections);
  assert.match(masked, /__VSA_TERM_000__/);
  assert.equal(
    restoreCanonicalTermMarkers(masked, protections),
    'Timsen had been taken up by 国王.',
  );
  assert.equal(
    maskCanonicalTermText('The Kingfisher sat near the camp.', protections),
    'The Kingfisher sat near the camp.',
    'Latin name mappings must not match inside longer words',
  );
});

test('candidate-only or conflicting name mappings are not forced into translation output', () => {
  const items = [{ id: 'p1', text: 'The King arrived.' }];
  const candidate = buildCanonicalTermProtections(items, {
    nameMappings: [{ source: 'the King', target: '国王', aliases: [], sourceStatus: 'candidate' }],
  });
  assert.deepEqual(candidate, [], 'unactivated candidate mappings remain advisory');
  const conflict = buildCanonicalTermProtections(items, {
    nameMappings: [
      { source: 'the King', target: '国王', aliases: [], sourceStatus: 'auto' },
      { source: 'the King', target: '大王', aliases: [], sourceStatus: 'auto' },
    ],
  });
  assert.deepEqual(conflict, [], 'conflicting targets must not be selected arbitrarily');
});

test('buildUserPrompt masks automatically active entity names in source segments', () => {
  const context = {
    project: { title: 'Novel', format: 'epub' },
    run: { sourceLang: 'en', targetLang: 'zh', translationMode: 'literary' },
    prompt: { config: {}, userPromptTemplate: '' },
    memory: {},
  };
  const graph = {
    nameMappings: [{ source: 'the King', target: '国王', aliases: [], sourceStatus: 'auto' }],
  };
  const prompt = buildUserPrompt('', [{ id: 'p1', text: 'The King took him away.' }], context, [], graph);
  const payload = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.match(payload.segments[0].text, /__VSA_TERM_000__/);
  assert.equal(payload.contextGraph.nameMappings[0].target, '国王');
});


test('literary Reviewers receive protected canonical names in both source and draft', () => {
  const graph = {
    nameMappings: [{
      source: 'the King',
      target: '国王',
      aliases: ['King'],
      sourceStatus: 'auto',
    }],
  };
  const input = [{
    id: 'p1',
    source: 'But Timsen was much too clever to allow the King to see through him.',
    draft: '可廷森精得很，绝不会让国王看穿他。',
  }];
  const result = protectCanonicalReviewSegments(input, graph);
  assert.ok(result.protections.length > 0);
  assert.match(result.segments[0].source, /__VSA_TERM_000__/);
  assert.match(result.segments[0].draft, /__VSA_TERM_000__/);
  assert.equal(result.segments[0].source.includes('the King'), false);
  assert.equal(result.segments[0].draft.includes('国王'), false);
  assert.equal(
    restoreCanonicalTermMarkers(result.segments[0].draft, result.protections),
    '可廷森精得很，绝不会让国王看穿他。',
  );
});


test('Reviewer findings require excerpts grounded in the actual source and draft', () => {
  assert.equal(
    isLiteraryReviewFindingGrounded(
      'The King entered the storehouse.',
      '大王走进了仓库。',
      'The King entered',
      '大王走进了仓库',
    ),
    true,
  );
  assert.equal(
    isLiteraryReviewFindingGrounded(
      'The King entered the storehouse.',
      '大王走进了仓库。',
      'The Queen entered',
      '大王走进了仓库',
    ),
    false,
    'a fabricated source excerpt must not authorize an automatic rewrite',
  );
  assert.equal(
    isLiteraryReviewFindingGrounded(
      'The King entered the storehouse.',
      '大王走进了仓库。',
      'The King entered',
      '国王走进了宫殿',
    ),
    false,
    'a draft excerpt absent from the submitted translation must not authorize an automatic rewrite',
  );
  assert.equal(
    isLiteraryReviewFindingGrounded('The King entered.', '国王进来了。', '', '国王进来了。'),
    false,
    'findings without source evidence remain non-actionable',
  );
});


test('standalone re-review receives explicit canonical mappings without future-only aliases', () => {
  const input = {
    segments: [{
      id: 'current',
      source: 'But Timsen was much too clever to allow the King to see through him.',
      draft: '可廷森精得很，绝不会让大王看穿他。',
    }],
    precedingSegments: [{ id: 'prior', text: 'The King was known around the camp.', contextPath: 'Chapter 1' }],
    memory: {
      entities: [{
        source: 'the King', target: '国王', aliases: ['King', 'Pirate Queen'],
        reviewStatus: 'confirmed', kind: 'person',
      }],
    },
  };
  const graph = buildStandaloneReviewContextGraph(input);
  const mapping = graph.nameMappings.find((item) => item.source === 'the King');
  assert.equal(mapping?.target, '国王');
  assert.ok(mapping?.aliases.includes('King'));
  assert.ok(!mapping?.aliases.includes('Pirate Queen'),
    'the legacy Review endpoint must not serialize an alias that appears only in future book memory');
  const protections = buildCanonicalTermProtections(input.segments.map((item) => ({ id: item.id, text: item.source })), graph);
  assert.ok(protections.some((item) => item.target === '国王'),
    'standalone re-review must use the same deterministic canonical-name protection as Project Runs');
});
