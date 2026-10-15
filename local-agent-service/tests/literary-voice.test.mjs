import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeVoiceAnalysis } from '../src/literary.ts';
import { buildProjectVoiceContext, sanitizeProjectLiteraryMemory } from '../src/documents/voiceContext.ts';

const sourceSegments = [
  { id: 'ch1-a1', text: 'Alice looked at Bob. “You really think so?”' },
  { id: 'ch1-b1', text: 'The evidence is clear.' },
];

test('voice analysis assigns stable character IDs and rejects unsupported evidence', () => {
  const priorMemory = {
    version: 2,
    entities: [],
    relationships: [],
    styleGuide: {},
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [{
      characterId: 'char_existing_alice',
      canonicalSourceName: 'Alice',
      status: 'confirmed',
      confidence: 0.9,
      aliases: ['Miss Alice'],
      voiceCore: { syntaxRhythm: ['短反问'] },
      contrastRules: [],
      evidence: [{
        segmentId: 'ch1-a1',
        sourceQuote: 'You really think so?',
        dimension: 'syntax_rhythm',
        observation: '以短反问回应质疑',
        confidence: 0.9,
      }],
      openQuestions: [],
    }],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  };
  const parsed = {
    characterVoices: [
      {
        characterId: 'random-model-id-17',
        canonicalSourceName: 'Alice',
        aliases: ['Alice'],
        status: 'confirmed',
        confidence: 0.95,
        voiceCore: { syntaxRhythm: ['每句都添加感叹号'] },
        evidence: [{
          segmentId: 'ch1-a1',
          sourceQuote: 'You really think so?',
          dimension: 'syntax_rhythm',
          observation: '先用短反问表达怀疑',
          confidence: 0.9,
        }],
      },
      {
        characterId: 'random-model-id-bob',
        canonicalSourceName: 'Bob',
        status: 'confirmed',
        confidence: 0.75,
        voiceCore: { register: '先给结论再补充理由' },
        evidence: [{
          segmentId: 'ch1-b1',
          sourceQuote: 'The evidence is clear.',
          dimension: 'register',
          observation: '完整陈述结论',
          confidence: 0.75,
        }],
      },
      {
        characterId: 'unreliable-id',
        canonicalSourceName: 'Unknown',
        status: 'confirmed',
        confidence: 0.99,
        voiceCore: { register: '高贵、优雅' },
        evidence: [{
          segmentId: 'ch1-a1',
          sourceQuote: 'This quote is not in the source.',
          dimension: 'register',
          observation: '模型声称但没有对应原文',
          confidence: 0.99,
        }],
      },
    ],
    relationshipVoiceRules: [{
      speakerId: 'random-model-id-17',
      addresseeId: 'random-model-id-bob',
      status: 'confirmed',
      baselineRegister: '直接但不亲昵',
      addressTerms: ['Bob'],
      evidenceSegmentIds: ['ch1-a1', 'missing-segment'],
    }],
    voiceAnchors: [
      {
        anchorId: 'random-anchor',
        speakerId: 'random-model-id-17',
        source: 'You really think so?',
        target: '你真这么认为？',
        segmentId: 'ch1-a1',
        status: 'approved',
        approvedBy: 'user',
        tags: ['question'],
      },
      {
        anchorId: 'invalid-anchor',
        speakerId: 'random-model-id-17',
        source: 'Not actually in source',
        target: '并非原文',
        segmentId: 'ch1-a1',
        status: 'approved',
        approvedBy: 'user',
        tags: [],
      },
    ],
    openQuestions: [],
  };

  const normalized = stabilizeVoiceAnalysis(priorMemory, parsed, sourceSegments);
  const alice = normalized.characterVoices.find((profile) => profile.canonicalSourceName === 'Alice');
  assert.equal(alice.characterId, 'char_existing_alice', 'an existing character id is stable across chapters');
  assert.equal(alice.status, 'confirmed', 'new analysis cannot silently demote a confirmed profile');
  assert.equal(alice.voiceCore.syntaxRhythm[0], '短反问', 'new chapters cannot silently overwrite a confirmed voice core');
  assert.ok(normalized.openQuestions.some((question) => question.includes('Alice') && question.includes('差异')));
  assert.equal(normalized.characterVoices.some((profile) => profile.canonicalSourceName === 'Unknown'), false);

  const bob = normalized.characterVoices.find((profile) => profile.canonicalSourceName === 'Bob');
  assert.ok(bob.characterId.startsWith('char_'));
  const repeat = stabilizeVoiceAnalysis(priorMemory, parsed, sourceSegments);
  assert.equal(repeat.characterVoices.find((profile) => profile.canonicalSourceName === 'Bob').characterId, bob.characterId);

  assert.deepEqual(normalized.relationshipVoiceRules[0].evidenceSegmentIds, ['ch1-a1']);
  assert.equal(normalized.relationshipVoiceRules[0].speakerId, 'char_existing_alice');
  assert.equal(normalized.relationshipVoiceRules[0].addresseeId, bob.characterId);
  assert.equal(normalized.voiceAnchors.length, 1);
  assert.equal(normalized.voiceAnchors[0].status, 'candidate', 'analysis can never approve a voice anchor');
  assert.equal(normalized.voiceAnchors[0].approvedBy, 'reviewer');
});

test('project voice context includes confirmed profiles and approved anchors only', () => {
  const memory = sanitizeProjectLiteraryMemory({
    version: 2,
    entities: [{ source: 'Alice', target: '艾丽丝', kind: 'person', aliases: [], reviewStatus: 'confirmed' }],
    relationships: [],
    styleGuide: { narrativeVoice: '克制的第三人称' },
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [
      {
        characterId: 'char-alice', canonicalSourceName: 'Alice', aliases: [], status: 'confirmed', confidence: 0.9,
        voiceCore: { syntaxRhythm: ['使用简短反问'] }, contrastRules: [],
        evidence: [{ segmentId: 'ch1-a1', sourceQuote: 'You really think so?', dimension: 'discourse', observation: '简短反问', confidence: 0.9 }],
      },
      {
        characterId: 'char-candidate', canonicalSourceName: 'Unknown', aliases: [], status: 'candidate', confidence: 0.4,
        voiceCore: { register: '猜测性的语域' }, contrastRules: [],
        evidence: [{ segmentId: 'ch1-b1', sourceQuote: 'The evidence is clear.', dimension: 'register', observation: '候选声音', confidence: 0.4 }],
      },
    ],
    relationshipVoiceRules: [],
    voiceAnchors: [
      { anchorId: 'approved', speakerId: 'char-alice', source: 'You really think so?', target: '你真这么认为？', segmentId: 'ch1-a1', status: 'approved', approvedBy: 'user', tags: [] },
      { anchorId: 'candidate', speakerId: 'char-alice', source: 'The evidence is clear.', target: '证据很清楚。', segmentId: 'ch1-b1', status: 'candidate', approvedBy: 'reviewer', tags: [] },
    ],
  });
  const context = buildProjectVoiceContext(memory, [{
    id: 'ch1-a1',
    text: 'Alice looked at Bob. “You really think so?”',
    contextPath: 'Chapter 1',
  }]);
  const roundTrip = JSON.parse(JSON.stringify(context));
  assert.equal(roundTrip.characterVoices.length, 1);
  assert.equal(roundTrip.characterVoices[0].characterId, 'char-alice');
  assert.deepEqual(roundTrip.voiceAnchors.map((anchor) => anchor.anchorId), ['approved']);
  assert.ok(JSON.stringify(roundTrip).length < 9000);
  assert.match(roundTrip.constraints.join(' '), /不确定说话人/);
});
