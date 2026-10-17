import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTranslationContextDelta,
  mergeTranslationContextDeltasIntoMemory,
  emptyTranslationContextDelta,
} from '../src/documents/translationContextDelta.ts';

test('accepts entity candidates only when the evidence belongs to the current input batch', () => {
  const segments = [
    { id: 'segment-17', text: 'The King shot a murderous glance at Max.' },
    { id: 'segment-18', text: 'Grey looked back at the King.' },
  ];
  const translations = new Map([
    ['segment-17', '国王朝麦克斯投去凶狠的一眼。'],
    ['segment-18', '格雷回望着国王。'],
  ]);
  const result = validateTranslationContextDelta({
    entity_candidates: [{
      local_id: 'king',
      canonical_source: 'The King',
      aliases: ['King'],
      kind: 'character_epithet',
      target_proposal: '国王',
      evidence: [{ segment_id: 'segment-17', quote: 'The King shot a murderous glance at Max.' }],
    }],
    entity_mentions: [
      { segment_id: 'segment-17', source_quote: 'The King', entity_ref: 'king', target_surface: '国王' },
      // 目标表面不在译文里，不可以作为已核实的实体落点保存。
      { segment_id: 'segment-18', source_quote: 'the King', entity_ref: 'king', target_surface: '大王' },
    ],
  }, segments, translations, 'attempt-1:', []);

  assert.equal(result.delta.entityCandidates.length, 1);
  assert.equal(result.delta.entityCandidates[0].localId, 'attempt-1:king');
  assert.equal(result.delta.entityCandidates[0].targetProposal, '国王');
  assert.deepEqual(result.delta.entityCandidates[0].aliases, ['King']);
  assert.equal(result.delta.entityMentions.length, 1);
  assert.equal(result.delta.entityMentions[0].targetSurface, '国王');
  assert.equal(result.diagnostics.rejectedEntityMentions, 1);
});

test('discards context claims whose source quote is missing or from another batch', () => {
  const result = validateTranslationContextDelta({
    entity_candidates: [{
      local_id: 'king',
      canonical_source: 'The King',
      aliases: [],
      kind: 'character',
      target_proposal: '大王',
      evidence: [{ segment_id: 'previous-segment', quote: 'The King shot a murderous glance at Max.' }],
    }],
    open_questions: [{
      question: 'Is Grey talking to the King?',
      evidence: [{ segment_id: 'current', quote: 'this quotation does not exist in the source' }],
    }],
  }, [{ id: 'current', text: 'Grey turned away without speaking.' }], new Map([['current', '格雷转过身，没有说话。']]));

  assert.equal(result.delta.entityCandidates.length, 0);
  assert.equal(result.delta.openQuestions.length, 0);
  assert.equal(result.diagnostics.rejectedEntityCandidates, 1);
  assert.equal(result.diagnostics.rejectedOpenQuestions, 1);
});

test('merging context candidates never replaces a confirmed canonical translation', () => {
  const originalMemory = {
    entities: [{
      source: 'The King', target: '国王', kind: 'character_epithet',
      aliases: ['King'], evidence: 'The King addressed Max.', reviewStatus: 'confirmed',
    }],
    relationships: [],
    openQuestions: [],
  };
  const delta = emptyTranslationContextDelta();
  delta.entityCandidates.push({
    localId: 'later-king',
    canonicalSource: 'The King',
    aliases: ['His Majesty'],
    kind: 'character_epithet',
    targetProposal: '大王',
    evidence: [{ segmentId: 'segment-30', sourceQuote: 'The King addressed Max.' }],
  });

  const merged = mergeTranslationContextDeltasIntoMemory(originalMemory, [delta]);
  assert.equal(merged.memory.entities[0].target, '国王');
  assert.equal(merged.memory.entities[0].reviewStatus, 'confirmed');
  assert.equal(merged.memory.entities[0].aliases.includes('His Majesty'), false);
  assert.equal(merged.summary.entityTargetConflicts, 1);
  assert.ok(merged.memory.openQuestions.some((item) => item.includes('“大王”')));
});

test('source-ordered merging preserves the first candidate and records later conflicting renderings', () => {
  const first = emptyTranslationContextDelta();
  first.entityCandidates.push({
    localId: 'first', canonicalSource: 'The King', aliases: ['King'], kind: 'character_epithet',
    targetProposal: '国王', evidence: [{ segmentId: 'segment-10', sourceQuote: 'The King looked at Max.' }],
  });
  const second = emptyTranslationContextDelta();
  second.entityCandidates.push({
    localId: 'second', canonicalSource: 'The King', aliases: ['The King'], kind: 'character_epithet',
    targetProposal: '大王', evidence: [{ segmentId: 'segment-30', sourceQuote: 'The King addressed Max.' }],
  });

  const merged = mergeTranslationContextDeltasIntoMemory({ entities: [], relationships: [], openQuestions: [] }, [first, second]);
  assert.equal(merged.memory.entities.length, 1);
  assert.equal(merged.memory.entities[0].target, '国王');
  assert.ok(merged.memory.openQuestions.some((item) => item.includes('大王')));
  assert.equal(merged.summary.entityTargetConflicts, 1);
});
