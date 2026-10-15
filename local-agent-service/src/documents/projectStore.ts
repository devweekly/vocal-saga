/**
 * Durable document-project storage for the local translation workspace.
 *
 * The catalog is intentionally small and rebuildable. Each document project owns its
 * SQLite database, so long EPUB/PDF work does not turn one JSON checkpoint into a 5 MiB
 * write. The project database is the source of truth for source revisions, prompts, runs,
 * candidate translations and human-approved edits.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../config.ts';

export type DocumentFormat = 'epub' | 'pdf' | 'txt' | 'md' | 'html' | 'docx' | 'srt' | 'vtt' | 'json';
export type RunStatus = 'queued' | 'running' | 'paused' | 'awaiting_acceptance' | 'partial' | 'completed' | 'failed' | 'cancelled';

export interface ProjectSegment {
  id: string;
  text: string;
  kind?: string;
  contextPath?: string;
  page?: number | null;
  level?: number;
  marker?: string;
}

export interface ProjectPrompt {
  name?: string;
  systemPrompt?: string;
  userPromptTemplate?: string;
  sourceLang?: string;
  targetLang?: string;
  provider?: string;
  model?: string;
  translationMode?: 'technical' | 'literary';
  literaryReview?: boolean;
  glossary?: unknown;
}

export interface ProjectSummary {
  projectId: string;
  title: string;
  format: DocumentFormat;
  sourceFileName: string;
  sourceFingerprint: string;
  currentSourceRevisionId: string;
  segmentCount: number;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface CreateProjectInput {
  title: string;
  format: string;
  sourceFileName?: string;
  segments: ProjectSegment[];
  prompt?: ProjectPrompt;
}

export interface CreateRunInput {
  promptRevisionId?: string;
  prompt?: ProjectPrompt;
  scope?: { type?: 'all' | 'stale' | 'failed' | 'ids' | 'chapter'; ids?: string[]; chapter?: string };
}

const DEFAULT_SYSTEM_PROMPT = [
  'You are a careful document translation worker. Translate every input segment faithfully into the requested target language.',
  'Preserve meaning, negation, names, dates, numbers, paragraph boundaries and the source author’s tone. Do not add explanations or content that is not in the source.',
  'Return only a JSON object with a translations array. Each item must contain the original id and translated_text. Return each requested id exactly once. Never return HTML or Markdown around the JSON.',
].join('\n');

function isoNow(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function normalizeFormat(value: string): DocumentFormat {
  const format = value.toLowerCase().replace(/^\./, '');
  if (['epub', 'pdf', 'txt', 'md', 'html', 'docx', 'srt', 'vtt', 'json'].includes(format)) return format as DocumentFormat;
  throw Object.assign(new Error('不支持的文档格式：' + value), { status: 400 });
}
function validateSegments(input: unknown): ProjectSegment[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20000) {
    throw Object.assign(new Error('segments 必须是 1-20000 个片段的数组'), { status: 400 });
  }
  const seen = new Set<string>();
  let totalChars = 0;
  const result: ProjectSegment[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id.trim() || typeof item.text !== 'string') continue;
    const id = item.id.trim().slice(0, 200);
    if (seen.has(id)) throw Object.assign(new Error('segments 包含重复 ID：' + id), { status: 400 });
    seen.add(id);
    totalChars += item.text.length;
    if (totalChars > 1_500_000) throw Object.assign(new Error('文档片段总文本超过 1,500,000 字符上限'), { status: 413 });
    result.push({
      id,
      text: item.text,
      kind: typeof item.kind === 'string' ? item.kind.slice(0, 40) : 'paragraph',
      contextPath: typeof item.contextPath === 'string' ? item.contextPath.slice(0, 500) : '',
      page: Number.isFinite(item.page) ? Number(item.page) : null,
      ...(Number.isFinite(item.level) ? { level: Number(item.level) } : {}),
      ...(typeof item.marker === 'string' ? { marker: item.marker.slice(0, 80) } : {}),
    });
  }
  if (!result.length) throw Object.assign(new Error('没有可持久化的文档片段'), { status: 400 });
  return result;
}

function segmentHash(segment: ProjectSegment): string {
  return hash(JSON.stringify([segment.text, segment.kind || 'paragraph', segment.contextPath || '', segment.page ?? null, segment.level ?? null, segment.marker ?? '']));
}
function sourceFingerprint(segments: ProjectSegment[]): string {
  return hash(JSON.stringify(segments.map((segment) => [segment.id, segmentHash(segment)])));
}

export class DocumentProjectStore {
  private catalog?: DatabaseSync;
  private readonly projectDbs = new Map<string, DatabaseSync>();
  readonly rootDir: string;

  constructor(rootDir = path.join(DATA_DIR, 'documents')) {
    this.rootDir = path.resolve(rootDir);
  }

  initialize(): void {
    if (this.catalog) return;
    mkdirSync(this.rootDir, { recursive: true });
    this.catalog = new DatabaseSync(path.join(this.rootDir, 'catalog.sqlite'));
    this.catalog.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.catalog.exec(
      'CREATE TABLE IF NOT EXISTS document_projects (' +
      'project_id TEXT PRIMARY KEY, title TEXT NOT NULL, format TEXT NOT NULL, source_file_name TEXT NOT NULL, ' +
      'source_fingerprint TEXT NOT NULL, db_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);' +
      'CREATE INDEX IF NOT EXISTS idx_document_projects_updated ON document_projects(archived, updated_at DESC);'
    );
    this.repairCatalogFromDisk();
    this.recoverInterruptedRuns();
  }

  private catalogDb(): DatabaseSync {
    this.initialize();
    return this.catalog!;
  }

  private projectPath(projectId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw Object.assign(new Error('documentId 格式不正确'), { status: 400 });
    return path.join(this.rootDir, projectId, 'project.sqlite');
  }

  private createProjectSchema(db: DatabaseSync): void {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db.exec(
      'CREATE TABLE IF NOT EXISTS project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS source_revisions (' +
      'revision_id TEXT PRIMARY KEY, file_name TEXT NOT NULL, format TEXT NOT NULL, source_fingerprint TEXT NOT NULL, ' +
      'parser_version TEXT NOT NULL, segment_count INTEGER NOT NULL, created_at TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS source_segments (' +
      'source_revision_id TEXT NOT NULL, segment_id TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, ' +
      'kind TEXT NOT NULL, context_path TEXT NOT NULL, page INTEGER, level INTEGER, marker TEXT, source_hash TEXT NOT NULL, ' +
      'PRIMARY KEY(source_revision_id, segment_id));' +
      'CREATE INDEX IF NOT EXISTS idx_source_segments_order ON source_segments(source_revision_id, ordinal);' +
      'CREATE TABLE IF NOT EXISTS prompt_revisions (' +
      'prompt_revision_id TEXT PRIMARY KEY, name TEXT NOT NULL, system_prompt TEXT NOT NULL, user_prompt_template TEXT NOT NULL, ' +
      'config_json TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS idx_prompt_revisions_created ON prompt_revisions(created_at DESC);' +
      'CREATE TABLE IF NOT EXISTS translation_runs (' +
      'run_id TEXT PRIMARY KEY, source_revision_id TEXT NOT NULL, prompt_revision_id TEXT NOT NULL, status TEXT NOT NULL, ' +
      'scope_json TEXT NOT NULL, run_fingerprint TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, source_lang TEXT NOT NULL, ' +
      'target_lang TEXT NOT NULL, translation_mode TEXT NOT NULL, review_enabled INTEGER NOT NULL, parent_run_id TEXT, ' +
      'created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT);' +
      'CREATE INDEX IF NOT EXISTS idx_translation_runs_created ON translation_runs(created_at DESC);' +
      'CREATE TABLE IF NOT EXISTS run_segments (' +
      'run_id TEXT NOT NULL, segment_id TEXT NOT NULL, source_hash TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, ' +
      'candidate_result_id TEXT, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(run_id, segment_id));' +
      'CREATE INDEX IF NOT EXISTS idx_run_segments_status ON run_segments(run_id, status);' +
      'CREATE TABLE IF NOT EXISTS translation_results (' +
      'result_id TEXT PRIMARY KEY, run_id TEXT, source_revision_id TEXT NOT NULL, prompt_revision_id TEXT, segment_id TEXT NOT NULL, ' +
      'source_hash TEXT NOT NULL, run_fingerprint TEXT NOT NULL, translation_text TEXT NOT NULL, origin TEXT NOT NULL, ' +
      'accepted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS idx_translation_results_segment ON translation_results(segment_id, accepted, created_at DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_translation_results_run ON translation_results(run_id, created_at DESC);' +
      'CREATE TABLE IF NOT EXISTS review_findings (' +
      'finding_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, segment_id TEXT NOT NULL, category TEXT NOT NULL, ' +
      'priority TEXT NOT NULL, finding_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'pending\', created_at TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS idx_review_findings_run ON review_findings(run_id, segment_id);' +
      'CREATE TABLE IF NOT EXISTS project_events (' +
      'event_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS idx_project_events_run ON project_events(run_id, event_id);'
    );
  }

  private openProjectDb(projectId: string, create = false): DatabaseSync {
    const cached = this.projectDbs.get(projectId);
    if (cached) return cached;
    const filePath = this.projectPath(projectId);
    if (!create && !this.catalogDb().prepare('SELECT 1 FROM document_projects WHERE project_id = ? AND archived = 0').get(projectId)) {
      throw Object.assign(new Error('找不到文档项目：' + projectId), { status: 404 });
    }
    if (create) mkdirSync(path.dirname(filePath), { recursive: true });
    const db = new DatabaseSync(filePath);
    this.createProjectSchema(db);
    this.projectDbs.set(projectId, db);
    return db;
  }

  private repairCatalogFromDisk(): void {
    const catalog = this.catalog!;
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const filePath = path.join(this.rootDir, entry.name, 'project.sqlite');
      try {
        const db = new DatabaseSync(filePath);
        this.createProjectSchema(db);
        const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
        const revisionId = meta.get('current_source_revision_id') || '';
        const revision = revisionId
          ? db.prepare('SELECT source_fingerprint, segment_count, file_name, format FROM source_revisions WHERE revision_id = ?').get(revisionId) as any
          : undefined;
        if (meta.get('project_id') && revision) {
          const now = isoNow();
          catalog.prepare(
            'INSERT INTO document_projects(project_id, title, format, source_file_name, source_fingerprint, db_path, created_at, updated_at, archived) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(project_id) DO UPDATE SET title=excluded.title, format=excluded.format, source_file_name=excluded.source_file_name, source_fingerprint=excluded.source_fingerprint, db_path=excluded.db_path'
          ).run(entry.name, meta.get('title') || revision.file_name, revision.format, revision.file_name, revision.source_fingerprint,
            filePath, meta.get('created_at') || now, meta.get('updated_at') || now);
        }
        db.close();
      } catch (error) {
        console.warn('[document-projects] catalog repair skipped ' + entry.name + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  }

  private recoverInterruptedRuns(): void {
    const rows = this.catalogDb().prepare('SELECT project_id FROM document_projects WHERE archived = 0').all() as Array<{ project_id: string }>;
    for (const row of rows) {
      try {
        const db = this.openProjectDb(row.project_id);
        db.exec('BEGIN IMMEDIATE');
        db.prepare("UPDATE translation_runs SET status = 'paused', error = '服务重启后等待恢复' WHERE status IN ('running','queued')").run();
        db.prepare("UPDATE run_segments SET status = 'pending', updated_at = ? WHERE status = 'running'").run(isoNow());
        db.exec('COMMIT');
      } catch (error) {
        try { this.projectDbs.get(row.project_id)?.exec('ROLLBACK'); } catch { /* no active transaction */ }
        console.warn('[document-projects] recovery check failed for ' + row.project_id + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  }

  private projectMeta(db: DatabaseSync, key: string, value: string): void {
    db.prepare('INSERT INTO project_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  private insertSourceRevision(db: DatabaseSync, projectId: string, title: string, format: DocumentFormat, fileName: string, segments: ProjectSegment[]) {
    const revisionId = randomUUID();
    const fingerprint = sourceFingerprint(segments);
    const createdAt = isoNow();
    db.prepare('INSERT INTO source_revisions(revision_id, file_name, format, source_fingerprint, parser_version, segment_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(revisionId, fileName, format, fingerprint, 'segment-contract-v1', segments.length, createdAt);
    const insert = db.prepare('INSERT INTO source_segments(source_revision_id, segment_id, ordinal, text, kind, context_path, page, level, marker, source_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    segments.forEach((segment, index) => insert.run(revisionId, segment.id, index, segment.text, segment.kind || 'paragraph',
      segment.contextPath || '', segment.page ?? null, segment.level ?? null, segment.marker ?? null, segmentHash(segment)));
    this.projectMeta(db, 'project_id', projectId);
    this.projectMeta(db, 'title', title);
    this.projectMeta(db, 'format', format);
    this.projectMeta(db, 'source_file_name', fileName);
    this.projectMeta(db, 'current_source_revision_id', revisionId);
    this.projectMeta(db, 'updated_at', createdAt);
    return { revisionId, fingerprint, createdAt };
  }

  createProject(input: CreateProjectInput): ProjectSummary {
    // Initialize the catalog before creating the project directory; otherwise startup repair
    // could discover this new directory and insert the catalog row before createProject does.
    this.catalogDb();
    const segments = validateSegments(input.segments);
    const title = (input.title || input.sourceFileName || '未命名文档').trim().slice(0, 500) || '未命名文档';
    const format = normalizeFormat(input.format);
    const fileName = (input.sourceFileName || title).trim().slice(0, 500) || title;
    const projectId = randomUUID();
    const filePath = this.projectPath(projectId);
    const db = this.openProjectDb(projectId, true);
    const now = isoNow();
    const revision = this.insertSourceRevision(db, projectId, title, format, fileName, segments);
    this.projectMeta(db, 'created_at', now);
    const prompt = input.prompt || {};
    this.savePromptRevision(projectId, {
      name: '初始 Prompt',
      systemPrompt: prompt.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      userPromptTemplate: prompt.userPromptTemplate || '',
      sourceLang: prompt.sourceLang || 'auto',
      targetLang: prompt.targetLang || 'zh',
      provider: prompt.provider || 'workbuddy',
      model: prompt.model || 'auto',
      translationMode: prompt.translationMode || 'technical',
      literaryReview: Boolean(prompt.literaryReview),
      glossary: prompt.glossary,
    });
    this.catalogDb().prepare(
      'INSERT INTO document_projects(project_id, title, format, source_file_name, source_fingerprint, db_path, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)'
    ).run(projectId, title, format, fileName, revision.fingerprint, filePath, now, now);
    return this.getProject(projectId)!;
  }

  createSourceRevision(projectId: string, input: Omit<CreateProjectInput, 'prompt'>): ProjectSummary {
    const segments = validateSegments(input.segments);
    const current = this.getProject(projectId);
    if (!current) throw Object.assign(new Error('找不到文档项目'), { status: 404 });
    const title = (input.title || current.title).trim().slice(0, 500) || current.title;
    const format = normalizeFormat(input.format || current.format);
    const fileName = (input.sourceFileName || current.sourceFileName).trim().slice(0, 500);
    const db = this.openProjectDb(projectId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const revision = this.insertSourceRevision(db, projectId, title, format, fileName, segments);
      db.exec('COMMIT');
      this.catalogDb().prepare('UPDATE document_projects SET title = ?, format = ?, source_file_name = ?, source_fingerprint = ?, updated_at = ? WHERE project_id = ?')
        .run(title, format, fileName, revision.fingerprint, revision.createdAt, projectId);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return this.getProject(projectId)!;
  }

  private savePromptRevision(projectId: string, prompt: ProjectPrompt & { name?: string }): any {
    const db = this.openProjectDb(projectId);
    const config = {
      sourceLang: prompt.sourceLang || 'auto',
      targetLang: prompt.targetLang || 'zh',
      provider: prompt.provider || 'workbuddy',
      model: prompt.model || 'auto',
      translationMode: prompt.translationMode === 'literary' ? 'literary' : 'technical',
      literaryReview: Boolean(prompt.literaryReview),
      glossary: prompt.glossary ?? null,
    };
    const systemPrompt = String(prompt.systemPrompt || DEFAULT_SYSTEM_PROMPT).slice(0, 50000);
    const userPromptTemplate = String(prompt.userPromptTemplate || '').slice(0, 30000);
    const fingerprint = hash(JSON.stringify({ systemPrompt, userPromptTemplate, config }));
    const existing = db.prepare('SELECT * FROM prompt_revisions WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1').get(fingerprint);
    if (existing) return existing;
    const id = randomUUID();
    const createdAt = isoNow();
    db.prepare('INSERT INTO prompt_revisions(prompt_revision_id, name, system_prompt, user_prompt_template, config_json, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, (prompt.name || 'Prompt').slice(0, 200), systemPrompt, userPromptTemplate, JSON.stringify(config), fingerprint, createdAt);
    return db.prepare('SELECT * FROM prompt_revisions WHERE prompt_revision_id = ?').get(id);
  }

  savePrompt(projectId: string, prompt: ProjectPrompt & { name?: string }): any {
    const result = this.savePromptRevision(projectId, prompt);
    this.catalogDb().prepare('UPDATE document_projects SET updated_at = ? WHERE project_id = ?').run(isoNow(), projectId);
    this.addEvent(projectId, null, 'prompt.saved', { promptRevisionId: result.prompt_revision_id, fingerprint: result.fingerprint });
    return this.publicPrompt(result);
  }

  private publicPrompt(row: any): any {
    return {
      promptRevisionId: row.prompt_revision_id,
      name: row.name,
      systemPrompt: row.system_prompt,
      userPromptTemplate: row.user_prompt_template,
      config: parseJson(row.config_json, {}),
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
    };
  }

  listPrompts(projectId: string): any[] {
    const db = this.openProjectDb(projectId);
    return (db.prepare('SELECT * FROM prompt_revisions ORDER BY created_at DESC').all() as any[]).map((row) => this.publicPrompt(row));
  }

  createRun(projectId: string, input: CreateRunInput = {}): any {
    const db = this.openProjectDb(projectId);
    const project = this.getProject(projectId)!;
    const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
    const sourceRevisionId = meta.get('current_source_revision_id') || '';
    const promptRow = input.prompt
      ? this.savePromptRevision(projectId, input.prompt)
      : input.promptRevisionId
        ? db.prepare('SELECT * FROM prompt_revisions WHERE prompt_revision_id = ?').get(input.promptRevisionId)
        : db.prepare('SELECT * FROM prompt_revisions ORDER BY created_at DESC LIMIT 1').get();
    if (!promptRow) throw Object.assign(new Error('找不到指定 Prompt 版本'), { status: 404 });
    const config = parseJson<any>(promptRow.config_json, {});
    const scope = input.scope || { type: 'stale' };
    const scopeType = scope.type || 'stale';
    if (!['all', 'stale', 'failed', 'ids', 'chapter'].includes(scopeType)) {
      throw Object.assign(new Error('不支持的运行范围：' + scopeType), { status: 400 });
    }
    const currentSegments = db.prepare('SELECT * FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal').all(sourceRevisionId) as any[];
    const acceptedRows = db.prepare('SELECT * FROM translation_results WHERE accepted = 1 ORDER BY created_at DESC').all() as any[];
    const latestAccepted = new Map<string, any>();
    for (const row of acceptedRows) if (!latestAccepted.has(row.segment_id)) latestAccepted.set(row.segment_id, row);
    const failedRows = db.prepare("SELECT segment_id FROM run_segments WHERE status = 'failed' ORDER BY updated_at DESC").all() as Array<{ segment_id: string }>;
    const failedIds = new Set(failedRows.map((row) => row.segment_id));
    const idSet = new Set((scope.ids || []).map(String));
    const chapter = (scope.chapter || '').trim();
    const runFingerprint = hash(JSON.stringify({
      promptFingerprint: promptRow.fingerprint,
      sourceLang: config.sourceLang || 'auto',
      targetLang: config.targetLang || 'zh',
      provider: config.provider || 'workbuddy',
      model: config.model || 'auto',
      translationMode: config.translationMode || 'technical',
      literaryReview: Boolean(config.literaryReview),
      pipelineVersion: 'document-agent-v1',
    }));
    const selected = currentSegments.filter((segment) => {
      if (scopeType === 'all') return true;
      if (scopeType === 'ids') return idSet.has(segment.segment_id);
      if (scopeType === 'chapter') return !!chapter && (segment.context_path === chapter || segment.context_path.startsWith(chapter + ' >'));
      if (scopeType === 'failed') return failedIds.has(segment.segment_id);
      const accepted = latestAccepted.get(segment.segment_id);
      return !accepted || accepted.source_hash !== segment.source_hash || accepted.run_fingerprint !== runFingerprint;
    });
    const runId = randomUUID();
    const createdAt = isoNow();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO translation_runs(run_id, source_revision_id, prompt_revision_id, status, scope_json, run_fingerprint, provider, model, source_lang, target_lang, translation_mode, review_enabled, parent_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(runId, sourceRevisionId, promptRow.prompt_revision_id, selected.length ? 'queued' : 'completed', JSON.stringify({ ...scope, type: scopeType }), runFingerprint,
          config.provider || 'workbuddy', config.model || 'auto', config.sourceLang || 'auto', config.targetLang || 'zh',
          config.translationMode || 'technical', config.literaryReview ? 1 : 0, null, createdAt);
      const insert = db.prepare('INSERT INTO run_segments(run_id, segment_id, source_hash, status, attempts, candidate_result_id, error, updated_at) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)');
      for (const segment of selected) insert.run(runId, segment.segment_id, segment.source_hash, 'pending', createdAt);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    this.addEvent(projectId, runId, 'run.planned', { scope: { ...scope, type: scopeType }, promptRevisionId: promptRow.prompt_revision_id, plannedSegments: selected.length, sourceRevisionId });
    this.catalogDb().prepare('UPDATE document_projects SET updated_at = ? WHERE project_id = ?').run(createdAt, projectId);
    return this.getRun(projectId, runId);
  }

  private addEvent(projectId: string, runId: string | null, type: string, payload: unknown): void {
    const db = this.openProjectDb(projectId);
    db.prepare('INSERT INTO project_events(run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)').run(runId, type, JSON.stringify(payload ?? {}), isoNow());
  }

  appendEvent(projectId: string, runId: string | null, type: string, payload: unknown): void {
    this.addEvent(projectId, runId, type, payload);
  }

  getEvents(projectId: string, runId?: string, after = 0, limit = 200): any[] {
    const db = this.openProjectDb(projectId);
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = runId
      ? db.prepare('SELECT * FROM project_events WHERE run_id = ? AND event_id > ? ORDER BY event_id LIMIT ?').all(runId, after, boundedLimit)
      : db.prepare('SELECT * FROM project_events WHERE event_id > ? ORDER BY event_id LIMIT ?').all(after, boundedLimit);
    return (rows as any[]).map((row) => ({ eventId: row.event_id, runId: row.run_id, type: row.event_type, payload: parseJson(row.payload_json, {}), createdAt: row.created_at }));
  }

  listProjects(includeArchived = false): ProjectSummary[] {
    const sql = 'SELECT * FROM document_projects ' + (includeArchived ? '' : 'WHERE archived = 0 ') + 'ORDER BY updated_at DESC';
    return (this.catalogDb().prepare(sql).all() as any[]).map((row) => this.summaryFromCatalog(row));
  }

  getProject(projectId: string): ProjectSummary | null {
    const row = this.catalogDb().prepare('SELECT * FROM document_projects WHERE project_id = ? AND archived = 0').get(projectId) as any;
    if (!row) return null;
    return this.summaryFromCatalog(row);
  }

  private summaryFromCatalog(row: any): ProjectSummary {
    const db = this.openProjectDb(row.project_id);
    const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((item) => [item.key, item.value]));
    const revision = db.prepare('SELECT * FROM source_revisions WHERE revision_id = ?').get(meta.get('current_source_revision_id') || '') as any;
    return {
      projectId: row.project_id,
      title: row.title,
      format: row.format,
      sourceFileName: row.source_file_name,
      sourceFingerprint: row.source_fingerprint,
      currentSourceRevisionId: meta.get('current_source_revision_id') || '',
      segmentCount: Number(revision?.segment_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archived: Boolean(row.archived),
    };
  }

  getProjectContext(projectId: string): any {
    const project = this.getProject(projectId);
    if (!project) throw Object.assign(new Error('找不到文档项目'), { status: 404 });
    const db = this.openProjectDb(projectId);
    const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
    return { project, db, currentSourceRevisionId: meta.get('current_source_revision_id') || '' };
  }

  getSegments(projectId: string, options: { limit?: number; offset?: number; runId?: string } = {}): any[] {
    const { db, currentSourceRevisionId } = this.getProjectContext(projectId);
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit || 250)));
    const offset = Math.max(0, Math.floor(options.offset || 0));
    const rows = db.prepare(
      'SELECT s.segment_id, s.ordinal, s.text, s.kind, s.context_path, s.page, s.level, s.marker, s.source_hash, ' +
      '(SELECT r.translation_text FROM translation_results r WHERE r.segment_id = s.segment_id AND r.accepted = 1 ORDER BY r.created_at DESC LIMIT 1) AS accepted_translation, ' +
      '(SELECT r.translation_text FROM translation_results r WHERE r.segment_id = s.segment_id AND r.run_id = ? ORDER BY r.created_at DESC LIMIT 1) AS candidate_translation ' +
      'FROM source_segments s WHERE s.source_revision_id = ? ORDER BY s.ordinal LIMIT ? OFFSET ?'
    ).all(options.runId || '', currentSourceRevisionId, limit, offset) as any[];
    return rows.map((row) => ({
      id: row.segment_id, ordinal: row.ordinal, text: row.text, kind: row.kind, contextPath: row.context_path,
      page: row.page, level: row.level, marker: row.marker, sourceHash: row.source_hash,
      acceptedTranslation: row.accepted_translation ?? null, candidateTranslation: row.candidate_translation ?? null,
    }));
  }

  getRunSegmentsForExecution(projectId: string, runId: string): any[] {
    const { db } = this.getProjectContext(projectId);
    return db.prepare(
      'SELECT rs.segment_id AS id, rs.status, rs.source_hash, rs.attempts, ss.ordinal, ss.text, ss.kind, ss.context_path, ss.page, ss.level, ss.marker ' +
      'FROM run_segments rs JOIN translation_runs tr ON tr.run_id = rs.run_id ' +
      'JOIN source_segments ss ON ss.source_revision_id = tr.source_revision_id AND ss.segment_id = rs.segment_id ' +
      'WHERE rs.run_id = ? AND rs.status IN (\'pending\', \'failed\') ORDER BY ss.ordinal'
    ).all(runId);
  }

  getRunContext(projectId: string, runId: string): any {
    const { db, project } = this.getProjectContext(projectId);
    const run = db.prepare('SELECT * FROM translation_runs WHERE run_id = ?').get(runId) as any;
    if (!run) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
    const prompt = db.prepare('SELECT * FROM prompt_revisions WHERE prompt_revision_id = ?').get(run.prompt_revision_id) as any;
    return {
      project,
      run: {
        runId: run.run_id, sourceRevisionId: run.source_revision_id, promptRevisionId: run.prompt_revision_id,
        status: run.status, scope: parseJson(run.scope_json, {}), runFingerprint: run.run_fingerprint,
        provider: run.provider, model: run.model, sourceLang: run.source_lang, targetLang: run.target_lang,
        translationMode: run.translation_mode, reviewEnabled: Boolean(run.review_enabled),
      },
      prompt: prompt ? this.publicPrompt(prompt) : null,
    };
  }

  listRuns(projectId: string, limit = 50): any[] {
    const db = this.openProjectDb(projectId);
    return (db.prepare('SELECT * FROM translation_runs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))) as any[])
      .map((row) => this.runSummary(db, row));
  }

  getRun(projectId: string, runId: string): any {
    const db = this.openProjectDb(projectId);
    const row = db.prepare('SELECT * FROM translation_runs WHERE run_id = ?').get(runId) as any;
    if (!row) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
    return this.runSummary(db, row, true);
  }

  private runSummary(db: DatabaseSync, row: any, includeSegments = false): any {
    const counts = db.prepare('SELECT status, COUNT(*) AS count FROM run_segments WHERE run_id = ? GROUP BY status').all(row.run_id) as Array<{ status: string; count: number }>;
    const byStatus = Object.fromEntries(counts.map((entry) => [entry.status, Number(entry.count)]));
    const summary = {
      runId: row.run_id, sourceRevisionId: row.source_revision_id, promptRevisionId: row.prompt_revision_id,
      status: row.status as RunStatus, scope: parseJson(row.scope_json, {}), runFingerprint: row.run_fingerprint,
      provider: row.provider, model: row.model, sourceLang: row.source_lang, targetLang: row.target_lang,
      translationMode: row.translation_mode, reviewEnabled: Boolean(row.review_enabled), parentRunId: row.parent_run_id,
      counts: { total: counts.reduce((sum, item) => sum + Number(item.count), 0), ...byStatus },
      createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, error: row.error,
    };
    if (!includeSegments) return summary;
    const segmentRows = db.prepare(
      'SELECT rs.segment_id, rs.status, rs.attempts, rs.error, r.translation_text AS candidate_translation ' +
      'FROM run_segments rs LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id WHERE rs.run_id = ? ORDER BY rs.updated_at'
    ).all(row.run_id) as any[];
    const findings = db.prepare('SELECT finding_id, segment_id, category, priority, finding_json, status, created_at FROM review_findings WHERE run_id = ? ORDER BY finding_id')
      .all(row.run_id) as any[];
    return {
      ...summary,
      segments: segmentRows.map((segment) => ({
        id: segment.segment_id, status: segment.status, attempts: segment.attempts, error: segment.error,
        candidateTranslation: segment.candidate_translation ?? null,
      })),
      findings: findings.map((finding) => ({ findingId: finding.finding_id, segmentId: finding.segment_id, category: finding.category,
        priority: finding.priority, finding: parseJson(finding.finding_json, {}), status: finding.status, createdAt: finding.created_at })),
    };
  }

  getRunStatus(projectId: string, runId: string): RunStatus {
    const row = this.openProjectDb(projectId).prepare('SELECT status FROM translation_runs WHERE run_id = ?').get(runId) as any;
    if (!row) throw Object.assign(new Error('找不到翻译运行'), { status: 404 });
    return row.status as RunStatus;
  }

  setRunStatus(projectId: string, runId: string, status: RunStatus, error?: string | null): void {
    const db = this.openProjectDb(projectId);
    const now = isoNow();
    db.prepare('UPDATE translation_runs SET status = ?, error = ?, started_at = CASE WHEN ? = \'running\' AND started_at IS NULL THEN ? ELSE started_at END, finished_at = CASE WHEN ? IN (\'paused\',\'awaiting_acceptance\',\'partial\',\'completed\',\'failed\',\'cancelled\') THEN ? ELSE finished_at END WHERE run_id = ?')
      .run(status, error ?? null, status, now, status, now, runId);
    this.addEvent(projectId, runId, 'run.' + status, { error: error || undefined });
  }

  markRunSegments(projectId: string, runId: string, segmentIds: string[], status: string, error?: string | null): void {
    const db = this.openProjectDb(projectId);
    const stmt = db.prepare('UPDATE run_segments SET status = ?, attempts = attempts + CASE WHEN ? = \'running\' THEN 1 ELSE 0 END, error = ?, updated_at = ? WHERE run_id = ? AND segment_id = ?');
    const now = isoNow();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of segmentIds) stmt.run(status, status, error ?? null, now, runId, id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  saveCandidate(projectId: string, runId: string, segmentId: string, text: string): void {
    if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('候选译文为空或超过片段大小限制');
    const { db } = this.getProjectContext(projectId);
    const run = db.prepare('SELECT * FROM translation_runs WHERE run_id = ?').get(runId) as any;
    const row = db.prepare(
      'SELECT rs.source_hash FROM run_segments rs WHERE rs.run_id = ? AND rs.segment_id = ?'
    ).get(runId, segmentId) as any;
    if (!run || !row) throw Object.assign(new Error('运行不包含片段：' + segmentId), { status: 400 });
    const resultId = randomUUID();
    db.prepare('INSERT INTO translation_results(result_id, run_id, source_revision_id, prompt_revision_id, segment_id, source_hash, run_fingerprint, translation_text, origin, accepted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'agent\', 0, ?)')
      .run(resultId, runId, run.source_revision_id, run.prompt_revision_id, segmentId, row.source_hash, run.run_fingerprint, text, isoNow());
    db.prepare('UPDATE run_segments SET status = \'candidate\', candidate_result_id = ?, error = NULL, updated_at = ? WHERE run_id = ? AND segment_id = ?')
      .run(resultId, isoNow(), runId, segmentId);
  }

  saveFinding(projectId: string, runId: string, segmentId: string, finding: any): void {
    const db = this.openProjectDb(projectId);
    const category = ['accuracy', 'terminology', 'style'].includes(finding?.category) ? finding.category : 'style';
    const priority = category === 'style' ? 'optional' : 'must_fix';
    db.prepare('INSERT INTO review_findings(run_id, segment_id, category, priority, finding_json, status, created_at) VALUES (?, ?, ?, ?, ?, \'pending\', ?)')
      .run(runId, segmentId, category, priority, JSON.stringify({ ...finding, id: segmentId, category, priority }), isoNow());
  }

  finishRun(projectId: string, runId: string): any {
    const db = this.openProjectDb(projectId);
    const status = this.getRunStatus(projectId, runId);
    if (status === 'cancelled' || status === 'paused') return this.getRun(projectId, runId);
    const counts = db.prepare('SELECT status, COUNT(*) AS count FROM run_segments WHERE run_id = ? GROUP BY status').all(runId) as any[];
    const values = Object.fromEntries(counts.map((row) => [row.status, Number(row.count)]));
    const candidates = Number(values.candidate || 0) + Number(values.accepted || 0);
    const failures = Number(values.failed || 0);
    const pending = Number(values.pending || 0) + Number(values.running || 0);
    const finalStatus: RunStatus = pending > 0 ? 'paused' : candidates > 0 ? 'awaiting_acceptance' : failures > 0 ? 'failed' : 'completed';
    this.setRunStatus(projectId, runId, finalStatus, failures ? (String(failures) + ' 个片段失败，可重试失败范围') : null);
    return this.getRun(projectId, runId);
  }

  acceptCandidates(projectId: string, runId: string, segmentIds?: string[]): any {
    const db = this.openProjectDb(projectId);
    const only = segmentIds?.length ? new Set(segmentIds) : null;
    const rows = db.prepare('SELECT rs.segment_id, rs.candidate_result_id FROM run_segments rs WHERE rs.run_id = ? AND rs.status = \'candidate\' AND rs.candidate_result_id IS NOT NULL').all(runId) as any[];
    const now = isoNow();
    let accepted = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        if (only && !only.has(row.segment_id)) continue;
        db.prepare('UPDATE translation_results SET accepted = 1 WHERE result_id = ?').run(row.candidate_result_id);
        db.prepare('UPDATE run_segments SET status = \'accepted\', updated_at = ? WHERE run_id = ? AND segment_id = ?').run(now, runId, row.segment_id);
        accepted++;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const remaining = db.prepare("SELECT COUNT(*) AS count FROM run_segments WHERE run_id = ? AND status IN ('candidate','pending','running','failed')").get(runId) as any;
    const failed = db.prepare("SELECT COUNT(*) AS count FROM run_segments WHERE run_id = ? AND status = 'failed'").get(runId) as any;
    this.setRunStatus(projectId, runId, Number(remaining?.count || 0) > 0 ? (accepted > 0 && Number(failed?.count || 0) > 0 ? 'partial' : 'awaiting_acceptance') : 'completed');
    this.addEvent(projectId, runId, 'translations.accepted', { count: accepted, segmentIds: only ? Array.from(only) : undefined });
    return this.getRun(projectId, runId);
  }

  saveManualEdit(projectId: string, segmentId: string, text: string): any {
    if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw Object.assign(new Error('译文不能为空或超过 20000 字符'), { status: 400 });
    const { db, currentSourceRevisionId } = this.getProjectContext(projectId);
    const source = db.prepare('SELECT * FROM source_segments WHERE source_revision_id = ? AND segment_id = ?').get(currentSourceRevisionId, segmentId) as any;
    if (!source) throw Object.assign(new Error('找不到源片段：' + segmentId), { status: 404 });
    const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
    const latestPrompt = db.prepare('SELECT prompt_revision_id FROM prompt_revisions ORDER BY created_at DESC LIMIT 1').get() as any;
    const resultId = randomUUID();
    db.prepare('INSERT INTO translation_results(result_id, run_id, source_revision_id, prompt_revision_id, segment_id, source_hash, run_fingerprint, translation_text, origin, accepted, created_at) VALUES (?, NULL, ?, ?, ?, ?, \'manual\', ?, \'manual\', 1, ?)')
      .run(resultId, currentSourceRevisionId, latestPrompt?.prompt_revision_id || null, segmentId, source.source_hash, text, isoNow());
    this.addEvent(projectId, null, 'translation.manually-edited', { segmentId, resultId });
    this.catalogDb().prepare('UPDATE document_projects SET updated_at = ? WHERE project_id = ?').run(isoNow(), projectId);
    return { resultId, segmentId, text, origin: 'manual', accepted: true };
  }

  verifyProject(projectId: string): any {
    const project = this.getProject(projectId);
    if (!project) throw Object.assign(new Error('找不到文档项目'), { status: 404 });
    const { db, currentSourceRevisionId } = this.getProjectContext(projectId);
    const segments = db.prepare('SELECT segment_id, source_hash FROM source_segments WHERE source_revision_id = ?').all(currentSourceRevisionId) as any[];
    const latestAccepted = new Map<string, any>();
    for (const row of db.prepare('SELECT * FROM translation_results WHERE accepted = 1 ORDER BY created_at DESC').all() as any[]) {
      if (!latestAccepted.has(row.segment_id)) latestAccepted.set(row.segment_id, row);
    }
    const missing: string[] = [];
    const stale: string[] = [];
    for (const segment of segments) {
      const result = latestAccepted.get(segment.segment_id);
      if (!result) missing.push(segment.segment_id);
      else if (result.source_hash !== segment.source_hash) stale.push(segment.segment_id);
    }
    const activeRuns = db.prepare("SELECT run_id, status FROM translation_runs WHERE status IN ('queued','running','paused','awaiting_acceptance','partial') ORDER BY created_at DESC").all();
    return { project, totalSegments: segments.length, acceptedSegments: segments.length - missing.length, missingSegmentIds: missing, staleSourceIds: stale, activeRuns };
  }

  archiveProject(projectId: string): void {
    this.catalogDb().prepare('UPDATE document_projects SET archived = 1, updated_at = ? WHERE project_id = ?').run(isoNow(), projectId);
  }

  private repairCatalogRow(projectId: string): void {
    const db = this.openProjectDb(projectId);
    const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
    const revisionId = meta.get('current_source_revision_id') || '';
    const revision = db.prepare('SELECT * FROM source_revisions WHERE revision_id = ?').get(revisionId) as any;
    if (!revision) throw new Error('文档项目没有有效来源版本');
    this.catalogDb().prepare('UPDATE document_projects SET title = ?, format = ?, source_file_name = ?, source_fingerprint = ?, updated_at = ? WHERE project_id = ?')
      .run(meta.get('title') || revision.file_name, revision.format, revision.file_name, revision.source_fingerprint, isoNow(), projectId);
  }
}

let defaultStore: DocumentProjectStore | undefined;
export function getDocumentProjectStore(): DocumentProjectStore {
  if (!defaultStore) defaultStore = new DocumentProjectStore();
  defaultStore.initialize();
  return defaultStore;
}
export function resetDocumentProjectStoreForTests(): void {
  for (const entry of [] as string[]) void entry;
  defaultStore = undefined;
}
