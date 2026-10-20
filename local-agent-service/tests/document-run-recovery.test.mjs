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
  // This is the original bug shape: the old service already wrote failed to the DB but never
  // appended the matching failed event, so a restart-only running-row scan cannot repair it.
  db.prepare(
    'INSERT INTO context_graph_runs(run_id, source_revision_id, status, phase, progress_json, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(graphRunId, currentSourceRevisionId, 'failed', 'failed', JSON.stringify({}), startedAt, new Date().toISOString(),
    '服务重启后分析中断；请重新运行 context-analyze');
  store.appendEvent(project.projectId, graphRunId, 'context-graph.phase', { phase: 'model-analysis' });

  const activeGraphRunId = '621e724b-2e31-4925-9b0e-01f7a8378dd1';
  db.prepare(
    'INSERT INTO context_graph_runs(run_id, source_revision_id, status, phase, progress_json, started_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(activeGraphRunId, currentSourceRevisionId, 'running', 'model-analysis', JSON.stringify({}), startedAt);
  store.appendEvent(project.projectId, activeGraphRunId, 'context-graph.phase', { phase: 'model-analysis' });

  const legacyTranslationRun = store.createRun(project.projectId, { scope: { type: 'all' } });
  db.prepare("UPDATE translation_runs SET status = 'failed', finished_at = ?, error = ? WHERE run_id = ?")
    .run(new Date().toISOString(), '服务重启中断了这次运行；可在 Agent 面板恢复或放弃', legacyTranslationRun.runId);
  store.appendEvent(project.projectId, legacyTranslationRun.runId, 'batch.started', { batchIndex: 1 });

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
  assert.ok(graphEvents.some((event) =>
    event.type === 'context-graph.failed' && event.payload.recovery === 'terminal-event-backfill',
  ));

  const activeGraphRow = db.prepare('SELECT status, phase, finished_at, error FROM context_graph_runs WHERE run_id = ?').get(activeGraphRunId);
  assert.equal(activeGraphRow.status, 'failed');
  assert.equal(activeGraphRow.phase, 'failed');
  assert.ok(activeGraphRow.finished_at);
  const activeGraphEvents = restartedStore.getEvents(project.projectId, activeGraphRunId, 0, 100);
  assert.ok(activeGraphEvents.some((event) =>
    event.type === 'context-graph.failed' && event.payload.recovery === 'service-restart',
  ));

  const legacyTranslationRow = db.prepare('SELECT status, finished_at FROM translation_runs WHERE run_id = ?').get(legacyTranslationRun.runId);
  assert.equal(legacyTranslationRow.status, 'failed');
  assert.ok(legacyTranslationRow.finished_at);
  const legacyTranslationEvents = restartedStore.getEvents(project.projectId, legacyTranslationRun.runId, 0, 100);
  assert.ok(legacyTranslationEvents.some((event) =>
    event.type === 'run.finished' && event.payload.status === 'failed' && event.payload.recovery === 'terminal-event-backfill',
  ));

  const translationRow = db.prepare('SELECT status, finished_at, error FROM translation_runs WHERE run_id = ?').get(translationRun.runId);
  assert.equal(translationRow.status, 'failed');
  assert.ok(translationRow.finished_at);
  const translationEvents = restartedStore.getEvents(project.projectId, translationRun.runId, 0, 100);
  assert.ok(translationEvents.some((event) =>
    event.type === 'run.finished' && event.payload.status === 'failed' && event.payload.recovery === 'service-restart',
  ));
});
