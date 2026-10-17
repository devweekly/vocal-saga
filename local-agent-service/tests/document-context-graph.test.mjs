import test from 'node:test';
import { ensureTestContextGraph } from './helpers/literary-context-graph.mjs';
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
  persistSourceFeatureIndex,
  readSourceFeatureIndex,
  ensureSourceFeatureIndex,
} = await import('../src/documents/contextGraph.ts');
const { scanBookSegments } = await import('../src/documents/bookScan.ts');

test('retrieval injects matched graph records and excludes future chapter summaries', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Context Graph Test',
    format: 'txt',
    sourceFileName: 'context-test.txt',
    prompt: { translationMode: 'literary' },
    segments: [
      { id: 'chapter-1-seg-1', text: 'Alice spoke politely to Bob. Ishido stood nearby.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'chapter-2-seg-1', text: 'Alice asked Bob about the locked door.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'chapter-2-seg-2', text: 'Alice later found the hidden staircase behind the locked door.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'chapter-3-seg-1', text: 'Alice revealed the secret passage to Ishido.', kind: 'paragraph', contextPath: 'Chapter 3' },
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
  insertNode.run('node-ishido', currentSourceRevisionId, 'character', 'Ishido', 'ishido',
    JSON.stringify({ aliases: [], suggestedTranslation: '石堂', role: 'military governor', traits: [], voice: ['formal'] }),
    'candidate', now, now);
  const insertEvidence = db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
  );
  insertEvidence.run(currentSourceRevisionId, 'node-alice', 'chapter-1-seg-1', 'Alice spoke politely', 'character', now);
  insertEvidence.run(currentSourceRevisionId, 'node-bob', 'chapter-1-seg-1', 'Bob', 'character', now);
  insertEvidence.run(currentSourceRevisionId, 'node-future', 'chapter-3-seg-1', 'secret passage', 'entity', now);
  // A single early citation cannot make a later-only canonical name safe, even when an alias
  // matches the current batch (an adversarial fixture for full-book inferred identities).
  insertEvidence.run(currentSourceRevisionId, 'node-hidden-identity', 'chapter-1-seg-1', 'Bob', 'entity', now);
  // The canonical name is present early, but its analyzed supporting evidence is later.
  // The target name may be reused as a glossary mapping without importing later plot facts.
  insertEvidence.run(currentSourceRevisionId, 'node-ishido', 'chapter-3-seg-1', 'Ishido', 'character', now);
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

  const earlyNameBundle = buildProjectContextGraphBundle(project.projectId, [
    { id: 'chapter-1-seg-1', text: 'Alice spoke politely to Bob. Ishido stood nearby.', contextPath: 'Chapter 1' },
  ]);
  assert.ok(earlyNameBundle);
  assert.ok(earlyNameBundle.nameMappings.some((item) =>
    item.source === 'Ishido' && item.target === '石堂'));
  // The name mapping is allowed, but later narrative facts and summaries must remain excluded.
  assert.ok(!JSON.stringify(earlyNameBundle).includes('military governor'));
  assert.ok(!JSON.stringify(earlyNameBundle).includes('secret passage'));
  assert.ok(!JSON.stringify(earlyNameBundle).includes('Queen Ash'));

  const graph = getContextGraph(project.projectId);
  const alice = graph.nodes.find((item) => item.id === 'node-alice');
  assert.ok(alice);
  assert.equal(alice.evidence[0].segmentId, 'chapter-1-seg-1');
  assert.equal(alice.evidence[0].chapter, 'Chapter 1');
  assert.equal(typeof alice.evidence[0].ordinal, 'number');

  // The Agent trajectory tab starts from the most recent persisted events, then polls by cursor.
  store.appendEvent(project.projectId, 'trajectory-test-run', 'trajectory.test', { sequence: 1 });
  store.appendEvent(project.projectId, 'trajectory-test-run', 'trajectory.test', { sequence: 2 });
  store.appendEvent(project.projectId, 'trajectory-test-run', 'trajectory.test', { sequence: 3 });
  const recent = store.getEvents(project.projectId, 'trajectory-test-run', 0, 2, true);
  assert.deepEqual(recent.map((item) => item.payload.sequence), [2, 3]);
  const incremental = store.getEvents(project.projectId, 'trajectory-test-run', recent[0].eventId, 10);
  assert.deepEqual(incremental.map((item) => item.payload.sequence), [3]);
});

test('current-batch aliases do not suppress evidence-backed automatic canonical name mappings', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Auto Canonical Mapping Test',
    format: 'txt',
    sourceFileName: 'auto-canonical-mapping.txt',
    segments: [
      { id: 'king-first', text: 'Timsen had been taken up by the King.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'king-next', text: 'The King looked through the papers.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  getContextGraph(project.projectId);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'node-the-king', currentSourceRevisionId, 'character', 'the King', 'the king',
    JSON.stringify({ aliases: ['King'], suggestedTranslation: '国王', targetLang: 'zh' }),
    'candidate', now, now,
  );
  db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
  ).run(currentSourceRevisionId, 'node-the-king', 'king-first', 'the King', 'character', now);

  const bundle = buildProjectContextGraphBundle(project.projectId, [
    { id: 'king-first', text: 'Timsen had been taken up by the King.', contextPath: 'Chapter 1' },
  ]);
  const mapping = bundle?.nameMappings.find((item) => item.source === 'the King');
  assert.ok(mapping, 'the canonical mapping must be exposed when its alias first appears in the current segment');
  assert.equal(mapping.target, '国王');
  assert.equal(mapping.sourceStatus, 'auto',
    'valid source evidence activates canonical naming without a per-entity confirmation click');
});

test('a canonical name mapping is available when only a prior alias is visible', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Alias Retrieval',
    format: 'txt',
    segments: [
      { id: 'alias-prior', text: 'King stepped through the door.', contextPath: 'Chapter 1' },
      { id: 'alias-current', text: 'King spoke to Max.', contextPath: 'Chapter 2' },
      { id: 'formal-future', text: 'The King revealed his identity.', contextPath: 'Chapter 3' },
    ],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  getContextGraph(project.projectId);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('node-formal-king', currentSourceRevisionId, 'character', 'The King', 'the king',
      JSON.stringify({ aliases: ['King'], suggestedTranslation: '国王', targetLang: 'zh' }), 'candidate', now, now);
  db.prepare('INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)')
    .run(currentSourceRevisionId, 'node-formal-king', 'alias-prior', 'King stepped through the door.', 'character', now);
  const bundle = buildProjectContextGraphBundle(project.projectId,
    [{ id: 'alias-current', text: 'King spoke to Max.', contextPath: 'Chapter 2' }],
    [{ id: 'alias-prior', text: 'King stepped through the door.', contextPath: 'Chapter 1' }],
    currentSourceRevisionId, 'zh');
  const mapping = bundle?.nameMappings.find((item) => item.source === 'The King');
  assert.equal(mapping?.target, '国王');
  assert.deepEqual(mapping?.aliases, ['King']);
});

test('Context Graph changes are rejected while a translation run is active', () => {
  const store = getDocumentProjectStore();
  const project = store.listProjects().find((item) => item.title === 'Context Graph Test');
  assert.ok(project);
  ensureTestContextGraph(store, project);
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


test('preprocessing persists source-revision-scoped feature index with exact source offsets', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Source Feature Index Test',
    format: 'txt',
    sourceFileName: 'source-feature-index.txt',
    segments: [
      { id: 'index-king-1', text: 'The King Rat watched Max. The King Rat raised his hand.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'index-king-2', text: 'Captain Vale whispered: “The King Rat has returned.” It will take twenty-four hours.', kind: 'dialogue', contextPath: 'Chapter 2' },
    ],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  const segments = (db.prepare(
    'SELECT segment_id AS id, ordinal, text, kind, context_path AS contextPath FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(currentSourceRevisionId));
  const scan = scanBookSegments(segments);
  persistSourceFeatureIndex(db, currentSourceRevisionId, segments, scan);

  const index = readSourceFeatureIndex(db, currentSourceRevisionId);
  assert.ok(index);
  assert.equal(index.indexVersion, 'book-scan-index-v2');
  assert.equal(index.sourceSegmentCount, 2);
  assert.equal(index.segments.size, 2);

  const first = index.segments.get('index-king-1');
  const titled = first.entityMentions.find((item) => item.surface === 'The King Rat');
  assert.ok(titled);
  assert.equal(segments[0].text.slice(titled.start, titled.end), 'The King Rat');

  const second = index.segments.get('index-king-2');
  const captain = second.entityMentions.find((item) => item.surface === 'Captain Vale');
  assert.ok(captain);
  assert.equal(segments[1].text.slice(captain.start, captain.end), 'Captain Vale');
  const quotation = second.textUnits.find((item) =>
    item.unitType === 'quotation' && segments[1].text.slice(item.start, item.end) === 'The King Rat has returned.');
  assert.ok(quotation);
  const quantity = second.quantityMentions.find((item) => item.surface === 'twenty-four hours');
  assert.ok(quantity);
  assert.equal(segments[1].text.slice(quantity.start, quantity.end), quantity.surface);
  assert.ok(index.diagnostics.textUnitCount >= 3);

  assert.equal(readSourceFeatureIndex(db, 'missing-source-revision'), null,
    'feature index must never be read across source revisions');
});


test('legacy project gets a deterministic source index without re-running Context Graph model analysis', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Lazy Source Feature Index Upgrade',
    format: 'txt',
    sourceFileName: 'lazy-source-index.txt',
    segments: [
      { id: 'lazy-1', text: 'The King Rat watched Max. “Stay here.”', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'lazy-2', text: 'Captain Vale said: “Stay here.” It lasted twelve hours.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  assert.equal(readSourceFeatureIndex(db, currentSourceRevisionId), null);

  const summary = ensureSourceFeatureIndex(project.projectId, currentSourceRevisionId);
  assert.equal(summary.indexVersion, 'book-scan-index-v2');
  assert.equal(summary.sourceSegmentCount, 2);
  assert.ok(readSourceFeatureIndex(db, currentSourceRevisionId));
  const events = store.getEvents(project.projectId);
  const ready = events.find((event) => event.type === 'context-graph.source-index.ready');
  assert.ok(ready, 'index upgrade should be observable and durable');
  assert.equal(ready.payload.upgrade, true);
  assert.equal(ready.payload.sourceRevisionId, currentSourceRevisionId);
});
