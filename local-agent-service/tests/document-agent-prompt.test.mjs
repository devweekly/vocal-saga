import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserPrompt } from '../src/documents/translationAgent.ts';

test('literary Project Agent separates preceding context from translatable segments', () => {
  const memory = {
    version: 2,
    entities: [],
    relationships: [],
    styleGuide: { narrativeVoice: '克制的第三人称' },
    chapterSummaries: [],
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

