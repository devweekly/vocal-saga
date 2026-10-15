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
  assert.match(prompt, /precedingSegments 是前文只读上下文/);
});
