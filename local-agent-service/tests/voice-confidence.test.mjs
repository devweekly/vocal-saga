import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectVoiceContext, sanitizeProjectLiteraryMemory } from '../src/documents/voiceContext.ts';
import { stabilizeVoiceAnalysis } from '../src/literary.ts';

test('legacy Context Graph 0.55 is sanitized as unassessed, not as a model score', () => {
  const memory = sanitizeProjectLiteraryMemory({
    characterVoices: [{
      characterId: 'context-graph-cg-legacy',
      canonicalSourceName: 'Alice',
      status: 'candidate',
      confidence: 0.55,
      voiceCore: { register: 'candidate observation' },
      evidence: [{
        segmentId: 's1',
        sourceQuote: 'Alice spoke softly.',
        dimension: 'register',
        observation: 'quiet register',
        confidence: 0.55,
      }],
    }],
  });

  assert.equal(memory.characterVoices[0].confidence, null);
  assert.equal(memory.characterVoices[0].confidenceSource, undefined);
  assert.equal(memory.characterVoices[0].evidence[0].confidence, null);
  assert.equal(memory.characterVoices[0].evidence[0].confidenceSource, undefined);
});

test('only provenance-tagged model scores survive sanitization; explicit null is not coerced to zero', () => {
  const memory = sanitizeProjectLiteraryMemory({
    characterVoices: [
      {
        characterId: 'char-alice',
        canonicalSourceName: 'Alice',
        status: 'candidate',
        confidence: 0.82,
        confidenceSource: 'model_self_report',
        voiceCore: { register: 'measured' },
        evidence: [{
          segmentId: 's1',
          sourceQuote: 'Alice spoke softly.',
          dimension: 'register',
          observation: 'quiet register',
          confidence: 0.76,
          confidenceSource: 'model_self_report',
        }],
      },
      {
        characterId: 'char-bob',
        canonicalSourceName: 'Bob',
        status: 'candidate',
        confidence: null,
        voiceCore: { register: 'unknown' },
        evidence: [{
          segmentId: 's2',
          sourceQuote: 'Bob looked away.',
          dimension: 'discourse',
          observation: 'insufficient evidence',
          confidence: null,
        }],
      },
    ],
  });

  assert.equal(memory.characterVoices[0].confidence, 0.82);
  assert.equal(memory.characterVoices[0].confidenceSource, 'model_self_report');
  assert.equal(memory.characterVoices[0].evidence[0].confidence, 0.76);
  assert.equal(memory.characterVoices[0].evidence[0].confidenceSource, 'model_self_report');
  assert.equal(memory.characterVoices[1].confidence, null);
  assert.equal(memory.characterVoices[1].confidenceSource, undefined);
  assert.equal(memory.characterVoices[1].evidence[0].confidence, null);
  assert.equal(memory.characterVoices[1].evidence[0].confidenceSource, undefined);
});


test('evidence-backed candidate voice profiles are included by default; disabled profiles are excluded', () => {
  const memory = {
    characterVoices: [
      {
        characterId: 'char-alice',
        canonicalSourceName: 'Alice',
        status: 'candidate',
        role: 'a young officer',
        traits: ['measured'],
        voiceCore: { register: 'brief and restrained' },
        evidence: [{
          segmentId: 's1', sourceQuote: 'Alice answered quietly.',
          dimension: 'register', observation: 'brief answer', confidence: null,
        }],
      },
      {
        characterId: 'char-bob',
        canonicalSourceName: 'Bob',
        status: 'candidate',
        useForTranslation: false,
        role: 'disabled role',
        voiceCore: { register: 'do not include' },
        evidence: [{
          segmentId: 's2', sourceQuote: 'Bob shouted loudly.',
          dimension: 'register', observation: 'loud answer', confidence: null,
        }],
      },
    ],
  };
  const context = buildProjectVoiceContext(memory, [
    { id: 'current', text: 'Alice answered, then Bob shouted.', contextPath: 'Chapter 1' },
  ], 'Chapter 1');
  const voices = context.characterVoices;
  assert.deepEqual(voices.map((profile) => profile.characterId), ['char-alice']);
  assert.equal(voices[0].useForTranslation, true);
  assert.equal(voices[0].role, 'a young officer');
  assert.deepEqual(voices[0].traits, ['measured']);
});


test('literary analysis does not invent a 0.4 confidence when the model omits it', () => {
  const result = stabilizeVoiceAnalysis({}, {
    characterVoices: [{
      characterId: 'model-alice',
      canonicalSourceName: 'Alice',
      status: 'candidate',
      voiceCore: { register: 'measured' },
      evidence: [{
        segmentId: 's1',
        sourceQuote: 'Alice spoke softly.',
        dimension: 'register',
        observation: 'quiet register',
      }],
    }],
  }, [{ id: 's1', text: 'Alice spoke softly.' }]);

  assert.equal(result.characterVoices[0].confidence, null);
  assert.equal(result.characterVoices[0].confidenceSource, undefined);
  assert.equal(result.characterVoices[0].evidence[0].confidence, null);
  assert.equal(result.characterVoices[0].evidence[0].confidenceSource, undefined);
});

test('valid numeric scores are retained with explicit model-self-report provenance', () => {
  const result = stabilizeVoiceAnalysis({}, {
    characterVoices: [{
      characterId: 'model-alice',
      canonicalSourceName: 'Alice',
      status: 'candidate',
      confidence: 0.83,
      voiceCore: { register: 'measured' },
      evidence: [{
        segmentId: 's1',
        sourceQuote: 'Alice spoke softly.',
        dimension: 'register',
        observation: 'quiet register',
        confidence: 0.74,
      }],
    }],
  }, [{ id: 's1', text: 'Alice spoke softly.' }]);

  assert.equal(result.characterVoices[0].confidence, 0.83);
  assert.equal(result.characterVoices[0].confidenceSource, 'model_self_report');
  assert.equal(result.characterVoices[0].evidence[0].confidence, 0.74);
  assert.equal(result.characterVoices[0].evidence[0].confidenceSource, 'model_self_report');
});
