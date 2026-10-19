import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-run-automation-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');

const { getDocumentProjectStore } = await import('../src/documents/projectStore.ts');
const { autoAcceptFinishedRunCandidates } = await import('../src/documents/translationAgent.ts');

test('service automatically accepts finished candidates through the guarded Store transaction', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Automatic acceptance test',
    format: 'txt',
    sourceFileName: 'automatic-acceptance.txt',
    prompt: { translationMode: 'technical', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'auto-1', text: 'The room was quiet.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'auto-2', text: 'She closed the book.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'all' } });
  store.saveCandidate(project.projectId, run.runId, 'auto-1', '房间里很安静。');
  store.saveCandidate(project.projectId, run.runId, 'auto-2', '她合上了书。');

  // A manual edit after candidate creation must still win during automated finalization.
  store.saveManualEdit(project.projectId, 'auto-2', '她把书合上了。');
  const pending = store.finishRun(project.projectId, run.runId);
  assert.equal(pending.status, 'awaiting_acceptance');

  const finished = autoAcceptFinishedRunCandidates(project.projectId, run.runId);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.counts.candidate || 0, 0);

  const segments = store.getSegments(project.projectId, { limit: 10 });
  assert.equal(segments.find((item) => item.id === 'auto-1').acceptedTranslation, '房间里很安静。');
  assert.equal(segments.find((item) => item.id === 'auto-2').acceptedTranslation, '她把书合上了。');

  // Re-entry is idempotent and does not overwrite anything already accepted.
  const second = autoAcceptFinishedRunCandidates(project.projectId, run.runId);
  assert.equal(second.status, 'completed');
  assert.equal(store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'auto-2').acceptedTranslation,
    '她把书合上了。');
});
