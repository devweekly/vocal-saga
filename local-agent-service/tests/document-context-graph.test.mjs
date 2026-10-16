import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-context-graph-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');

const { getDocumentProjectStore } = await import('../src/documents/projectStore.ts');
const {
  getContextGraph,
  buildProjectContextGraphBundle,
  reviewContextGraphItem,
  startContextGraphAnalysis,
} = await import('../src/documents/contextGraph.ts');

test('retrieval injects matched graph records and excludes future chapter summaries', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Context Graph Test',
    format: 'txt',
    sourceFileName: 'context-test.txt',
    prompt: { translationMode: 'literary' },
    segments: [
      { id: 'chapter-1-seg-1', text: 'Alice spoke politely to Bob.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'chapter-2-seg-1', text: 'Alice asked Bob about the locked door.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'chapter-2-seg-2', text: 'Alice later found the hidden staircase behind the locked door.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'chapter-3-seg-1', text: 'Alice revealed the secret passage.', kind: 'paragraph', contextPath: 'Chapter 3' },
    ],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  // Initializing through the public reader applies the production schema.
  getContextGraph(project.projectId);
  const now = new Date().toISOString();
  const insertNode = db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertNode.run('node-alice', currentSourceRevisionId, 'character', 'Alice', 'alice',
    JSON.stringify({ aliases: ['Ally'], role: 'protagonist', traits: [], voice: ['measured'] }),
    'confirmed', now, now);
  insertNode.run('node-bob', currentSourceRevisionId, 'character', 'Bob', 'bob',
    JSON.stringify({ aliases: [], role: 'companion', traits: [], voice: ['terse'] }),
    'candidate', now, now);
  insertNode.run('node-future', currentSourceRevisionId, 'entity', 'secret passage', 'secret passage',
    JSON.stringify({ aliases: ['locked door'], entityKind: 'location', significance: 'future reveal', suggestedTranslation: '密道' }),
    'confirmed', now, now);
  insertNode.run('node-hidden-identity', currentSourceRevisionId, 'entity', 'Queen Ash', 'queen ash',
    JSON.stringify({ aliases: ['Bob'], entityKind: 'character', significance: 'hidden identity', suggestedTranslation: '灰后' }),
    'confirmed', now, now);
  const insertEvidence = db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
  );
  insertEvidence.run(currentSourceRevisionId, 'node-alice', 'chapter-1-seg-1', 'Alice spoke politely', 'character', now);
  insertEvidence.run(currentSourceRevisionId, 'node-bob', 'chapter-1-seg-1', 'Bob', 'character', now);
  insertEvidence.run(currentSourceRevisionId, 'node-future', 'chapter-3-seg-1', 'secret passage', 'entity', now);
  // A single early citation cannot make a later-only canonical name safe, even when an alias
  // matches the current batch (an adversarial fixture for full-book inferred identities).
  insertEvidence.run(currentSourceRevisionId, 'node-hidden-identity', 'chapter-1-seg-1', 'Bob', 'entity', now);
  const insertChapter = db.prepare(
    'INSERT INTO context_graph_chapters(source_revision_id, chapter_key, chapter_order, chapter_title, summary, summary_kind, segment_ids_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertChapter.run(currentSourceRevisionId, 'Chapter 1', 0, 'Chapter 1', 'Alice met Bob for the first time.', 'model', '["chapter-1-seg-1"]', now);
  insertChapter.run(currentSourceRevisionId, 'Chapter 2', 1, 'Chapter 2', 'Later Alice found the hidden staircase behind the locked door.', 'model', '["chapter-2-seg-1","chapter-2-seg-2"]', now);
  insertChapter.run(currentSourceRevisionId, 'Chapter 3', 2, 'Chapter 3', 'Alice found the secret passage.', 'model', '["chapter-3-seg-1"]', now);

  const bundle = buildProjectContextGraphBundle(project.projectId, [
    { id: 'chapter-2-seg-1', text: 'Alice asked Bob about the locked door.', contextPath: 'Chapter 2' },
  ]);
  assert.ok(bundle);
  assert.deepEqual(bundle.characters.map((item) => item.name).sort(), ['Alice', 'Bob']);
  assert.deepEqual(bundle.chapterSummaries.map((item) => item.chapter), ['Chapter 1']);
  assert.ok(!JSON.stringify(bundle).includes('hidden staircase'));
  assert.ok(!JSON.stringify(bundle).includes('secret passage'));
  assert.ok(!JSON.stringify(bundle).includes('future reveal'));
  assert.ok(!JSON.stringify(bundle).includes('密道'));
  assert.ok(!JSON.stringify(bundle).includes('Queen Ash'));
  assert.ok(!JSON.stringify(bundle).includes('hidden identity'));
  assert.ok(!JSON.stringify(bundle).includes('灰后'));

  const graph = getContextGraph(project.projectId);
  const alice = graph.nodes.find((item) => item.id === 'node-alice');
  assert.ok(alice);
  assert.equal(alice.evidence[0].segmentId, 'chapter-1-seg-1');
  assert.equal(alice.evidence[0].chapter, 'Chapter 1');
  assert.equal(typeof alice.evidence[0].ordinal, 'number');
});

test('Context Graph changes are rejected while a translation run is active', () => {
  const store = getDocumentProjectStore();
  const project = store.listProjects().find((item) => item.title === 'Context Graph Test');
  assert.ok(project);
  const run = store.createRun(project.projectId, {
    scope: { type: 'ids', ids: ['chapter-2-seg-1'] },
  });
  assert.equal(run.status, 'queued');
  store.saveTranslationBriefSnapshot(project.projectId, run.runId, 1, {
    sourceRevisionId: run.sourceRevisionId,
    promptRevisionId: run.promptRevisionId,
    memoryRevisionId: run.literaryMemoryRevisionId,
    sourceSegmentIds: ['chapter-2-seg-1'],
    contextHash: 'brief-test-hash',
    contextChars: 1234,
    policyVersion: 'translation-brief-v1',
  });
  const snapshots = store.listTranslationBriefSnapshots(project.projectId, run.runId, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].contextHash, 'brief-test-hash');
  assert.equal(snapshots[0].brief.sourceRevisionId, run.sourceRevisionId);
  assert.throws(
    () => reviewContextGraphItem(project.projectId, 'node', 'node-alice', 'confirmed'),
    /不能在运行中修改 Context Graph/,
  );
  assert.throws(
    () => startContextGraphAnalysis(project.projectId),
    /不能在运行中修改 Context Graph/,
  );
});
