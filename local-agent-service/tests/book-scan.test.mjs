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

test('CJK scans surface word candidates and repeated dialogue without whitespace-token assumptions', () => {
  const japanese = [
    { id: 'ja-1', ordinal: 0, contextPath: '第一章', kind: 'dialogue', text: '桜花は言った。「西の灯を消さないでください。」' },
    { id: 'ja-2', ordinal: 12, contextPath: '第二章', kind: 'dialogue', text: '桜花はもう一度言った。「西の灯を消さないでください。」' },
    { id: 'ja-3', ordinal: 24, contextPath: '第七章', kind: 'dialogue', text: '「西の灯を消さないでください」と桜花は頼んだ。' },
  ];
  const japaneseScan = scanBookSegments(japanese);
  assert.ok(japaneseScan.nameCandidates.some((candidate) => candidate.name === '桜花'));
  assert.ok(japaneseScan.repeatedPhrases.some((phrase) => phrase.count === 3 && phrase.chapterKeys.length === 3));

  const chinese = [
    { id: 'zh-1', ordinal: 0, contextPath: '第一章', kind: 'dialogue', text: '林海对王明说道：“不要熄灭西边的灯光。”' },
    { id: 'zh-2', ordinal: 12, contextPath: '第二章', kind: 'dialogue', text: '林海看向王明，再次说道：“不要熄灭西边的灯光。”' },
    { id: 'zh-3', ordinal: 24, contextPath: '第七章', kind: 'dialogue', text: '“不要熄灭西边的灯光。”林海低声重复道。' },
  ];
  const chineseScan = scanBookSegments(chinese);
  assert.ok(chineseScan.nameCandidates.some((candidate) => candidate.name === '林海'));
  assert.ok(chineseScan.repeatedPhrases.some((phrase) => phrase.count === 3));
});
