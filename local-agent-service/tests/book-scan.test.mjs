import test from 'node:test';
import assert from 'node:assert/strict';
import { planBookSamples, scanBookSegments } from '../src/documents/bookScan.ts';

function makeSegments() {
  const segments = [];
  for (let index = 0; index < 90; index++) {
    const chapter = Math.floor(index / 10) + 1;
    let text = 'A quiet passage leads deeper into the archive.';
    if (index % 4 === 0) text = 'Mara spoke to Iven: “Keep the western lamp burning.”';
    if (index % 7 === 0) text = 'Captain Vale asked Mara about the western lamp.';
    if ([3, 43, 83].includes(index)) text = 'Keep the western lamp burning before the last door opens.';
    segments.push({
      id: 'seg-' + String(index + 1).padStart(3, '0'),
      ordinal: index,
      contextPath: 'Chapter ' + chapter,
      kind: text.includes('“') ? 'dialogue' : 'paragraph',
      text,
    });
  }
  return segments;
}

test('book scan covers every chapter and ranks candidates across the full source', () => {
  const segments = makeSegments();
  const scan = scanBookSegments(segments);
  assert.equal(scan.segmentCount, 90);
  assert.equal(scan.chapterCount, 9);
  assert.equal(scan.chapters[0].firstSegmentId, 'seg-001');
  assert.equal(scan.chapters[8].lastSegmentId, 'seg-090');
  assert.ok(scan.dialogueSegmentCount > 10);
  assert.ok(scan.nameCandidates.some((candidate) => candidate.name === 'Mara'));
  assert.ok(scan.repeatedPhrases.some((phrase) => phrase.count >= 3));
});

test('adaptive sampling keeps book endpoints and adds early/middle/late samples for recurring characters', () => {
  const segments = makeSegments();
  const plan = planBookSamples(segments, scanBookSegments(segments), 60);
  const selectedIds = new Set(plan.samples.map((item) => item.segment.id));
  assert.ok(selectedIds.has('seg-001'));
  assert.ok(selectedIds.has('seg-046') || selectedIds.has('seg-045'));
  assert.ok(selectedIds.has('seg-090'));
  const maraSamples = plan.samples.filter((item) => item.reasons.some((reason) => reason.endsWith(':Mara')));
  assert.ok(maraSamples.some((item) => item.reasons.includes('entity-early:Mara')));
  assert.ok(maraSamples.some((item) => item.reasons.includes('entity-middle:Mara')));
  assert.ok(maraSamples.some((item) => item.reasons.includes('entity-late:Mara')));
  assert.ok(plan.diagnostics.selectedSampleCount <= 60);
  assert.ok(plan.diagnostics.targetedNameCount > 0);
});

test('sampling is deterministic, bounded, and records why each segment was selected', () => {
  const segments = makeSegments();
  const first = planBookSamples(segments, undefined, 48);
  const second = planBookSamples(segments, undefined, 48);
  assert.deepEqual(first.samples, second.samples);
  assert.ok(first.samples.length <= 48);
  assert.ok(first.samples.every((sample) => sample.reasons.length > 0));
  assert.ok(first.samples.some((sample) => sample.reasons.some((reason) => reason.startsWith('dialogue-density:'))));
  assert.ok(first.samples.some((sample) => sample.reasons.some((reason) => reason.startsWith('repeated-phrase:'))));
});

test('short documents keep all source segments and do not truncate the sample set', () => {
  const segments = makeSegments().slice(0, 12);
  const plan = planBookSamples(segments);
  assert.equal(plan.samples.length, segments.length);
  assert.ok(plan.samples.every((sample) => sample.reasons.includes('complete-short-document')));
});
