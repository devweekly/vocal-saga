/**
 * CLI for automation, debugging and bulk document runs.
 * Inputs are normalized segment JSON produced by the same EPUB/PDF parser contract as the extension.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDocumentProjectStore } from './projectStore.ts';
import { startProjectTranslationRun } from './translationAgent.ts';

function usage(): never {
  console.error([
    'Usage: npm run doc -- <command> [arguments]',
    '  import <segments.json>                         create a project from normalized segments',
    '  projects                                      list document projects',
    '  status <documentId>                           inspect project, runs and stale segments',
    '  run <documentId> [--scope=stale|all|failed] [--chapter=TITLE] [--prompt-file=FILE]',
    '  accept <documentId> <runId>                   accept all candidate translations from a run',
    '  verify <documentId>                           check missing and stale source mappings',
    '  diff <documentId> <runId>                     compare current accepted text with run candidates',
    '  export <documentId> <output.json>             export source + accepted translations',
  ].join('\n'));
  process.exit(2);
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}
function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function runDocumentCli(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  const store = getDocumentProjectStore();
  if (!command || command === '--help' || command === '-h') usage();

  if (command === 'import') {
    if (!args[0]) usage();
    const input = await readJson(args[0]);
    const project = store.createProject({
      title: String(input.title || input.fileName || path.basename(args[0])),
      format: String(input.format || path.extname(args[0]).slice(1) || 'txt'),
      sourceFileName: typeof input.sourceFileName === 'string' ? input.sourceFileName : path.basename(args[0]),
      segments: input.segments,
      prompt: input.prompt,
    });
    print({ created: true, project });
    return;
  }

  if (command === 'projects') {
    print({ projects: store.listProjects() });
    return;
  }

  if (command === 'status' || command === 'verify') {
    if (!args[0]) usage();
    print(command === 'status'
      ? { project: store.getProject(args[0]), verification: store.verifyProject(args[0]), runs: store.listRuns(args[0]) }
      : store.verifyProject(args[0]));
    return;
  }

  if (command === 'run') {
    const projectId = args[0];
    if (!projectId) usage();
    const scopeArg = args.find((item) => item.startsWith('--scope='))?.slice('--scope='.length) || 'stale';
    const chapter = args.find((item) => item.startsWith('--chapter='))?.slice('--chapter='.length);
    const promptFile = args.find((item) => item.startsWith('--prompt-file='))?.slice('--prompt-file='.length);
    const prompt = promptFile ? await readJson(promptFile) : undefined;
    const scope = chapter
      ? { type: 'chapter' as const, chapter }
      : { type: (['all', 'stale', 'failed'].includes(scopeArg) ? scopeArg : 'stale') as 'all' | 'stale' | 'failed' };
    const run = store.createRun(projectId, { scope, prompt });
    if (run.counts.total === 0) {
      print({ message: '所选范围没有需要处理的片段', run });
      return;
    }
    startProjectTranslationRun(projectId, run.runId);
    let current = run;
    while (true) {
      await sleep(1000);
      current = store.getRun(projectId, run.runId);
      console.error('[document-agent] ' + current.status + ' ' + JSON.stringify(current.counts));
      if (!['queued', 'running'].includes(current.status)) break;
    }
    const next = current.status === 'awaiting_acceptance'
      ? '请检查候选译文，再运行 accept'
      : current.status === 'paused'
        ? '任务已暂停；可从扩展工作区恢复中断任务'
        : current.status === 'cancelled'
          ? '任务已停止；已经保存的候选仍保留'
          : current.status === 'failed' || current.status === 'partial'
            ? '请检查失败项与 verify 输出后重试'
            : '请检查 verify 输出';
    print({ run: current, next });
    if (current.status === 'failed' || current.status === 'partial') process.exitCode = 1;
    return;
  }

  if (command === 'accept') {
    if (!args[0] || !args[1]) usage();
    print({ run: store.acceptCandidates(args[0], args[1]) });
    return;
  }

  if (command === 'diff') {
    if (!args[0] || !args[1]) usage();
    const run = store.getRun(args[0], args[1]);
    const ids = new Set(run.segments.map((segment: any) => segment.id));
    const all: any[] = [];
    const limit = 1000;
    for (let offset = 0; offset < run.segments.length; offset += limit) {
      all.push(...store.getSegments(args[0], { limit, offset, runId: args[1] }));
    }
    print({
      runId: run.runId,
      status: run.status,
      differences: all.filter((segment: any) => ids.has(segment.id) && segment.candidateTranslation != null)
        .map((segment: any) => ({
          id: segment.id,
          source: segment.text,
          accepted: segment.acceptedTranslation,
          candidate: segment.candidateTranslation,
          changed: segment.acceptedTranslation !== segment.candidateTranslation,
        })),
    });
    return;
  }

  if (command === 'export') {
    if (!args[0] || !args[1]) usage();
    const verification = store.verifyProject(args[0]);
    const all: any[] = [];
    const limit = 1000;
    for (let offset = 0; offset < verification.totalSegments; offset += limit) {
      all.push(...store.getSegments(args[0], { limit, offset }));
    }
    const outputPath = path.resolve(args[1]);
    await writeFile(outputPath, JSON.stringify({
      project: verification.project,
      exportedAt: new Date().toISOString(),
      segments: all.map((segment: any) => ({
        id: segment.id, text: segment.text, kind: segment.kind, contextPath: segment.contextPath,
        page: segment.page, translation: segment.acceptedTranslation,
      })),
    }, null, 2), 'utf8');
    print({ outputPath, segmentCount: all.length, missingTranslations: all.filter((segment) => !segment.acceptedTranslation).length });
    return;
  }

  usage();
}

if (import.meta.url === new URL(process.argv[1] ? 'file://' + path.resolve(process.argv[1]) : import.meta.url).href) {
  runDocumentCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
