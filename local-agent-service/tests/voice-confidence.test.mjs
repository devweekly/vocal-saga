import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProjectLiteraryMemory } from '../src/documents/voiceContext.ts';
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

test('legacy scored literary profiles remain model-self-reported and explicit null is not coerced to zero', () => {
  const memory = sanitizeProjectLiteraryMemory({
    characterVoices: [
      {
        characterId: 'char-alice',
        canonicalSourceName: 'Alice',
        status: 'candidate',
        confidence: 0.82,
        voiceCore: { register: 'measured' },
        evidence: [{
          segmentId: 's1',
          sourceQuote: 'Alice spoke softly.',
          dimension: 'register',
          observation: 'quiet register',
          confidence: 0.76,
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
