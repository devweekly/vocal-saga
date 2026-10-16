import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-translation-brief-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');

const { getDocumentProjectStore } = await import('../src/documents/projectStore.ts');
const { buildTranslationBrief, MAX_TRANSLATION_BRIEF_CHARS } = await import('../src/documents/translationBrief.ts');
const { buildBatches } = await import('../src/documents/translationAgent.ts');

test('TranslationBrief is revision-pinned, bounded and hashes the source selection', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Brief Test',
    format: 'txt',
    sourceFileName: 'brief-test.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'c1-1', text: 'Mara Voss entered the archive.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'c1-2', text: 'Keep the western lamp burning.', kind: 'dialogue', contextPath: 'Chapter 1' },
      { id: 'c2-1', text: 'Iven returned at midnight.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  const run = store.createRun(project.projectId, {
    scope: { type: 'ids', ids: ['c1-1', 'c1-2'] },
  });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 });
  const first = buildTranslationBrief(context, source.slice(0, 1), []);
  const second = buildTranslationBrief(context, source.slice(1, 2), [
    { id: source[0].id, text: source[0].text, contextPath: source[0].contextPath },
  ]);

  assert.equal(first.sourceRevisionId, run.sourceRevisionId);
  assert.equal(first.promptRevisionId, run.promptRevisionId);
  assert.equal(first.memoryRevisionId, run.literaryMemoryRevisionId);
  assert.deepEqual(first.sourceSegmentIds, ['c1-1']);
  assert.equal(first.chapterPath, 'Chapter 1');
  assert.equal(first.policyVersion, 'translation-brief-v1');
  assert.ok(first.contextChars <= MAX_TRANSLATION_BRIEF_CHARS);
  assert.match(first.contextHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.contextHash, second.contextHash, 'context identity changes when source IDs and preceding context change');

  store.saveTranslationBriefSnapshot(project.projectId, run.runId, 1, first);
  const snapshots = store.listTranslationBriefSnapshots(project.projectId, run.runId, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].contextHash, first.contextHash);
  assert.deepEqual(snapshots[0].sourceSegmentIds, ['c1-1']);
  assert.equal(snapshots[0].brief.policyVersion, 'translation-brief-v1');
});

test('literary batch planner never crosses a chapter boundary', () => {
  const items = [
    { id: 'a1', text: 'Mara entered.', contextPath: 'Chapter 1' },
    { id: 'a2', text: 'She looked at the lamp.', contextPath: 'Chapter 1' },
    { id: 'b1', text: 'Iven arrived.', contextPath: 'Chapter 2' },
  ];
  const ordinary = buildBatches(items, false);
  const literary = buildBatches(items, true);
  assert.equal(ordinary.length, 1);
  assert.deepEqual(literary.map((batch) => Array.from(new Set(batch.map((item) => item.contextPath)))), [
    ['Chapter 1'],
    ['Chapter 2'],
  ]);
});
