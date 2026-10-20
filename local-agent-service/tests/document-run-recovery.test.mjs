import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-run-recovery-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');

const { getDocumentProjectStore, DocumentProjectStore } = await import('../src/documents/projectStore.ts');
const { getContextGraphStatus } = await import('../src/documents/contextGraph.ts');

test('startup recovery marks orphaned runs failed and appends terminal events atomically', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Run recovery regression',
    format: 'txt',
    sourceFileName: 'run-recovery.txt',
    prompt: { translationMode: 'literary' },
    segments: [{ id: 's1', text: 'Alice entered the room.', kind: 'paragraph', contextPath: 'Chapter 1' }],
  });

  // Initialize the Context Graph schema before simulating a process that died mid-analysis.
  getContextGraphStatus(project.projectId);
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  const graphRunId = '621e724b-2e31-4925-9b0e-01f7a8378dd0';
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  db.prepare(
    'INSERT INTO context_graph_runs(run_id, source_revision_id, status, phase, progress_json, started_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(graphRunId, currentSourceRevisionId, 'running', 'model-analysis', JSON.stringify({}), startedAt);
  store.appendEvent(project.projectId, graphRunId, 'context-graph.phase', { phase: 'model-analysis' });

  const translationRun = store.createRun(project.projectId, { scope: { type: 'all' } });
  db.prepare("UPDATE translation_runs SET status = 'running' WHERE run_id = ?").run(translationRun.runId);
  store.appendEvent(project.projectId, translationRun.runId, 'batch.started', { batchIndex: 1 });

  // A second store instance simulates the next service process opening the same project catalog.
  const restartedStore = new DocumentProjectStore(store.rootDir);
  restartedStore.initialize();

  const graphRow = db.prepare('SELECT status, phase, finished_at, error FROM context_graph_runs WHERE run_id = ?').get(graphRunId);
  assert.equal(graphRow.status, 'failed');
  assert.equal(graphRow.phase, 'failed');
  assert.ok(graphRow.finished_at);
  assert.match(graphRow.error, /服务重启/);

  const graphEvents = restartedStore.getEvents(project.projectId, graphRunId, 0, 100);
  assert.ok(graphEvents.some((event) => event.type === 'context-graph.phase'));
  assert.ok(graphEvents.some((event) => event.type === 'context-graph.failed' && /服务重启/.test(event.payload.error)));

  const translationRow = db.prepare('SELECT status, finished_at, error FROM translation_runs WHERE run_id = ?').get(translationRun.runId);
  assert.equal(translationRow.status, 'failed');
  assert.ok(translationRow.finished_at);

  const translationEvents = restartedStore.getEvents(project.projectId, translationRun.runId, 0, 100);
  assert.ok(translationEvents.some((event) =>
    event.type === 'run.finished' && event.payload.status === 'failed' && event.payload.recovery === 'service-restart',
  ));
});
