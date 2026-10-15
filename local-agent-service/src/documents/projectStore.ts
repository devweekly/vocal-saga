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
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../config.ts';
import { sanitizeProjectLiteraryMemory } from './voiceContext.ts';

export type DocumentFormat = 'epub' | 'pdf' | 'txt' | 'md' | 'html' | 'docx' | 'srt' | 'vtt' | 'json';
export const MAX_DOCUMENT_SOURCE_BYTES = 20 * 1024 * 1024;

export type RunStatus = 'queued' | 'running' | 'paused' | 'awaiting_acceptance' | 'partial' | 'completed' | 'failed' | 'cancelled';

export interface ProjectSegment {
  id: string;
  text: string;
  kind?: string;
  contextPath?: string;
  page?: number | null;
  level?: number;
  marker?: string;
  /** EPUB spine href / original document part used to reconstruct the source layout. */
  path?: string;
  start?: string;
  end?: string;
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
  /** Confirmed book entities/style memory included as read-only Agent context. */
  literaryMemory?: unknown;
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
  sourceFileSaved: boolean;
  sourceFileSize: number | null;
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

/**
 * 进程内单调递增的时间戳。
 *
 * 所有「哪一条更新」的判断都比 created_at / accepted_at，而这些列是毫秒精度的。
 * 同一毫秒内写入的两条记录会打平，比较时旧记录可能压过新记录
 * （典型场景：Agent 候选与人工修订在同一个 tick 内落库）。
 * 这里保证同一进程内不会产生相同的时间戳。
 *
 * 跨进程仍可能打平（本机服务与 CLI 可能同时打开同一个项目库），
 * 因此 acceptCandidates 另用插入顺序（rowid）作为判据。
 */
let lastStampMs = 0;
function isoNow(): string {
  const now = Math.max(Date.now(), lastStampMs + 1);
  lastStampMs = now;
  return new Date(now).toISOString();
}
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
  const result: ProjectSegment[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id.trim() || typeof item.text !== 'string') continue;
    const id = item.id.trim().slice(0, 200);
    if (seen.has(id)) throw Object.assign(new Error('segments 包含重复 ID：' + id), { status: 400 });
    seen.add(id);
    result.push({
      id,
      text: item.text,
      kind: typeof item.kind === 'string' ? item.kind.slice(0, 40) : 'paragraph',
      contextPath: typeof item.contextPath === 'string' ? item.contextPath.slice(0, 500) : '',
      page: Number.isFinite(item.page) ? Number(item.page) : null,
      ...(Number.isFinite(item.level) ? { level: Number(item.level) } : {}),
      ...(typeof item.marker === 'string' ? { marker: item.marker.slice(0, 80) } : {}),
      ...(typeof item.path === 'string' ? { path: item.path.slice(0, 1000) } : {}),
      ...(typeof item.start === 'string' ? { start: item.start.slice(0, 40) } : {}),
      ...(typeof item.end === 'string' ? { end: item.end.slice(0, 40) } : {}),
    });
  }
  if (!result.length) throw Object.assign(new Error('没有可持久化的文档片段'), { status: 400 });
  return result;
}

function segmentHash(segment: ProjectSegment): string {
  return hash(JSON.stringify([segment.text, segment.kind || 'paragraph', segment.contextPath || '', segment.page ?? null, segment.level ?? null, segment.marker ?? '', segment.path ?? '', segment.start ?? '', segment.end ?? '']));
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
      'parser_version TEXT NOT NULL, segment_count INTEGER NOT NULL, created_at TEXT NOT NULL, source_file_path TEXT, source_file_hash TEXT, source_file_size INTEGER);' +
      'CREATE TABLE IF NOT EXISTS source_segments (' +
      'source_revision_id TEXT NOT NULL, segment_id TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, ' +
      'kind TEXT NOT NULL, context_path TEXT NOT NULL, page INTEGER, level INTEGER, marker TEXT, path TEXT, start_time TEXT, end_time TEXT, source_hash TEXT NOT NULL, ' +
      'PRIMARY KEY(source_revision_id, segment_id));' +
      'CREATE INDEX IF NOT EXISTS idx_source_segments_order ON source_segments(source_revision_id, ordinal);' +
      'CREATE TABLE IF NOT EXISTS prompt_revisions (' +
      'prompt_revision_id TEXT PRIMARY KEY, name TEXT NOT NULL, system_prompt TEXT NOT NULL, user_prompt_template TEXT NOT NULL, ' +
      'config_json TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS idx_prompt_revisions_created ON prompt_revisions(created_at DESC);' +
      'CREATE TABLE IF NOT EXISTS literary_memory_revisions (' +
      'memory_revision_id TEXT PRIMARY KEY, version INTEGER NOT NULL, memory_json TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS idx_literary_memory_created ON literary_memory_revisions(created_at DESC);' +
      'CREATE TABLE IF NOT EXISTS translation_runs (' +
      'run_id TEXT PRIMARY KEY, source_revision_id TEXT NOT NULL, prompt_revision_id TEXT NOT NULL, literary_memory_revision_id TEXT, status TEXT NOT NULL, '+
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
      'accepted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, accepted_at TEXT);' +
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
    // Add columns safely for project DBs created by earlier iterations of this feature.
    // SQLite 项目可能早于独立文学记忆版本表创建；增量迁移不能丢旧的 Run / Prompt / 译文。
    const runColumns = new Set(
      (db.prepare('PRAGMA table_info(translation_runs)').all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!runColumns.has('literary_memory_revision_id')) db.exec('ALTER TABLE translation_runs ADD COLUMN literary_memory_revision_id TEXT');
    const translationColumns = new Set(
      (db.prepare('PRAGMA table_info(translation_results)').all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!translationColumns.has('accepted_at')) {
      db.exec('ALTER TABLE translation_results ADD COLUMN accepted_at TEXT');
      db.exec('UPDATE translation_results SET accepted_at = created_at WHERE accepted = 1 AND accepted_at IS NULL');
    }
    const sourceColumns = new Set(
      (db.prepare('PRAGMA table_info(source_revisions)').all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!sourceColumns.has('source_file_path')) db.exec('ALTER TABLE source_revisions ADD COLUMN source_file_path TEXT');
    if (!sourceColumns.has('source_file_hash')) db.exec('ALTER TABLE source_revisions ADD COLUMN source_file_hash TEXT');
    if (!sourceColumns.has('source_file_size')) db.exec('ALTER TABLE source_revisions ADD COLUMN source_file_size INTEGER');
    const segmentColumns = new Set(
      (db.prepare('PRAGMA table_info(source_segments)').all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!segmentColumns.has('path')) db.exec('ALTER TABLE source_segments ADD COLUMN path TEXT');
    if (!segmentColumns.has('start_time')) db.exec('ALTER TABLE source_segments ADD COLUMN start_time TEXT');
    if (!segmentColumns.has('end_time')) db.exec('ALTER TABLE source_segments ADD COLUMN end_time TEXT');
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
    const insert = db.prepare('INSERT INTO source_segments(source_revision_id, segment_id, ordinal, text, kind, context_path, page, level, marker, path, start_time, end_time, source_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    segments.forEach((segment, index) => insert.run(revisionId, segment.id, index, segment.text, segment.kind || 'paragraph',
      segment.contextPath || '', segment.page ?? null, segment.level ?? null, segment.marker ?? null,
      segment.path ?? null, segment.start ?? null, segment.end ?? null, segmentHash(segment)));
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
    // Source and catalog rows must exist before evidence-backed memory validation looks them up.
    if (prompt.literaryMemory !== undefined) this.saveLiteraryMemory(projectId, prompt.literaryMemory);
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

  /**
   * Keep the original source outside SQLite but inside the document project's own directory.
   * The content itself is not stored as a giant blob in either SQLite database. A revision gets
   * an immutable file name based on its revision UUID; re-importing never overwrites an older file.
   */
  async storeSourceFile(projectId: string, fileName: string, bytes: Uint8Array): Promise<{ saved: true; size: number; sha256: string; sourceRevisionId: string }> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
      throw Object.assign(new Error('原始文件内容为空'), { status: 400 });
    }
    if (bytes.byteLength > MAX_DOCUMENT_SOURCE_BYTES) {
      throw Object.assign(new Error('原始文件超过 20 MiB 上限'), { status: 413 });
    }
    const { db, currentSourceRevisionId } = this.getProjectContext(projectId);
    const revision = db.prepare('SELECT format FROM source_revisions WHERE revision_id = ?').get(currentSourceRevisionId) as { format?: string } | undefined;
    if (!revision?.format) throw Object.assign(new Error('找不到当前来源版本'), { status: 404 });
    const cleanName = path.basename(String(fileName || '')).replace(/[\x00-\x1f]/g, '').slice(0, 240) || ('source.' + revision.format);
    const extension = path.extname(cleanName).replace(/^\./, '').toLowerCase();
    if (extension && extension !== revision.format.toLowerCase()) {
      throw Object.assign(new Error('原始文件扩展名与项目格式不匹配'), { status: 400 });
    }
    const revisionDir = path.dirname(this.projectPath(projectId));
    const relativePath = path.join('sources', currentSourceRevisionId + '.' + revision.format);
    const targetPath = path.resolve(revisionDir, relativePath);
    if (!targetPath.startsWith(revisionDir + path.sep)) throw new Error('原始文件路径不安全');
    mkdirSync(path.dirname(targetPath), { recursive: true });
    const copied = Buffer.from(bytes);
    const sourceHash = createHash('sha256').update(copied).digest('hex');
    await writeFile(targetPath, copied, { flag: 'wx' }).catch(async (error: any) => {
      // A retry after network timeout may find the immutable file already written. Reuse it only
      // when its bytes are exactly the same; never replace an existing source revision silently.
      if (error?.code !== 'EEXIST') throw error;
      const { readFile } = await import('node:fs/promises');
      const existing = await readFile(targetPath);
      if (createHash('sha256').update(existing).digest('hex') !== sourceHash) {
        throw Object.assign(new Error('此来源版本已有不同的原始文件，拒绝覆盖'), { status: 409 });
      }
    });
    db.prepare('UPDATE source_revisions SET source_file_path = ?, source_file_hash = ?, source_file_size = ? WHERE revision_id = ?')
      .run(relativePath, sourceHash, copied.byteLength, currentSourceRevisionId);
    this.addEvent(projectId, null, 'source.file-saved', { sourceRevisionId: currentSourceRevisionId, fileName: cleanName, size: copied.byteLength, sha256: sourceHash });
    return { saved: true, size: copied.byteLength, sha256: sourceHash, sourceRevisionId: currentSourceRevisionId };
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
      // 动态书籍记忆存入独立 literary_memory_revisions，不参与静态 Prompt fingerprint。
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
    if (prompt.literaryMemory !== undefined) this.saveLiteraryMemory(projectId, prompt.literaryMemory);
    this.catalogDb().prepare('UPDATE document_projects SET updated_at = ? WHERE project_id = ?').run(isoNow(), projectId);
    this.addEvent(projectId, null, 'prompt.saved', { promptRevisionId: result.prompt_revision_id, fingerprint: result.fingerprint });
    return this.publicPrompt(result);
  }

  /**
   * 文学记忆是独立的不可变业务资产，不应混进 Prompt fingerprint。
   * 角色画像按证据与状态维护；每个 Run 固定引用一个 memory revision，方便复现。
   */
  /**
   * The Project Store is the trust boundary for persistent literary memory.
   * Do not trust a client-side "confirmed"/"approved" flag: its evidence must still match
   * this project's current source revision and an anchor's target must exist in an accepted translation.
   */
  private validateLiteraryMemoryAgainstProject(projectId: string, input: unknown): Record<string, any> {
    const memory = sanitizeProjectLiteraryMemory(input);
    const { db, currentSourceRevisionId } = this.getProjectContext(projectId);
    const sourceRows = db.prepare(
      'SELECT segment_id, text, source_hash FROM source_segments WHERE source_revision_id = ?'
    ).all(currentSourceRevisionId) as Array<{ segment_id: string; text: string; source_hash: string }>;
    const sources = new Map(sourceRows.map((row) => [row.segment_id, row]));
    const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const latestAccepted = new Map<string, { translation: string; sourceHash: string }>();
    const acceptedRows = db.prepare(
      'SELECT segment_id, translation_text, source_hash FROM translation_results WHERE accepted = 1 ' +
      'ORDER BY COALESCE(accepted_at, created_at) DESC, created_at DESC, rowid DESC'
    ).all() as Array<{ segment_id: string; translation_text: string; source_hash: string }>;
    for (const row of acceptedRows) {
      if (!latestAccepted.has(row.segment_id)) {
        latestAccepted.set(row.segment_id, { translation: row.translation_text, sourceHash: row.source_hash });
      }
    }
    const validEvidence = (segmentId: unknown, quote: unknown): boolean => {
      if (typeof segmentId !== 'string' || typeof quote !== 'string' || !quote.trim()) return false;
      const source = sources.get(segmentId);
      return !!source && normalize(source.text).includes(normalize(quote));
    };

    memory.characterVoices = memory.characterVoices.map((profile: any) => {
      const evidence = profile.evidence.filter((item: any) => validEvidence(item.segmentId, item.sourceQuote));
      const status = profile.status === 'rejected'
        ? 'rejected'
        : profile.status === 'confirmed' && evidence.length
          ? 'confirmed'
          : 'candidate';
      const questions = Array.isArray(profile.openQuestions) ? [...profile.openQuestions] : [];
      if (profile.status === 'confirmed' && status !== 'confirmed') {
        questions.push('已确认画像的原文证据在当前来源版本中无法核验，已降级为候选。');
      }
      return { ...profile, evidence, status, openQuestions: Array.from(new Set(questions)).slice(0, 8) };
    });
    const characterIds = new Set(memory.characterVoices.map((profile: any) => profile.characterId));
    const confirmedCharacterIds = new Set(memory.characterVoices.filter((profile: any) => profile.status === 'confirmed').map((profile: any) => profile.characterId));
    memory.characterVoices = memory.characterVoices.map((profile: any) => ({
      ...profile,
      contrastRules: profile.contrastRules.flatMap((rule: any) => {
        const evidenceSegmentIds = rule.evidenceSegmentIds.filter((id: string) => sources.has(id));
        return characterIds.has(rule.otherCharacterId) && evidenceSegmentIds.length
          ? [{ ...rule, evidenceSegmentIds }] : [];
      }),
    }));
    memory.relationshipVoiceRules = memory.relationshipVoiceRules.flatMap((rule: any) => {
      const evidenceSegmentIds = rule.evidenceSegmentIds.filter((id: string) => sources.has(id));
      const status = rule.status === 'rejected' ? 'rejected'
        : rule.status === 'confirmed' && evidenceSegmentIds.length && confirmedCharacterIds.has(rule.speakerId) && confirmedCharacterIds.has(rule.addresseeId) ? 'confirmed' : 'candidate';
      return characterIds.has(rule.speakerId) && characterIds.has(rule.addresseeId) && evidenceSegmentIds.length
        ? [{ ...rule, evidenceSegmentIds, status }] : [];
    });
    memory.voiceAnchors = memory.voiceAnchors.map((anchor: any) => {
      const sourceValid = validEvidence(anchor.segmentId, anchor.source);
      const attributionValid = validEvidence(anchor.segmentId, anchor.attributionEvidence) &&
        Number.isFinite(Number(anchor.attributionConfidence)) && Number(anchor.attributionConfidence) >= 0.7;
      const speakerConfirmed = memory.characterVoices.some((profile: any) =>
        profile.characterId === anchor.speakerId && profile.status === 'confirmed');
      const accepted = latestAccepted.get(anchor.segmentId);
      const currentSource = sources.get(anchor.segmentId);
      // A translation from an older source revision is not a valid target for a new anchor,
      // even if a substring happens to match after the original text was edited.
      const targetValid = !!accepted && !!currentSource &&
        accepted.sourceHash === currentSource.source_hash &&
        !!accepted.translation.trim() &&
        normalize(accepted.translation).includes(normalize(anchor.target));
      const approved = anchor.status === 'approved' && sourceValid && attributionValid && speakerConfirmed && targetValid;
      return {
        ...anchor,
        status: anchor.status === 'rejected' ? 'rejected' : approved ? 'approved' : 'candidate',
      };
    });
    return memory;
  }

  saveLiteraryMemory(projectId: string, input: unknown): any {
    const db = this.openProjectDb(projectId);
    const memory = this.validateLiteraryMemoryAgainstProject(projectId, input);
    const memoryJson = JSON.stringify(memory);
    const fingerprint = hash(memoryJson);
    const existing = db.prepare('SELECT * FROM literary_memory_revisions WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1').get(fingerprint) as any;
    if (existing) {
      this.projectMeta(db, 'current_literary_memory_revision_id', existing.memory_revision_id);
      return { memoryRevisionId: existing.memory_revision_id, fingerprint: existing.fingerprint, version: existing.version, createdAt: existing.created_at };
    }
    const memoryRevisionId = randomUUID();
    const createdAt = isoNow();
    db.prepare('INSERT INTO literary_memory_revisions(memory_revision_id, version, memory_json, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(memoryRevisionId, 2, memoryJson, fingerprint, createdAt);
    this.projectMeta(db, 'current_literary_memory_revision_id', memoryRevisionId);
    this.addEvent(projectId, null, 'literary-memory.saved', { memoryRevisionId, fingerprint, characterCount: memory.characterVoices.length, relationshipVoiceRuleCount: memory.relationshipVoiceRules.length, voiceAnchorCount: memory.voiceAnchors.length });
    return { memoryRevisionId, fingerprint, version: 2, createdAt };
  }

  getCurrentLiteraryMemory(projectId: string): any {
    const db = this.openProjectDb(projectId);
    let revisionId = db.prepare('SELECT value FROM project_meta WHERE key = ?').get('current_literary_memory_revision_id') as { value?: string } | undefined;
    // 兼容早期 Project API：历史 Prompt 把整本书的记忆放在 config_json 内。首次读取时迁移一次。
    if (!revisionId?.value) {
      const prompt = db.prepare('SELECT * FROM prompt_revisions ORDER BY created_at DESC LIMIT 1').get() as any;
      const oldConfig = prompt ? parseJson<any>(prompt.config_json, {}) : {};
      if (oldConfig.literaryMemory) {
        const saved = this.saveLiteraryMemory(projectId, oldConfig.literaryMemory);
        revisionId = { value: saved.memoryRevisionId };
      }
    }
    if (!revisionId?.value) {
      return { memoryRevisionId: null, fingerprint: null, memory: sanitizeProjectLiteraryMemory({}) };
    }
    const row = db.prepare('SELECT * FROM literary_memory_revisions WHERE memory_revision_id = ?').get(revisionId.value) as any;
    if (!row) return { memoryRevisionId: null, fingerprint: null, memory: sanitizeProjectLiteraryMemory({}) };
    const stored = parseJson(row.memory_json, sanitizeProjectLiteraryMemory({}));
    const validated = this.validateLiteraryMemoryAgainstProject(projectId, stored);
    const validatedFingerprint = hash(JSON.stringify(validated));
    if (validatedFingerprint !== row.fingerprint) {
      // 旧版本写入的未核验画像/锚点在首次读取时产生一个兼容的新 revision，不修改任何历史 Run 引用的快照。
      const saved = this.saveLiteraryMemory(projectId, validated);
      const upgraded = db.prepare('SELECT * FROM literary_memory_revisions WHERE memory_revision_id = ?').get(saved.memoryRevisionId) as any;
      return {
        memoryRevisionId: upgraded.memory_revision_id,
        fingerprint: upgraded.fingerprint,
        memory: parseJson(upgraded.memory_json, sanitizeProjectLiteraryMemory({})),
        createdAt: upgraded.created_at,
      };
    }
    return { memoryRevisionId: row.memory_revision_id, fingerprint: row.fingerprint, memory: validated, createdAt: row.created_at };
  }

  listLiteraryMemoryRevisions(projectId: string): any[] {
    return (this.openProjectDb(projectId).prepare('SELECT memory_revision_id, version, fingerprint, created_at FROM literary_memory_revisions ORDER BY created_at DESC LIMIT 100').all() as any[])
      .map((row) => ({ memoryRevisionId: row.memory_revision_id, version: row.version, fingerprint: row.fingerprint, createdAt: row.created_at }));
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

  private makeRunFingerprint(promptRow: any, config: any, literaryMemoryFingerprint: string | null): string {
    return hash(JSON.stringify({
      promptFingerprint: promptRow.fingerprint,
      // 人物声音/关系/锚点变化必须让文学批次变 stale，但不应虚增一个静态 Prompt revision。
      literaryMemoryFingerprint: config.translationMode === 'literary' ? literaryMemoryFingerprint : null,
      sourceLang: config.sourceLang || 'auto',
      targetLang: config.targetLang || 'zh',
      provider: config.provider || 'workbuddy',
      model: config.model || 'auto',
      translationMode: config.translationMode || 'technical',
      literaryReview: Boolean(config.literaryReview),
      pipelineVersion: 'document-agent-v2-voice',
    }));
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
    if (input.prompt?.literaryMemory !== undefined) this.saveLiteraryMemory(projectId, input.prompt.literaryMemory);
    const currentMemory = this.getCurrentLiteraryMemory(projectId);
    const literaryMemoryRevisionId = currentMemory.memoryRevisionId as string | null;
    const config = parseJson<any>(promptRow.config_json, {});
    const scope = input.scope || { type: 'stale' };
    const scopeType = scope.type || 'stale';
    if (!['all', 'stale', 'failed', 'ids', 'chapter'].includes(scopeType)) {
      throw Object.assign(new Error('不支持的运行范围：' + scopeType), { status: 400 });
    }
    const currentSegments = db.prepare('SELECT * FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal').all(sourceRevisionId) as any[];
    const acceptedRows = db.prepare('SELECT * FROM translation_results WHERE accepted = 1 ORDER BY COALESCE(accepted_at, created_at) DESC, created_at DESC, rowid DESC').all() as any[];
    const currentHashById = new Map<string, string>(currentSegments.map((segment) => [segment.segment_id, segment.source_hash]));
    const latestAccepted = new Map<string, any>();
    // Source revision 变更后保留旧译文供追溯，但新旧来源的同 ID 片段不可混用。
    for (const row of acceptedRows) {
      if (row.source_hash === currentHashById.get(row.segment_id) && !latestAccepted.has(row.segment_id)) {
        latestAccepted.set(row.segment_id, row);
      }
    }
    const failedRows = db.prepare("SELECT segment_id FROM run_segments WHERE status = 'failed' ORDER BY updated_at DESC").all() as Array<{ segment_id: string }>;
    const failedIds = new Set(failedRows.map((row) => row.segment_id));
    const idSet = new Set((scope.ids || []).map(String));
    const chapter = (scope.chapter || '').trim();
    const runFingerprint = this.makeRunFingerprint(promptRow, config, currentMemory.fingerprint || null);
    const selected = currentSegments.filter((segment) => {
      if (scopeType === 'all') return true;
      if (scopeType === 'ids') return idSet.has(segment.segment_id);
      if (scopeType === 'chapter') return !!chapter && (segment.context_path === chapter || segment.context_path.startsWith(chapter + ' >'));
      if (scopeType === 'failed') return failedIds.has(segment.segment_id);
      const accepted = latestAccepted.get(segment.segment_id);
      return !accepted || accepted.source_hash !== segment.source_hash || (accepted.origin !== 'manual' && accepted.run_fingerprint !== runFingerprint);
    });
    const runId = randomUUID();
    const createdAt = isoNow();
    db.exec('BEGIN IMMEDIATE');
    try {
      // 一个 workspace 同时只允许一个 queued/running run，防止阅读页与 Agent Tab 并发修改同一组候选。
      const inFlight = db.prepare("SELECT run_id FROM translation_runs WHERE status IN ('queued','running') LIMIT 1").get() as { run_id?: string } | undefined;
      if (inFlight?.run_id) {
        throw Object.assign(new Error('当前文档已有运行中的翻译任务：' + inFlight.run_id), { status: 409 });
      }
      db.prepare('INSERT INTO translation_runs(run_id, source_revision_id, prompt_revision_id, literary_memory_revision_id, status, scope_json, run_fingerprint, provider, model, source_lang, target_lang, translation_mode, review_enabled, parent_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(runId, sourceRevisionId, promptRow.prompt_revision_id, literaryMemoryRevisionId, selected.length ? 'queued' : 'completed', JSON.stringify({ ...scope, type: scopeType }), runFingerprint,
          config.provider || 'workbuddy', config.model || 'auto', config.sourceLang || 'auto', config.targetLang || 'zh',
          config.translationMode || 'technical', config.literaryReview ? 1 : 0, null, createdAt);
      const insert = db.prepare('INSERT INTO run_segments(run_id, segment_id, source_hash, status, attempts, candidate_result_id, error, updated_at) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)');
      for (const segment of selected) insert.run(runId, segment.segment_id, segment.source_hash, 'pending', createdAt);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    this.addEvent(projectId, runId, 'run.planned', { scope: { ...scope, type: scopeType }, promptRevisionId: promptRow.prompt_revision_id, literaryMemoryRevisionId, plannedSegments: selected.length, sourceRevisionId });
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
      sourceFileSaved: Boolean(revision?.source_file_path),
      sourceFileSize: Number.isFinite(revision?.source_file_size) ? Number(revision.source_file_size) : null,
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
      'SELECT s.segment_id, s.ordinal, s.text, s.kind, s.context_path, s.page, s.level, s.marker, s.path, s.start_time, s.end_time, s.source_hash, ' +
      '(SELECT r.translation_text FROM translation_results r WHERE r.segment_id = s.segment_id AND r.source_hash = s.source_hash AND r.accepted = 1 ORDER BY COALESCE(r.accepted_at, r.created_at) DESC, r.created_at DESC, r.rowid DESC LIMIT 1) AS accepted_translation, ' +
      '(SELECT r.translation_text FROM translation_results r WHERE r.segment_id = s.segment_id AND r.run_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS candidate_translation ' +
      'FROM source_segments s WHERE s.source_revision_id = ? ORDER BY s.ordinal LIMIT ? OFFSET ?'
    ).all(options.runId || '', currentSourceRevisionId, limit, offset) as any[];
    return rows.map((row) => ({
      id: row.segment_id, ordinal: row.ordinal, text: row.text, kind: row.kind, contextPath: row.context_path,
      page: row.page, level: row.level, marker: row.marker, path: row.path, start: row.start_time, end: row.end_time, sourceHash: row.source_hash,
      acceptedTranslation: row.accepted_translation ?? null, candidateTranslation: row.candidate_translation ?? null,
    }));
  }

  getRunSegmentsForExecution(projectId: string, runId: string): any[] {
    const { db } = this.getProjectContext(projectId);
    return db.prepare(
      'SELECT rs.segment_id AS id, rs.status, rs.source_hash, rs.attempts, ss.ordinal, ss.text, ss.kind, ss.context_path, ss.page, ss.level, ss.marker, ss.path, ss.start_time AS start, ss.end_time AS end ' +
      'FROM run_segments rs JOIN translation_runs tr ON tr.run_id = rs.run_id ' +
      'JOIN source_segments ss ON ss.source_revision_id = tr.source_revision_id AND ss.segment_id = rs.segment_id ' +
      'WHERE rs.run_id = ? AND rs.status IN (\'pending\', \'failed\') ORDER BY ss.ordinal'
    ).all(runId);
  }

  /**
   * Fetch a few preceding source segments for dialogue/reference resolution.
   * The rows always belong to the same immutable source revision as this run.
   * They are context only: callers must never create run_segments or output ids for them.
   */
  getPrecedingSegments(projectId: string, runId: string, firstSegmentId: string, limit = 4): any[] {
    const { db } = this.getProjectContext(projectId);
    const run = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as { source_revision_id?: string } | undefined;
    if (!run?.source_revision_id) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
    const current = db.prepare(
      'SELECT ordinal, context_path FROM source_segments WHERE source_revision_id = ? AND segment_id = ?'
    ).get(run.source_revision_id, firstSegmentId) as { ordinal?: number; context_path?: string } | undefined;
    if (typeof current?.ordinal !== 'number') return [];
    const bounded = Math.max(0, Math.min(4, Math.floor(limit)));
    if (!bounded) return [];
    const sameChapter = current.context_path
      ? db.prepare(
          'SELECT segment_id, ordinal, text, kind, context_path, page, level, marker FROM source_segments ' +
          'WHERE source_revision_id = ? AND ordinal < ? AND context_path = ? ORDER BY ordinal DESC LIMIT ?'
        ).all(run.source_revision_id, current.ordinal, current.context_path, bounded) as any[]
      : [];
    const rows = sameChapter.length
      ? sameChapter
      : db.prepare(
          'SELECT segment_id, ordinal, text, kind, context_path, page, level, marker FROM source_segments ' +
          'WHERE source_revision_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?'
        ).all(run.source_revision_id, current.ordinal, bounded) as any[];
    return rows.reverse().map((row) => ({
      id: row.segment_id,
      text: String(row.text).slice(0, 900),
      kind: row.kind,
      contextPath: row.context_path,
      page: row.page,
      level: row.level,
      marker: row.marker,
    }));
  }

  getRunContext(projectId: string, runId: string): any {
    const { db, project } = this.getProjectContext(projectId);
    const run = db.prepare('SELECT * FROM translation_runs WHERE run_id = ?').get(runId) as any;
    if (!run) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
    const prompt = db.prepare('SELECT * FROM prompt_revisions WHERE prompt_revision_id = ?').get(run.prompt_revision_id) as any;
    const memoryRow = run.literary_memory_revision_id
      ? db.prepare('SELECT * FROM literary_memory_revisions WHERE memory_revision_id = ?').get(run.literary_memory_revision_id) as any
      : null;
    // 旧版 Run 没有 memory revision 外键；如对应的 Prompt 曾嵌入文学记忆，仍使用那份旧快照，
    // 不能在回看旧 Run 时偷偷套用当前最新版的 Voice Bible。
    const legacyMemory = prompt ? parseJson<any>(prompt.config_json, {}).literaryMemory : null;
    const memory = memoryRow
      ? parseJson(memoryRow.memory_json, sanitizeProjectLiteraryMemory({}))
      : legacyMemory
        ? sanitizeProjectLiteraryMemory(legacyMemory)
        : sanitizeProjectLiteraryMemory({});
    return {
      project,
      memoryRevisionId: memoryRow?.memory_revision_id || null,
      memory,
      run: {
        runId: run.run_id, sourceRevisionId: run.source_revision_id, promptRevisionId: run.prompt_revision_id,
        literaryMemoryRevisionId: run.literary_memory_revision_id || null,
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
      runId: row.run_id, sourceRevisionId: row.source_revision_id, promptRevisionId: row.prompt_revision_id, literaryMemoryRevisionId: row.literary_memory_revision_id || null,
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
    db.prepare('INSERT INTO translation_results(result_id, run_id, source_revision_id, prompt_revision_id, segment_id, source_hash, run_fingerprint, translation_text, origin, accepted, created_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'agent\', 0, ?, NULL)')
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
    const preservedManual: string[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        if (only && !only.has(row.segment_id)) continue;
        // 翻译正在运行时，用户可能在另一 Tab 修订了相同片段；旧候选不得覆盖新人工版本。
        // 用插入顺序（rowid）而不是时间戳判断新旧：时间戳在毫秒上可能打平（跨进程也会），
        // 打平就会把「更晚插入的人工修订」误判成更旧，让旧候选覆盖掉它。
        const candidate = db.prepare('SELECT rowid AS seq, source_hash FROM translation_results WHERE result_id = ?').get(row.candidate_result_id) as { seq?: number; source_hash?: string } | undefined;
        // A manual translation for the same source revision always wins, even if it was saved
        // before the Agent run started. Explicit retranslation must not silently erase user work.
        const sameSourceManual = candidate
          ? db.prepare("SELECT result_id FROM translation_results WHERE segment_id = ? AND accepted = 1 AND origin = 'manual' AND source_hash = ? ORDER BY rowid DESC LIMIT 1")
            .get(row.segment_id, candidate.source_hash)
          : undefined;
        // A newer manual edit also wins when it was made while the model was running.
        const newerManual = candidate
          ? db.prepare("SELECT result_id FROM translation_results WHERE segment_id = ? AND accepted = 1 AND origin = 'manual' AND rowid > ? ORDER BY rowid DESC LIMIT 1")
            .get(row.segment_id, candidate.seq)
          : undefined;
        if (sameSourceManual || newerManual) {
          preservedManual.push(row.segment_id);
          // Resolve this run item without making its discarded candidate the accepted translation.
          db.prepare("UPDATE run_segments SET status = 'accepted', updated_at = ? WHERE run_id = ? AND segment_id = ?")
            .run(now, runId, row.segment_id);
          continue;
        }
        db.prepare('UPDATE translation_results SET accepted = 1, accepted_at = ? WHERE result_id = ?').run(now, row.candidate_result_id);
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
    this.addEvent(projectId, runId, 'translations.accepted', { count: accepted, preservedManualSegmentIds: preservedManual, segmentIds: only ? Array.from(only) : undefined });
    return this.getRun(projectId, runId);
  }

  /**
   * 将旧阅读器/IndexedDB 已有的译文一次性纳入项目版本库。只填充当前来源中尚无
   * accepted 译文的片段，不覆盖本机 workspace 已经版本化的人工修订或 Agent 结果。
   * 当前 Prompt 指纹作为导入基线，避免第一次切换到 workspace 后把整本旧译文全部判过期。
   */
  importAcceptedTranslations(projectId: string, items: unknown): { imported: number; skipped: number } {
    if (!Array.isArray(items) || items.length > 1000) {
      throw Object.assign(new Error('译文导入必须是最多 1000 条记录的数组'), { status: 400 });
    }
    const { db, currentSourceRevisionId } = this.getProjectContext(projectId);
    const currentSegments = new Map(
      (db.prepare('SELECT segment_id, source_hash FROM source_segments WHERE source_revision_id = ?').all(currentSourceRevisionId) as Array<{ segment_id: string; source_hash: string }>)
        .map((row) => [row.segment_id, row]),
    );
    const promptRow = db.prepare('SELECT * FROM prompt_revisions ORDER BY created_at DESC LIMIT 1').get() as any;
    if (!promptRow) throw new Error('导入译文前必须先保存当前 Prompt');
    const config = parseJson<any>(promptRow.config_json, {});
    const currentMemory = this.getCurrentLiteraryMemory(projectId);
    const runFingerprint = this.makeRunFingerprint(promptRow, config, currentMemory.fingerprint || null);
    const now = isoNow();
    let imported = 0;
    let skipped = 0;
    const insert = db.prepare(
      'INSERT INTO translation_results(result_id, run_id, source_revision_id, prompt_revision_id, segment_id, source_hash, run_fingerprint, translation_text, origin, accepted, created_at, accepted_at) ' +
      "VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'imported', 1, ?, ?)",
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const raw of items) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { skipped++; continue; }
        const item = raw as Record<string, unknown>;
        const id = typeof item.id === 'string' ? item.id : '';
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        const source = currentSegments.get(id);
        if (!id || !source || !text || text.length > 20000) { skipped++; continue; }
        const existing = db.prepare(
          'SELECT result_id FROM translation_results WHERE segment_id = ? AND source_hash = ? AND accepted = 1 LIMIT 1',
        ).get(id, source.source_hash);
        if (existing) { skipped++; continue; }
        insert.run(randomUUID(), currentSourceRevisionId, promptRow.prompt_revision_id, id,
          source.source_hash, runFingerprint, text, now, now);
        imported++;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (imported) {
      this.addEvent(projectId, null, 'translations.imported', { imported, skipped, sourceRevisionId: currentSourceRevisionId });
      this.catalogDb().prepare('UPDATE document_projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
    }
    return { imported, skipped };
  }

  saveManualEdit(projectId: string, segmentId: string, text: string): any {
    if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw Object.assign(new Error('译文不能为空或超过 20000 字符'), { status: 400 });
    const { db, currentSourceRevisionId } = this.getProjectContext(projectId);
    const source = db.prepare('SELECT * FROM source_segments WHERE source_revision_id = ? AND segment_id = ?').get(currentSourceRevisionId, segmentId) as any;
    if (!source) throw Object.assign(new Error('找不到源片段：' + segmentId), { status: 404 });
    const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
    const latestPrompt = db.prepare('SELECT prompt_revision_id FROM prompt_revisions ORDER BY created_at DESC LIMIT 1').get() as any;
    const resultId = randomUUID();
    db.prepare('INSERT INTO translation_results(result_id, run_id, source_revision_id, prompt_revision_id, segment_id, source_hash, run_fingerprint, translation_text, origin, accepted, created_at, accepted_at) VALUES (?, NULL, ?, ?, ?, ?, \'manual\', ?, \'manual\', 1, ?, ?)' )
      .run(resultId, currentSourceRevisionId, latestPrompt?.prompt_revision_id || null, segmentId, source.source_hash, text, isoNow(), isoNow());
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
    const anyAcceptedIds = new Set<string>();
    const currentHashById = new Map<string, string>(segments.map((segment) => [segment.segment_id, segment.source_hash]));
    for (const row of db.prepare('SELECT * FROM translation_results WHERE accepted = 1 ORDER BY COALESCE(accepted_at, created_at) DESC, created_at DESC, rowid DESC').all() as any[]) {
      anyAcceptedIds.add(row.segment_id);
      if (row.source_hash === currentHashById.get(row.segment_id) && !latestAccepted.has(row.segment_id)) {
        latestAccepted.set(row.segment_id, row);
      }
    }
    const latestPrompt = db.prepare('SELECT * FROM prompt_revisions ORDER BY created_at DESC LIMIT 1').get() as any;
    const currentMemory = this.getCurrentLiteraryMemory(projectId);
    const currentFingerprint = latestPrompt
      ? this.makeRunFingerprint(latestPrompt, parseJson<any>(latestPrompt.config_json, {}), currentMemory.fingerprint || null)
      : '';
    const missing: string[] = [];
    const stale: string[] = [];
    const stalePrompt: string[] = [];
    for (const segment of segments) {
      const result = latestAccepted.get(segment.segment_id);
      if (!result) {
        if (anyAcceptedIds.has(segment.segment_id)) stale.push(segment.segment_id);
        else missing.push(segment.segment_id);
        continue;
      }
      if (result.origin !== 'manual' && result.run_fingerprint !== currentFingerprint) stalePrompt.push(segment.segment_id);
    }
    const activeRuns = db.prepare("SELECT run_id, status FROM translation_runs WHERE status IN ('queued','running','paused','awaiting_acceptance','partial') ORDER BY created_at DESC").all();
    return {
      project,
      totalSegments: segments.length,
      acceptedSegments: segments.length - missing.length - stale.length - stalePrompt.length,
      missingSegmentIds: missing,
      staleSourceIds: stale,
      stalePromptIds: stalePrompt,
      activeRuns,
    };
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
