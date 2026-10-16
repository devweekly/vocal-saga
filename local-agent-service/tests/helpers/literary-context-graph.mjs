import { getContextGraph } from '../src/documents/contextGraph.ts';

/**
 * Literary-run tests must model the same preprocessing precondition as production.
 * This creates a completed, empty v5 graph for the current source/language; tests that
 * exercise graph contents should continue to build their own nodes/evidence explicitly.
 */
export function ensureTestContextGraph(store, project) {
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  const prompt = db.prepare('SELECT config_json FROM prompt_revisions ORDER BY created_at DESC LIMIT 1').get();
  const config = prompt?.config_json ? JSON.parse(prompt.config_json) : {};
  if ((config.translationMode || 'technical') !== 'literary') return;
  getContextGraph(project.projectId); // initializes the production Context Graph schema
  const existing = db.prepare(
    'SELECT run_id FROM context_graph_runs WHERE source_revision_id = ? AND status = ? LIMIT 1',
  ).get(currentSourceRevisionId, 'completed');
  if (existing) return;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO context_graph_runs(run_id, source_revision_id, status, phase, progress_json, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
  ).run(
    'test-context-graph-' + currentSourceRevisionId,
    currentSourceRevisionId,
    'completed',
    'completed',
    JSON.stringify({
      analysisVersion: 'context-graph-v5-language-pinned',
      sourceLang: config.sourceLang || 'auto',
      targetLang: config.targetLang || 'zh',
      segmentCount: Number(db.prepare('SELECT COUNT(*) AS count FROM source_segments WHERE source_revision_id = ?').get(currentSourceRevisionId)?.count || 0),
      testFixture: true,
    }),
    now,
    now,
  );
}
