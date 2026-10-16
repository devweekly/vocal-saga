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

test('English source scan detects repeated quoted dialogue despite changing speaker attribution', () => {
  const segments = [
    {
      id: 'en-1', ordinal: 0, contextPath: 'Chapter 1', kind: 'dialogue',
      text: '“Keep the western lamp burning.” Mara said to Iven.',
    },
    {
      id: 'en-2', ordinal: 12, contextPath: 'Chapter 2', kind: 'dialogue',
      text: 'Mara repeated the warning: “Keep the western lamp burning.”',
    },
    {
      id: 'en-3', ordinal: 24, contextPath: 'Chapter 7', kind: 'dialogue',
      text: '“Keep the western lamp burning,” Mara whispered as she left.',
    },
  ];
  const scan = scanBookSegments(segments);
  const repeatedLine = scan.repeatedPhrases.find((phrase) =>
    phrase.normalized === 'keep the western lamp burning');
  assert.ok(repeatedLine);
  assert.equal(repeatedLine.count, 3);
  assert.equal(repeatedLine.chapterKeys.length, 3);
  assert.ok(scan.nameCandidates.some((candidate) => candidate.name === 'Mara'));
});

test('English scan retains recurring full names as separate sampling candidates', () => {
  const segments = [
    { id: 'name-1', ordinal: 0, contextPath: 'Chapter 1', text: 'Mara Voss entered the archive before dawn.' },
    { id: 'name-2', ordinal: 4, contextPath: 'Chapter 3', text: 'Mara spoke with Iven near the western lamp.' },
    { id: 'name-3', ordinal: 8, contextPath: 'Chapter 5', text: 'Mara Voss returned the brass key to Vale.' },
    { id: 'name-4', ordinal: 12, contextPath: 'Chapter 8', text: 'Mara Voss told Iven to leave before midnight.' },
  ];
  const scan = scanBookSegments(segments);
  const fullName = scan.nameCandidates.find((candidate) => candidate.name === 'Mara Voss');
  assert.ok(fullName);
  assert.equal(fullName.mentions, 3);
  assert.equal(fullName.chapterCount, 3);
  assert.equal(fullName.regionCount, 3);
});
