import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocumentProjectStore } from '../src/documents/projectStore.ts';

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vocal-doc-project-'));
  try {
    const store = new DocumentProjectStore(root);
    await run(store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const segments = [
  { id: 'ch1-p1', text: 'The door was open.', kind: 'paragraph', contextPath: 'Chapter 1' },
  { id: 'ch1-p2', text: 'Nobody came inside.', kind: 'paragraph', contextPath: 'Chapter 1' },
];

test('document projects persist each source segment, Prompt revision and run independently', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Example Book',
      format: 'epub',
      sourceFileName: 'example.epub',
      segments,
      prompt: { systemPrompt: 'Translate faithfully.', sourceLang: 'en', targetLang: 'zh', provider: 'workbuddy', model: 'auto' },
    });
    assert.equal(project.title, 'Example Book');
    assert.equal(project.segmentCount, 2);
    assert.equal(store.listProjects().length, 1);

    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    assert.equal(run.status, 'queued');
    assert.equal(run.counts.total, 2);
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '门开着。');
    store.saveCandidate(project.projectId, run.runId, 'ch1-p2', '没有人进来。');
    const awaiting = store.finishRun(project.projectId, run.runId);
    assert.equal(awaiting.status, 'awaiting_acceptance');
    assert.equal(awaiting.counts.candidate, 2);

    // Candidate translations are durable but are not the current accepted translation.
    const beforeAccept = store.getSegments(project.projectId, { limit: 20, runId: run.runId });
    assert.equal(beforeAccept[0].acceptedTranslation, null);
    assert.equal(beforeAccept[0].candidateTranslation, '门开着。');

    const accepted = store.acceptCandidates(project.projectId, run.runId);
    assert.equal(accepted.status, 'completed');
    const current = store.getSegments(project.projectId, { limit: 20 });
    assert.equal(current[0].acceptedTranslation, '门开着。');
    assert.equal(current[1].acceptedTranslation, '没有人进来。');

    // Identical inputs should plan no stale work after accepting the run.
    const noWork = store.createRun(project.projectId, { scope: { type: 'stale' } });
    assert.equal(noWork.counts.total, 0);
    assert.equal(noWork.status, 'completed');
  });
});

test('source revisions retain prior runs and report translations stale when their source changes', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Revision Test', format: 'pdf', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '门开着。');
    store.saveCandidate(project.projectId, run.runId, 'ch1-p2', '没有人进来。');
    store.finishRun(project.projectId, run.runId);
    store.acceptCandidates(project.projectId, run.runId);

    const revised = [
      { ...segments[0], text: 'The old door was open.' },
      segments[1],
    ];
    const nextProject = store.createSourceRevision(project.projectId, {
      title: project.title, format: 'pdf', segments: revised,
    });
    assert.notEqual(nextProject.currentSourceRevisionId, project.currentSourceRevisionId);
    const verification = store.verifyProject(project.projectId);
    assert.deepEqual(verification.staleSourceIds, ['ch1-p1']);
    const runList = store.listRuns(project.projectId);
    assert.equal(runList.length, 1, 'source import must not delete older run history');
  });
});

test('manual correction becomes an accepted version but remains traceable', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Manual Edit', format: 'epub', segments });
    const edit = store.saveManualEdit(project.projectId, 'ch1-p1', '门敞开着。');
    assert.equal(edit.origin, 'manual');
    assert.equal(edit.accepted, true);
    const current = store.getSegments(project.projectId, { limit: 10 });
    assert.equal(current[0].acceptedTranslation, '门敞开着。');
    assert.equal(store.getEvents(project.projectId).some((event) => event.type === 'translation.manually-edited'), true);
  });
});

test('stores each original source file in its document revision directory', async () => {
  await withStore(async (store) => {
    const project = store.createProject({
      title: 'Original File',
      format: 'epub',
      sourceFileName: 'original.epub',
      segments,
    });
    const bytes = Buffer.from('PK fake EPUB source bytes');
    const saved = await store.storeSourceFile(project.projectId, 'original.epub', bytes);
    assert.equal(saved.saved, true);
    assert.equal(saved.size, bytes.byteLength);
    assert.equal(saved.sourceRevisionId, project.currentSourceRevisionId);
    assert.equal(store.getProject(project.projectId)?.sourceFileSaved, true);
    const actual = await readFile(path.join(store.rootDir, project.projectId, 'sources', project.currentSourceRevisionId + '.epub'));
    assert.deepEqual(actual, bytes);

    await assert.rejects(
      store.storeSourceFile(project.projectId, 'original.epub', Buffer.from('different bytes')),
      /此来源版本已有不同的原始文件/,
    );
  });
});

test('manual acceptance is newer than an older candidate and is not auto-staled by Prompt changes', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Manual Priority', format: 'epub', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '模型候选。');
    store.finishRun(project.projectId, run.runId);
    store.saveManualEdit(project.projectId, 'ch1-p1', '用户修订。');
    store.acceptCandidates(project.projectId, run.runId, ['ch1-p1']);

    const current = store.getSegments(project.projectId, { limit: 10 });
    assert.equal(current.find((item: any) => item.id === 'ch1-p1')?.acceptedTranslation, '模型候选。');

    const nextPrompt = {
      systemPrompt: 'Changed prompt; use short natural Chinese.',
      sourceLang: 'en',
      targetLang: 'zh',
      provider: 'workbuddy',
      model: 'auto',
    };
    const noAutomaticOverwrite = store.createRun(project.projectId, { prompt: nextPrompt, scope: { type: 'stale' } });
    assert.equal(noAutomaticOverwrite.counts.total, 1, 'only the segment not yet accepted should remain stale');
  });
});

